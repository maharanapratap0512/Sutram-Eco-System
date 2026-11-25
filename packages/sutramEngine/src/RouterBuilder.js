// src/RouterBuilder.js
// ─────────────────────────────────────────────────────────────
// Builds and returns an Express router for sutramEngine.
//
// Mount in your app:
//   app.use('/api', engine.router());
//
// Routes generated:
//
//   ── Engine config (_sutram prefix) ──────────────────────────
//   GET  /_sutram/menu               → sidebar menu + reports
//   GET  /_sutram/schema/:table      → form + table builder config
//   POST /_sutram/reports/:name/run  → execute named CTE report
//
//   ── CRUD (one route per table in schema) ─────────────────────
//   GET    /:table          → getAll (query params + pagination)
//   GET    /:table/:id      → getById
//   POST   /:table          → insert (trigger-aware)
//   PUT    /:table/:id      → updateById (trigger-aware)
//   DELETE /:table/:id      → deleteById (trigger-aware)
//   POST   /:table/query    → getAll with raw WHERE body
// ─────────────────────────────────────────────────────────────

'use strict';

// Reserved _sutram prefix routes — must be registered BEFORE /:table
const RESERVED = ['_sutram'];

function buildRouter(engine) {
    let router;
    try {
        const express = require('express');
        router = express.Router();
    } catch {
        throw new Error(
            '[sutramEngine] engine.router() requires express to be installed.\n' +
            'Run: npm install express'
        );
    }

    // ─────────────────────────────────────────────────────────
    // ── HELPER — send JSON response ──────────────────────────
    // ─────────────────────────────────────────────────────────

    function ok(res, data, meta = {}) {
        res.json({ success: true, ...meta, result: data });
    }

    function fail(res, err, status = 400) {
        const message = err?.message ?? String(err);
        console.error('[sutramEngine:router]', message);
        res.status(status).json({ success: false, error: message });
    }

    // ─────────────────────────────────────────────────────────
    // ── HELPER — parse query params to where + options ────────
    // ─────────────────────────────────────────────────────────
    // Reserved params start with _ : _limit, _page, _order, _full
    // Everything else → where object

    function parseQuery(query, tbl = null) {
        const where = {};
        let limit = null;
        let offset = null;
        let orderBy = null;
        let full = true;

        const PAGE_DEFAULT = 50;

        for (const [key, val] of Object.entries(query)) {
            if (key === '_limit') { limit = parseInt(val) || PAGE_DEFAULT; continue; }
            if (key === '_page') {
                const page = parseInt(val) || 1;
                limit = limit ?? PAGE_DEFAULT;
                offset = (page - 1) * limit;
                continue;
            }
            if (key === '_order') { orderBy = val; continue; }
            if (key === '_full') { full = val !== 'false' && val !== '0'; continue; }
            // Server-level project selector query param — ignore unless table defines a 'project' column
            if (key === 'project' && !tbl?.columns?.project) continue;
            // Ignore cache-buster / unknown underscore params unless table defines them
            if (key.startsWith('_') && !tbl?.columns?.[key]) continue;
            // everything else is a where condition
            // try to coerce numbers
            where[key] = isNaN(val) || val === '' ? val : Number(val);
        }

        // recalculate offset if _page came before _limit
        if (offset !== null && limit !== null) {
            const page = Math.floor(offset / PAGE_DEFAULT) + 1;
            offset = (page - 1) * limit;
        }

        return { where, limit, offset, orderBy, full };
    }

    // ─────────────────────────────────────────────────────────
    // ── HELPER — check table is in schema ────────────────────
    // ─────────────────────────────────────────────────────────

    // returns table instance or calls next() to pass to next middleware
    // this way unknown table names don't block other mounted routes
    function getTable(tableName, res, next) {
        try {
            return engine.table(tableName);
        } catch (e) {
            next();   // table not in schema — let next middleware handle it
            return null;
        }
    }

    // ═════════════════════════════════════════════════════════
    // ── _SUTRAM ROUTES — engine config ────────────────────────
    // ═════════════════════════════════════════════════════════

    // Auth / RBAC helper (enforced cleanly whenever req.projectUser is attached by server middleware)
    function checkAccess(req, tableName, action = 'view') {
        const user = req.projectUser;
        if (!user || !engine.auth) return { allowed: true, ownFilter: null };
        const rights = req.projectRights || [];
        const eff = engine.auth.getEffectiveRights(user, tableName, rights);
        const permMap = { view: eff.can_view, edit: eff.can_edit, delete: eff.can_delete };
        if (!permMap[action]) {
            return { allowed: false, eff };
        }
        const ownFilter = engine.auth.getOwnershipFilter(user, tableName, rights);
        return { allowed: true, eff, ownFilter };
    }

    function stripProtectedPlaceholders(tableName, body = {}, user = null) {
        if (!body || typeof body !== 'object') return body;
        const copy = { ...body };
        const cols = engine?._schema?.[tableName]?.columns || {};
        for (const [colName, colDef] of Object.entries(cols)) {
            const AuthManager = require('./AuthManager');
            if (AuthManager.isSensitiveColumn(colName, colDef) && copy[colName] === '••••••••') {
                delete copy[colName];
            }
        }
        if (user && user.role !== 'admin') {
            delete copy.user_id;
        }
        return copy;
    }

    // GET /_sutram/menu — sidebar menu + reports list
    router.get('/_sutram/menu', async (req, res) => {
        try {
            const menu = await engine.ui.getMenu();
            if (req.projectUser && engine.auth && Array.isArray(menu?.tables)) {
                menu.tables = menu.tables.filter(t =>
                    engine.auth.getEffectiveRights(req.projectUser, t.table_name, req.projectRights || []).can_view
                );
            }
            ok(res, menu);
        } catch (e) {
            fail(res, e, 500);
        }
    });

    // GET /_sutram/schema/:table — full column config for frontend
    router.get('/_sutram/schema/:table', async (req, res) => {
        try {
            const acc = checkAccess(req, req.params.table, 'view');
            if (!acc.allowed) return fail(res, `Access Denied to "${req.params.table}"`, 403);
            const schema = await engine.ui.getTableSchema(req.params.table);
            ok(res, schema);
        } catch (e) {
            fail(res, e, 404);
        }
    });

    // POST /_sutram/reports/:name/run — execute named CTE report / procedure
    router.post('/_sutram/reports/:name/run', async (req, res) => {
        try {
            const rows = await engine.report.run(req.params.name, req.body ?? {});
            ok(res, rows, { report: req.params.name, count: rows.length });
        } catch (e) {
            fail(res, e, 400);
        }
    });

    // ═════════════════════════════════════════════════════════
    // ── CRUD ROUTES ───────────────────────────────────────────
    // ═════════════════════════════════════════════════════════

    // GET /:table — getAll with query params
    router.get('/:table', async (req, res, next) => {
        if (RESERVED.includes(req.params.table)) return next();
        const tbl = getTable(req.params.table, res, next);
        if (!tbl) return;

        try {
            const acc = checkAccess(req, req.params.table, 'view');
            if (!acc.allowed) return fail(res, `Access Denied: cannot view "${req.params.table}"`, 403);

            const { where, limit, offset, orderBy, full } = parseQuery(req.query, tbl);
            const scopedWhere = acc.ownFilter ? engine.auth.applyOwnershipWhere(where, acc.ownFilter) : where;
            const opts = { full };
            if (orderBy) opts.orderBy = orderBy;
            if (limit) opts.limit = limit;
            if (offset) opts.offset = offset;

            const rawResult = await tbl.getAll(scopedWhere, opts);
            const result = engine.auth
                ? engine.auth.maskRows(req.params.table, rawResult, req.unmaskedCols || new Set())
                : rawResult;
            const total = (typeof scopedWhere === 'object' && Object.keys(scopedWhere).length)
                ? await tbl.count(scopedWhere)
                : await tbl.count();

            ok(res, result, { total, count: result.length });
        } catch (e) {
            fail(res, e);
        }
    });

    // GET /:table/:id — getById
    router.get('/:table/:id', async (req, res, next) => {
        const tbl = getTable(req.params.table, res, next);
        if (!tbl) return;

        try {
            const acc = checkAccess(req, req.params.table, 'view');
            if (!acc.allowed) return fail(res, `Access Denied: cannot view "${req.params.table}"`, 403);

            const row = await tbl.getById(Number(req.params.id));
            if (!row) return fail(res, `Record ${req.params.id} not found`, 404);
            if (acc.ownFilter && Number(row[acc.ownFilter.column]) !== acc.ownFilter.value) {
                return fail(res, `Access Denied: you can only access your own records`, 403);
            }
            const safeRow = engine.auth
                ? engine.auth.maskRow(req.params.table, row, req.unmaskedCols || new Set())
                : row;
            ok(res, safeRow);
        } catch (e) {
            fail(res, e);
        }
    });

    // POST /:table — insert (trigger-aware)
    router.post('/:table', async (req, res, next) => {
        if (RESERVED.includes(req.params.table)) return next();
        try {
            const acc = checkAccess(req, req.params.table, 'edit');
            if (!acc.allowed) return fail(res, `Access Denied: cannot insert into "${req.params.table}"`, 403);

            let payload = stripProtectedPlaceholders(req.params.table, req.body, req.projectUser);
            if (req.projectUser && engine.auth) {
                payload = engine.auth.injectOwnerForWrite(req.params.table, payload, req.projectUser);
            }
            const row = await engine.insert(req.params.table, payload);
            const safeRow = engine.auth ? engine.auth.maskRow(req.params.table, row, req.unmaskedCols || new Set()) : row;
            ok(res, safeRow);
        } catch (e) {
            fail(res, e);
        }
    });

    // POST /:table/query — getAll with raw WHERE body
    router.post('/:table/query', async (req, res, next) => {
        const tbl = getTable(req.params.table, res, next);
        if (!tbl) return;

        try {
            const acc = checkAccess(req, req.params.table, 'view');
            if (!acc.allowed) return fail(res, `Access Denied: cannot query "${req.params.table}"`, 403);

            const { where = {}, limit = null, page = 1, orderBy = null, full = true } = req.body ?? {};
            const scopedWhere = acc.ownFilter ? engine.auth.applyOwnershipWhere(where, acc.ownFilter) : where;
            const offset = limit ? (page - 1) * limit : null;
            const opts = { full };
            if (orderBy) opts.orderBy = orderBy;
            if (limit) opts.limit = limit;
            if (offset) opts.offset = offset;

            const rawResult = await tbl.getAll(scopedWhere, opts);
            const result = engine.auth
                ? engine.auth.maskRows(req.params.table, rawResult, req.unmaskedCols || new Set())
                : rawResult;
            const total = await tbl.count(scopedWhere);
            ok(res, result, { total, count: result.length });
        } catch (e) {
            fail(res, e);
        }
    });

    // PUT /:table/:id — updateById (trigger-aware)
    router.put('/:table/:id', async (req, res) => {
        try {
            const acc = checkAccess(req, req.params.table, 'edit');
            if (!acc.allowed) return fail(res, `Access Denied: cannot edit "${req.params.table}"`, 403);

            const targetId = Number(req.params.id);
            if (acc.ownFilter) {
                const existing = await engine.getById(req.params.table, targetId);
                if (!existing) return fail(res, `Record ${targetId} not found`, 404);
                if (Number(existing[acc.ownFilter.column]) !== acc.ownFilter.value) {
                    return fail(res, `Access Denied: you can only modify your own records`, 403);
                }
            }

            const payload = stripProtectedPlaceholders(req.params.table, req.body, req.projectUser);
            const row = await engine.updateById(req.params.table, payload, targetId);
            const safeRow = engine.auth ? engine.auth.maskRow(req.params.table, row, req.unmaskedCols || new Set()) : row;
            ok(res, safeRow);
        } catch (e) {
            fail(res, e);
        }
    });

    // DELETE /:table/:id — deleteById (trigger-aware)
    router.delete('/:table/:id', async (req, res) => {
        try {
            const acc = checkAccess(req, req.params.table, 'delete');
            if (!acc.allowed) return fail(res, `Access Denied: cannot delete from "${req.params.table}"`, 403);

            const targetId = Number(req.params.id);
            if (acc.ownFilter) {
                const existing = await engine.getById(req.params.table, targetId);
                if (!existing) return fail(res, `Record ${targetId} not found`, 404);
                if (Number(existing[acc.ownFilter.column]) !== acc.ownFilter.value) {
                    return fail(res, `Access Denied: you can only delete your own records`, 403);
                }
            }

            const changes = await engine.deleteById(req.params.table, targetId);
            ok(res, { deleted: changes });
        } catch (e) {
            fail(res, e);
        }
    });

    return router;
}

module.exports = buildRouter;
