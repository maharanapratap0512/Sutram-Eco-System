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

    // GET /_sutram/menu — sidebar menu + reports list
    router.get('/_sutram/menu', async (req, res) => {
        try {
            const menu = await engine.ui.getMenu();
            ok(res, menu);
        } catch (e) {
            fail(res, e, 500);
        }
    });

    // GET /_sutram/schema/:table — full column config for frontend
    router.get('/_sutram/schema/:table', async (req, res) => {
        try {
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
            const { where, limit, offset, orderBy, full } = parseQuery(req.query, tbl);
            const opts = { full };
            if (orderBy) opts.orderBy = orderBy;
            if (limit) opts.limit = limit;
            if (offset) opts.offset = offset;

            const result = await tbl.getAll(where, opts);
            const total = Object.keys(where).length
                ? await tbl.count(where)
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
            const row = await tbl.getById(Number(req.params.id));
            if (!row) return fail(res, `Record ${req.params.id} not found`, 404);
            ok(res, row);
        } catch (e) {
            fail(res, e);
        }
    });

    // POST /:table — insert (trigger-aware)
    router.post('/:table', async (req, res, next) => {
        if (RESERVED.includes(req.params.table)) return next();
        try {
            const row = await engine.insert(req.params.table, req.body);
            ok(res, row);
        } catch (e) {
            fail(res, e);
        }
    });

    // POST /:table/query — getAll with raw WHERE body
    router.post('/:table/query', async (req, res, next) => {
        const tbl = getTable(req.params.table, res, next);
        if (!tbl) return;

        try {
            const { where = {}, limit = null, page = 1, orderBy = null, full = true } = req.body ?? {};
            const offset = limit ? (page - 1) * limit : null;
            const opts = { full };
            if (orderBy) opts.orderBy = orderBy;
            if (limit) opts.limit = limit;
            if (offset) opts.offset = offset;

            const result = await tbl.getAll(where, opts);
            const total = await tbl.count(where);
            ok(res, result, { total, count: result.length });
        } catch (e) {
            fail(res, e);
        }
    });

    // PUT /:table/:id — updateById (trigger-aware)
    router.put('/:table/:id', async (req, res) => {
        try {
            const row = await engine.updateById(req.params.table, req.body, Number(req.params.id));
            ok(res, row);
        } catch (e) {
            fail(res, e);
        }
    });

    // DELETE /:table/:id — deleteById (trigger-aware)
    router.delete('/:table/:id', async (req, res) => {
        try {
            const changes = await engine.deleteById(req.params.table, Number(req.params.id));
            ok(res, { deleted: changes });
        } catch (e) {
            fail(res, e);
        }
    });

    return router;
}

module.exports = buildRouter;
