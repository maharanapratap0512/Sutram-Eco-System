// src/Engine.js
// ─────────────────────────────────────────────────────────────
// SutramEngine — main class
//
// THREE INITIALIZATION PATTERNS:
//
//  Pattern 1 — pass existing sutramCore Sutram instance
//    new SutramEngine({ sutram: sewa, triggers, reports })
//    → reuses sewa.db + sewa's cache
//    → sewa.table() and engine.table() share same instances
//    → transactions across both are fully atomic
//    → mode: 'direct' (schema from sutram, sys_ skipped)
//
//  Pattern 2 — direct schema (no sys_ involvement)
//    new SutramEngine({ db | dbPath, schema, triggers, reports })
//    → engine creates its own Sutram instance
//    → sys_ tables not used for schema
//    → user manages SQLite tables + migrations
//    → mode: 'direct'
//
//  Pattern 3 — managed (schema lives in sys_ tables)
//    new SutramEngine({ db | dbPath })
//    → engine reads schema from sys_table, sys_column, sys_join
//    → use importAll() to populate sys_ from schema.js files
//    → sutramUI + sutramServer compatible
//    → mode: 'managed'
//
// db vs dbPath:
//   db     — caller passes ready better-sqlite3 instance
//            caller manages lifecycle (open/close)
//   dbPath — engine opens the file, sets WAL + pragmas
//            engine manages lifecycle
// ─────────────────────────────────────────────────────────────

'use strict';

const SysMigrator = require('./SysMigrator');
const BootstrapBuilder = require('./BootstrapBuilder');
const SchemaManager = require('./SchemaManager');
const TriggerManager = require('./TriggerManager');
const ReportManager = require('./ReportManager');
const UiManager = require('./UiManager');
const ReminderManager = require('./ReminderManager');
const AuthManager = require('./AuthManager');
const buildRouter = require('./RouterBuilder');

class Engine {

    // ─────────────────────────────────────────────────────────
    // CONSTRUCTOR
    // ─────────────────────────────────────────────────────────

    constructor({
        // Pattern 1 / Managed Core — pass any Core instance (Sutram, MySQLSutram, or future DB Core)
        sutram = null,
        core = null,

        // Convenience SQLite options (Engine delegates opening to sutramcore)
        db = null,
        dbPath = null,

        // Direct mode options
        schema = null,
        triggers = null,
        reports = null,

        // Optional explicit mode override ('managed' | 'direct')
        mode = null,
    } = {}) {

        const givenCore = core || sutram;

        if (givenCore) {
            if (typeof givenCore.table !== 'function' || (typeof givenCore.query !== 'function' && typeof givenCore.db?.prepare !== 'function')) {
                throw new Error(
                    '[sutramEngine] core/sutram must be a valid sutramcore or sutramcore-mysql instance'
                );
            }
            this.core = givenCore;
            this._sutram = givenCore;
            this.db = givenCore.db ?? null;
            this._ownsSutram = false;
        } else if (db || dbPath) {
            const { Sutram } = require('sutramcore');
            this.core = new Sutram({ db, dbPath, schema: schema || {} });
            this._sutram = this.core;
            this.db = this.core.db;
            this._ownsSutram = true;
        } else {
            throw new Error(
                '[sutramEngine] One of these is required:\n' +
                '  core / sutram — sutramcore Sutram OR sutramcore-mysql MySQLSutram instance\n' +
                '  db            — better-sqlite3 Database instance\n' +
                '  dbPath        — path to SQLite file'
            );
        }

        // ── detect mode ───────────────────────────────────────
        // managed → schema lives in sys_ tables (default when schema is empty / omitted)
        // direct  → schema provided directly by caller
        if (mode === 'direct' || mode === 'managed') {
            this._mode = mode;
        } else if (schema || (givenCore && Object.keys(givenCore.schema || {}).length > 0)) {
            this._mode = 'direct';
        } else {
            this._mode = 'managed';
        }

        // ── store direct-mode config ──────────────────────────
        this._directSchema = schema;
        this._directTriggers = triggers ?? [];
        this._directReports = reports ?? [];

        // ── internal state ────────────────────────────────────
        this._schema = {};
        this._tableCache = {};

        // ── sub-managers (all operate uniformly through Engine / Core) ─
        this.trigger = new TriggerManager(this);
        this.triggers = this.trigger;
        this.report = new ReportManager(this);
        this.reports = this.report;
        this.schema = new SchemaManager(this.db, () => this.rebootstrap(), this);
        this.ui = new UiManager(this);
        this.reminder = new ReminderManager(this);
        this.reminders = this.reminder;
        this.auth = new AuthManager(this);
    }

    // Polymorphic Core metadata getters (zero dialect branching)
    get dialect() { return this.core?.dialect || 'sqlite'; }
    get _dialect() { return this.dialect; }
    get _adapter() { return this.core?.adapter || null; }
    get dbName() { return this.core?.dbName || 'active'; }
    get inTransaction() { return Boolean(this.core?.inTransaction); }

    // ─────────────────────────────────────────────────────────
    // INIT — Uniform Async Lifecycle (SQLite, MySQL, or any DB)
    // Always call: await new SutramEngine(...).init()
    // ─────────────────────────────────────────────────────────

    async init() {
        if (typeof this.core.connect === 'function' && !this._ownsSutram) {
            if (this.core.dialect === 'mysql' && !this.core.adapter?.pool) {
                await this.core.connect();
            }
        }

        const migrator = new SysMigrator(this.core);
        await migrator.run();

        await this.rebootstrap();
        console.log(`[sutramEngine] Ready — dialect: ${this.dialect}, mode: ${this._mode}`);
        return this;
    }

    // ─────────────────────────────────────────────────────────
    // REBOOTSTRAP — Uniform Async Schema & Manager Sync
    // ─────────────────────────────────────────────────────────

    async rebootstrap() {
        if (this._mode === 'direct') {
            await this._rebootstrapDirect();
        } else {
            await this._rebootstrapManaged();
        }

        const count = Object.keys(this._schema || {}).length;
        console.log(`[sutramEngine] Bootstrapped — ${count} table(s), dialect: ${this.dialect}, mode: ${this._mode}`);
    }

    async _rebootstrapDirect() {
        if (this._ownsSutram) {
            if (!this._directSchema) {
                throw new Error(
                    '[sutramEngine] Direct mode requires schema.\n' +
                    'Pass schema to constructor or use managed mode.'
                );
            }
            this._schema = this._directSchema;
            this.core.setSchema(this._schema);

            await this.trigger.loadFromArray(this._directTriggers);
            await this.report.loadFromArray(this._directReports);
        } else {
            this._schema = this.core.schema;
            this.trigger.loadFromArray(this._directTriggers);
            if (this.core.report && typeof this.core.report.loadFromArray === 'function') {
                if (this._directReports?.length) this.core.report.loadFromArray(this._directReports);
            } else {
                this.report.loadFromArray(this._directReports);
            }
        }

        this._tableCache = {};
    }

    async _rebootstrapManaged() {
        const builder = new BootstrapBuilder(this.core);
        this._schema = await builder.build();
        this.core.setSchema(this._schema);
        this._sutram = this.core;
        this._tableCache = {};

        await this.trigger.load();
        await this.report.load();
        await this.reminder.load();
        if (this.core.report && typeof this.core.report.load === 'function') {
            try { await this.core.report.load(); } catch {}
        }
    }

    // Backward-compatible alias
    async _rebootstrapManagedAsync() {
        return await this._rebootstrapManaged();
    }

    // ─────────────────────────────────────────────────────────
    // TABLE — get a cached BaseTable instance
    //
    // Pattern 1: returns same instance as sewa.table(name)
    //            because this._sutram === sewa
    // Pattern 2/3: returns engine's own cached instance
    // ─────────────────────────────────────────────────────────

    table(tableName) {
        if (!this._sutram) {
            throw new Error('[sutramEngine] Call engine.init() before engine.table()');
        }
        // delegate to sutram instance — it handles its own cache
        return this._sutram.table(tableName);
    }

    // ─────────────────────────────────────────────────────────
    // TRIGGER-AWARE CRUD (Uniform Async Footprint + Rule 13 Tx)
    // ─────────────────────────────────────────────────────────

    async insert(tableName, data, full = true) {
        const tbl = this.table(tableName);
        const pk = tbl.pkName || '_id';
        const needTx = !this.core.inTransaction;
        let id;
        try {
            if (needTx) await this.core.begin();
            id = await tbl.insert(data, false);
            const newRow = await tbl.getOne({ [pk]: id }, { full: false });
            await this.trigger.execute(tableName, 'INSERT', newRow, null);
            if (needTx) await this.core.commit();
        } catch (err) {
            if (needTx && this.core.inTransaction) await this.core.rollback();
            throw err;
        }
        return full ? await tbl.getById(id) : id;
    }

    async update(tableName, data, where, full = true) {
        const tbl = this.table(tableName);
        const pk = tbl.pkName || '_id';
        const id = typeof where === 'object' ? (where[pk] ?? where._id ?? where.id ?? null) : null;
        const oldRow = id ? await tbl.getOne({ [pk]: id }, { full: false }) : null;

        const needTx = !this.core.inTransaction;
        let result;
        try {
            if (needTx) await this.core.begin();
            result = await tbl.update(data, where, false);
            const resolvedId = id ?? result;
            const newRow = resolvedId ? await tbl.getOne({ [pk]: resolvedId }, { full: false }) : null;
            await this.trigger.execute(tableName, 'UPDATE', newRow, oldRow);
            if (needTx) await this.core.commit();
        } catch (err) {
            if (needTx && this.core.inTransaction) await this.core.rollback();
            throw err;
        }

        return full && (result ?? id) ? await tbl.getById(result ?? id) : (result ?? id);
    }

    async updateById(tableName, data, id, full = true) {
        const tbl = this.table(tableName);
        const pk = tbl.pkName || '_id';
        return await this.update(tableName, data, { [pk]: id }, full);
    }

    async delete(tableName, where) {
        const tbl = this.table(tableName);
        const oldRows = await tbl.getAll(where, { full: false });

        // STRICT DML FOREIGN KEY INTEGRITY CHECK
        if (oldRows.length > 0 && this.schema && typeof this.schema.getReferencingConstraints === 'function') {
            const refs = await this.schema.getReferencingConstraints(tableName);
            for (const ref of refs) {
                const targetCol = ref.ref_col || tbl.pkName || '_id';
                const targetVals = [...new Set(
                    oldRows.map(r => r[targetCol]).filter(v => v !== null && v !== undefined)
                )];
                if (targetVals.length === 0) continue;

                const placeholders = targetVals.map(() => '?').join(', ');
                try {
                    const hit = await this.core.queryOne(
                        `SELECT COUNT(*) as c FROM ${this.core.quoteId(ref.table_name)} WHERE ${this.core.quoteId(ref.column_name)} IN (${placeholders})`,
                        targetVals
                    );
                    if (hit && hit.c > 0) {
                        const err = new Error(
                            `Cannot delete record from "${tableName}": ${hit.c} linked record(s) exist in "${ref.table_name}" (column: ${ref.column_name}). Delete or update those record(s) in "${ref.table_name}" first.`
                        );
                        err.statusCode = 409;
                        throw err;
                    }
                } catch (checkErr) {
                    if (checkErr.statusCode === 409) throw checkErr;
                }
            }
        }

        const needTx = !this.core.inTransaction;
        try {
            if (needTx) await this.core.begin();
            const count = await tbl.delete(where);
            for (const oldRow of oldRows) {
                await this.trigger.execute(tableName, 'DELETE', null, oldRow);
            }
            if (needTx) await this.core.commit();
            return count;
        } catch (err) {
            if (needTx && this.core.inTransaction) await this.core.rollback();
            if (err && /FOREIGN KEY constraint failed|a foreign key constraint fails/i.test(err.message || '')) {
                const fkErr = new Error(
                    `Cannot delete record from "${tableName}": it is still referenced by another table. Delete the referencing record(s) first.`
                );
                fkErr.statusCode = 409;
                throw fkErr;
            }
            throw err;
        }
    }

    async deleteById(tableName, id) {
        const tbl = this.table(tableName);
        const pk = tbl.pkName || '_id';
        return await this.delete(tableName, { [pk]: id });
    }

    // ─────────────────────────────────────────────────────────
    // PROCEDURE — public API
    // ─────────────────────────────────────────────────────────

    procedure(name) {
        return this.report.procedure(name);
    }

    // ─────────────────────────────────────────────────────────
    // PASS-THROUGH QUERIES — Uniform Async Footprint
    // ─────────────────────────────────────────────────────────

    async getById(tableName, id) { return await this.table(tableName).getById(id); }
    async getOne(tableName, where, opts) { return await this.table(tableName).getOne(where, opts); }
    async getAll(tableName, where, opts) { return await this.table(tableName).getAll(where, opts); }
    async count(tableName, where) { return await this.table(tableName).count(where); }

    async max(tableName, column) {
        const qTbl = this.core.quoteId(tableName);
        const qCol = this.core.quoteId(column);
        const row = await this.core.queryOne(`SELECT MAX(${qCol}) as last FROM ${qTbl}`);
        return row?.last ?? 0;
    }

    /**
     * Multi-column search with filtering, sorting, and pagination.
     * Parameterized SQL delegated purely to Core.
     */
    async search(tableName, query = '', { where = {}, limit = 100, offset = 0, full = true, orderBy = null } = {}) {
        const tbl = this.table(tableName);
        const q = String(query || '').trim();
        const conditions = [];
        const params = [];
        const qTbl = this.core.quoteId(tableName);

        // 1. Process WHERE filter object or string
        if (typeof where === 'string' && where.trim()) {
            conditions.push(`(${where.trim()})`);
        } else if (where && typeof where === 'object' && Object.keys(where).length > 0) {
            for (const [col, val] of Object.entries(where)) {
                if (!tbl.columns || !tbl.columns[col]) continue;
                const colExpr = `${qTbl}.${this.core.quoteId(col)}`;
                if (Array.isArray(val) && val.length > 0) {
                    const hasBlank = val.includes('__BLANK__') || val.includes('');
                    const nonBlanks = val.filter(v => v !== '__BLANK__' && v !== '');
                    const conds = [];
                    if (nonBlanks.length > 0) {
                        conds.push(`${colExpr} IN (${nonBlanks.map(() => '?').join(', ')})`);
                        params.push(...nonBlanks);
                    }
                    if (hasBlank) {
                        conds.push(`(${colExpr} IS NULL OR ${colExpr} = '')`);
                    }
                    if (conds.length > 0) {
                        conditions.push(`(${conds.join(' OR ')})`);
                    }
                } else if (val !== undefined && val !== null && val !== '') {
                    if (val === '__BLANK__') {
                        conditions.push(`(${colExpr} IS NULL OR ${colExpr} = '')`);
                    } else {
                        conditions.push(`${colExpr} = ?`);
                        params.push(val);
                    }
                }
            }
        }

        // 2. Multi-column text search matching text/name/code columns
        if (q) {
            const searchCols = Object.entries(tbl.columns || {})
                .filter(([col, def]) => {
                    const t = (def?.type || 'string').toLowerCase();
                    return ['string', 'text', 'varchar'].includes(t) ||
                        col.endsWith('_hin') || col.endsWith('_eng') ||
                        col.includes('code') || col.includes('name');
                })
                .map(([col]) => col);

            if (searchCols.length > 0) {
                const sConds = searchCols.map(c => {
                    params.push(`%${q}%`);
                    return `${qTbl}.${this.core.quoteId(c)} LIKE ?`;
                });
                conditions.push(`(${sConds.join(' OR ')})`);
            }
        }

        const combinedWhere = conditions.length > 0
            ? { __sql: conditions.join(' AND '), __params: params }
            : {};

        let safeOrderBy = orderBy;
        if (safeOrderBy && tbl.columns) {
            const match = String(safeOrderBy).match(/[`"']?([a-zA-Z0-9_]+)[`"']?\s*(ASC|DESC)?/i);
            if (match) {
                const colName = match[1];
                const dir = (match[2] || 'ASC').toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
                if (tbl.columns[colName]) {
                    safeOrderBy = `${this.core.quoteId(colName)} ${dir}`;
                } else if (tbl.columns[`${colName}_id`]) {
                    safeOrderBy = `${this.core.quoteId(`${colName}_id`)} ${dir}`;
                } else {
                    safeOrderBy = null;
                }
            }
        }

        const rows = await tbl.getAll(combinedWhere, { full, orderBy: safeOrderBy, limit, offset });
        const total = await tbl.count(combinedWhere);

        return { rows, total, limit, offset };
    }

    async distinct(tableName, column, { where = {}, limit = null, orderBy = null } = {}) {
        const tbl = this.table(tableName);
        return await tbl.distinct(column, where, { limit, orderBy });
    }

    // ─────────────────────────────────────────────────────────
    // IMPORT / EXPORT
    // ─────────────────────────────────────────────────────────

    async importAll(opts = {}) {
        const { ui, ...rest } = opts;
        this._assertManagedForImport('importAll');
        await this.schema.importAll(rest);
        if (ui) await this.ui.importUi(ui);
    }

    async importSchema(meta) {
        this._assertManagedForImport('importSchema');
        return await this.schema.importSchema(meta);
    }

    async importTriggers(list) {
        this._assertManagedForImport('importTriggers');
        return await this.schema.importTriggers(list);
    }

    async importReports(list) {
        this._assertManagedForImport('importReports');
        return await this.schema.importReports(list);
    }

    async exportAll() { return await this.schema.exportAll(); }
    async exportSchema() { return await this.schema.exportSchema(); }
    async exportTriggers() { return await this.schema.exportTriggers(); }
    async exportReports() { return await this.schema.exportReports(); }

    // ─────────────────────────────────────────────────────────
    // TRANSACTIONS — delegated purely to Core
    // ─────────────────────────────────────────────────────────

    async transaction(fn) {
        return await this.core.transaction(fn);
    }
    async begin() {
        return await this.core.begin();
    }
    async commit() {
        return await this.core.commit();
    }
    async rollback() {
        return await this.core.rollback();
    }

    // ─────────────────────────────────────────────────────────
    // MODULE MIGRATIONS, META STORAGE & INTROSPECTION VIA ENGINE
    // (Allows modules like sutramExcel to migrate & store metadata
    //  with zero direct SQLite / MySQL / sutramcore access)
    // ─────────────────────────────────────────────────────────

    async getMeta(key, defaultValue = null) {
        try {
            const row = await this.core.queryOne(
                `SELECT ${this.core.quoteId('value')} as val FROM sys_meta WHERE ${this.core.quoteId('key')} = ?`,
                [key]
            );
            return row ? row.val : defaultValue;
        } catch {
            return defaultValue;
        }
    }

    async setMeta(key, value) {
        await this.core.upsert('sys_meta', ['key'], {
            key: String(key),
            value: typeof value === 'string' ? value : JSON.stringify(value)
        });
        return true;
    }

    /**
     * Declarative migration runner for ecosystem modules (e.g. sutramExcel).
     * Modules declare versioned schema steps; Engine handles version tracking & Core DDL.
     */
    async migrateSystemModule(metaKey, versions = []) {
        if (!metaKey || !Array.isArray(versions) || versions.length === 0) return;

        const currentVersion = parseInt(String(await this.getMeta(metaKey, '0')), 10) || 0;
        const targetVersion = versions.length;
        if (currentVersion >= targetVersion) return;

        for (let v = currentVersion; v < targetVersion; v++) {
            const steps = Array.isArray(versions[v]) ? versions[v] : [versions[v]];
            for (const step of steps) {
                if (step.action === 'ensureTable' && step.table) {
                    await this.schema.ensureSystemTable(step.table);
                } else if (step.action === 'upsert' && step.table_name && step.data) {
                    await this.core.upsert(step.table_name, step.conflictCols || [], step.data);
                } else if (step.action === 'addColumn' && step.table_name && step.column) {
                    try { await this.core.addColumn(step.table_name, step.column); } catch {}
                } else if (typeof step === 'string') {
                    await this.core.run(step);
                }
            }
            await this.setMeta(metaKey, String(v + 1));
            console.log(`[sutramEngine] ✓ Module "${metaKey}" migration v${v + 1} applied`);
        }

        await this.rebootstrap();
    }

    async purgeSutram() {
        return await this.core.purgeSutram();
    }

    async introspect() {
        return await this.core.introspect();
    }

    async getViews() {
        return await this.core.listViews();
    }

    async inspectTable(tableName) {
        return await this.core.inspectTable(tableName);
    }

    async listPhysicalTables() {
        return await this.core.listPhysicalTables();
    }

    async importUi(uiConfig) {
        return await this.ui.importUi(uiConfig);
    }

    router() {
        return buildRouter(this);
    }

    // ─────────────────────────────────────────────────────────
    // RAW QUERY COMPATIBILITY — Always routed through Engine → Core
    // ─────────────────────────────────────────────────────────

    async query(sql, params = []) {
        return await this.core.query(sql, params);
    }

    async queryOne(sql, params = []) {
        return await this.core.queryOne(sql, params);
    }

    async run(sql, params = []) {
        return await this.core.run(sql, params);
    }

    async upsert(tableName, conflictCols = [], data = {}) {
        return await this.core.upsert(tableName, conflictCols, data);
    }

    prepare(sql) {
        if (typeof this.core.prepare === 'function') {
            return this.core.prepare(sql);
        }
        const core = this.core;
        return {
            all: (...params) => core.query(sql, params.flat()),
            get: (...params) => core.queryOne(sql, params.flat()),
            run: (...params) => core.run(sql, params.flat()),
        };
    }

    // ─────────────────────────────────────────────────────────
    // PRIVATE
    // ─────────────────────────────────────────────────────────

    _assertManagedForImport(method) {
        if (this._mode !== 'managed') {
            throw new Error(
                `[sutramEngine] ${method}() is only available in managed mode.\n` +
                `Current mode: "${this._mode}"\n` +
                `Managed mode: new SutramEngine({ db | dbPath }) — no schema in constructor.`
            );
        }
    }
}

module.exports = Engine;
