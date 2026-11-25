// index.js — sutramcore
'use strict';

const DbModal = require('./src/DbModal');
const BaseTable = require('./src/BaseTable');
const ViewEngine = require('./src/ViewEngine');
const ReportManager = require('./src/ReportManager');
const { col, ColBuilder } = require('./src/col');
const { defineTable } = require('./src/defineTable');
const { defineView } = require('./src/defineView');
const SQLiteIntrospector = require('./src/SQLiteIntrospector');

// ─────────────────────────────────────────────────────────────
// ── Sutram — instance-based ORM ──────────────────────────────
// ─────────────────────────────────────────────────────────────
//
// Create one Sutram instance per database connection.
// Each instance is fully isolated — own db, own schema, own cache.
//
// Usage:
//   const { Sutram } = require('sutramcore');
//
//   // Option A — pass your own db instance (existing project)
//   const sewa = new Sutram({ db: dbmodal.db, schema });
//
//   // Option B — let sutramcore open + migrate the db (fresh project)
//   const sewa = new Sutram({ dbPath: './data/app.db', schema, migrations, views });
//
//   // Get a table — cached, same instance returned every call
//   const item  = sewa.table('item');
//   const batch = sewa.table('hmp_batch');
//
//   // Reports / Procedures — CTE only in sutramCore
//   const sewa = new Sutram({ db, schema, reports: require('./reports') });
//   const rows = sewa.procedure('monthly_sales').run({ from: '2024-01' });
//
//   // Transactions — bound to this instance's db
//   sewa.transaction(() => {
//       item.insert(data, false);
//       batch.insert(batchData, false);
//   });

class Sutram {

    /**
     * @param {{ db?, dbPath?, schema, migrations?, views? }} opts
     * db         — pass your own better-sqlite3 instance  (existing project)
     * dbPath     — let sutramcore open + migrate the db   (fresh project)
     * schema     — tableMeta object { tableName: { columns, joins } }
     * migrations — array-of-arrays migration list         (only with dbPath)
     * views      — array of CREATE VIEW sql strings       (only with dbPath)
     */
    constructor({ db = null, dbPath = null, schema, migrations = [], views = [], reports = [] } = {}) {

        // ── schema validation ──────────────────────────────────
        if (!schema) {
            throw new Error('[sutramcore] Sutram requires schema');
        }
        if (typeof schema !== 'object' || Array.isArray(schema)) {
            throw new Error('[sutramcore] schema must be a plain object — { tableName: { columns, joins } }');
        }

        // ── db setup ───────────────────────────────────────────
        if (db) {
            // Option A — caller manages db lifecycle
            if (typeof db.prepare !== 'function') {
                throw new Error('[sutramcore] db must be a better-sqlite3 Database instance');
            }
            this.db = db;

        } else if (dbPath) {
            // Option B — sutramcore opens + migrates
            const modal = new DbModal(dbPath, migrations, views);
            this.db = modal.db;

        } else {
            throw new Error(
                '[sutramcore] Sutram() requires either:\n' +
                '  db     — pass your own better-sqlite3 instance\n' +
                '  dbPath — let sutramcore open and migrate the database'
            );
        }

        this.dialect = 'sqlite';
        this.schema = schema;
        this._tableCache = {};  // cache — sewa.table('item') returns same instance every call

        // ── materialize views declared via defineView() ────────
        // Must run before report manager and table cache so views are
        // registered in schema and available as join targets.
        ViewEngine.materialize(this);

        // ── report manager ─────────────────────────────────────
        this._report = new ReportManager(this.db);
        if (reports.length) {
            this._report.loadFromArray(reports);
        }

        // ── bind BaseTable subclass to this instance ───────────
        // Every table created via sewa.table() or new sewa.BaseTable()
        // automatically receives this instance's db + schema.
        const self = this;
        this.BaseTable = class extends BaseTable {
            constructor(tableName) {
                super(tableName, { db: self.db, schema: self.schema });
            }
        };

        console.log('[sutramcore] Instance ready');
    }


    // ─────────────────────────────────────────────────────────
    // ── TABLE FACTORY ─────────────────────────────────────────
    // ─────────────────────────────────────────────────────────
    // Returns a cached BaseTable instance for tableName.
    // Caching ensures _stmtCache (prepared statements) is preserved
    // across calls — critical for bulk insert performance.

    table(tableName) {
        if (!this._tableCache[tableName]) {
            this._tableCache[tableName] = new this.BaseTable(tableName);
        }
        return this._tableCache[tableName];
    }

    // ─────────────────────────────────────────────────────────
    // ── PROCEDURE — same pattern as table() ───────────────────
    // ─────────────────────────────────────────────────────────
    // Returns cached ProcedureHandle for a named CTE report.
    // Sync — returns rows directly (no await needed).
    //
    //   const rows = sewa.procedure('monthly_sales').run({ from: '2024-01' });
    //   sewa.procedure('low_stock').getParams()
    //   sewa.procedure('low_stock').getMeta()

    procedure(name) {
        return this._report.procedure(name);
    }

    // ─────────────────────────────────────────────────────────
    // ── TRANSACTIONS ──────────────────────────────────────────
    // ─────────────────────────────────────────────────────────
    // All transaction methods bound to THIS instance's db.
    //
    // Automatic — commits on success, rolls back on throw:
    //   sewa.transaction(() => {
    //       item.insert(data, false);
    //       batch.insert(batchData, false);
    //   });
    //
    // Manual — for complex / router-level cases:
    //   sewa.begin();
    //   try { ...; sewa.commit(); }
    //   catch (e) { sewa.rollback(); throw e; }

    transaction(fn) { return this.db.transaction(fn)(); }
    begin() { this.db.prepare('BEGIN').run(); }
    commit() { this.db.prepare('COMMIT').run(); }
    rollback() { this.db.prepare('ROLLBACK').run(); }

    // ─────────────────────────────────────────────────────────
    // ── RAW DB ACCESS ─────────────────────────────────────────
    // ─────────────────────────────────────────────────────────
    // For custom SQL that BaseTable doesn't handle.
    //   const rows = sewa.prepare(`SELECT * FROM ...`).all();

    prepare(sql) { return this.db.prepare(sql); }

    query(sql, params = []) {
        const list = Array.isArray(params) ? params : [params];
        return this.db.prepare(sql).all(...list);
    }

    queryOne(sql, params = []) {
        const list = Array.isArray(params) ? params : [params];
        return this.db.prepare(sql).get(...list) ?? null;
    }

    run(sql, params = []) {
        const list = Array.isArray(params) ? params : [params];
        const res = this.db.prepare(sql).run(...list);
        return {
            insertId: res.lastInsertRowid,
            lastInsertRowid: res.lastInsertRowid,
            changes: res.changes,
            affectedRows: res.changes,
        };
    }

    exec(sql) {
        return this.db.exec(sql);
    }

    get dbName() {
        return this.db?.name || 'sqlite';
    }

    get inTransaction() {
        return Boolean(this.db?.inTransaction);
    }

    async connect() {
        return this;
    }

    async close() {
        if (this.db && this.db.open) {
            this.db.close();
        }
    }

    setSchema(schema = {}) {
        this.schema = schema || {};
        this._tableCache = {};
        ViewEngine.materialize(this);
    }

    quoteId(name) {
        return `"${String(name).replace(/"/g, '""')}"`;
    }

    upsert(tableName, conflictCols = [], data = {}) {
        const keys = Object.keys(data);
        if (keys.length === 0) return { changes: 0, affectedRows: 0 };

        const qTbl = this.quoteId(tableName);
        const colsSql = keys.map(k => this.quoteId(k)).join(', ');
        const placeholders = keys.map(() => '?').join(', ');
        const vals = Object.values(data);
        const conflicts = (Array.isArray(conflictCols) ? conflictCols : [conflictCols]).filter(Boolean);
        const updateKeys = keys.filter(k => !conflicts.includes(k));

        if (conflicts.length > 0 && updateKeys.length > 0) {
            const updates = updateKeys.map(k => `${this.quoteId(k)} = excluded.${this.quoteId(k)}`).join(', ');
            const sql = `INSERT INTO ${qTbl} (${colsSql}) VALUES (${placeholders}) ON CONFLICT(${conflicts.map(c => this.quoteId(c)).join(', ')}) DO UPDATE SET ${updates}`;
            return this.run(sql, vals);
        }

        const sql = `INSERT OR IGNORE INTO ${qTbl} (${colsSql}) VALUES (${placeholders})`;
        return this.run(sql, vals);
    }

    hasTable(tableName) {
        const row = this.queryOne(
            `SELECT 1 as ok FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?`,
            [tableName]
        );
        return Boolean(row);
    }

    listPhysicalTables() {
        return this.query(
            `SELECT name FROM sqlite_master WHERE type IN ('table', 'view')`
        ).map(r => r.name);
    }

    listViews() {
        return this.query(
            `SELECT name FROM sqlite_master WHERE type = 'view' AND name NOT LIKE 'sys_%' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC`
        ).map(r => r.name);
    }

    inspectTable(tableName) {
        const qTbl = this.quoteId(tableName);
        const columns = this.db.prepare(`PRAGMA table_info(${qTbl})`).all();
        const indexList = this.db.prepare(`PRAGMA index_list(${qTbl})`).all();
        const indexes = indexList.map(idx => {
            const cols = this.db.prepare(`PRAGMA index_info(${this.quoteId(idx.name)})`).all().map(c => c.name);
            return { name: idx.name, unique: Boolean(idx.unique), columns: cols };
        });
        const foreignKeys = this.db.prepare(`PRAGMA foreign_key_list(${qTbl})`).all()
            .map(fk => ({ from: fk.from, table: fk.table, to: fk.to || '_id' }));

        return { columns, indexes, foreignKeys };
    }

    getForeignKeysTo(tableName) {
        const allTables = this.query(`
            SELECT name FROM sqlite_master
            WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'sys_%' AND name != ?
        `, [tableName]);
        const refs = [];
        for (const row of allTables) {
            try {
                const fks = this.db.prepare(`PRAGMA foreign_key_list(${this.quoteId(row.name)})`).all();
                for (const fk of fks) {
                    if (fk.table === tableName) {
                        refs.push({
                            table_name: row.name,
                            column_name: fk.from,
                            ref_col: fk.to || '_id'
                        });
                    }
                }
            } catch {}
        }
        return refs;
    }

    _columnSqlDef(col) {
        const colName = col.column_name;
        if (col.is_pk && col.auto_increment !== false && colName === '_id') {
            return `${this.quoteId(colName)} INTEGER PRIMARY KEY AUTOINCREMENT`;
        }

        let colDef = this.quoteId(colName);
        if (col.sql_type) {
            const upperSql = String(col.sql_type).toUpperCase();
            if (upperSql === 'PASSWORD') {
                colDef += ' TEXT';
            } else if (upperSql === 'FK') {
                colDef += ' INTEGER';
            } else if (col.length_precision && ['VARCHAR', 'CHAR', 'DECIMAL', 'NUMERIC', 'FLOAT'].includes(upperSql)) {
                colDef += ` ${upperSql}(${col.length_precision})`;
            } else if (upperSql === 'ENUM' && col.length_precision) {
                colDef += ` TEXT CHECK(${this.quoteId(colName)} IN (${col.length_precision}))`;
            } else {
                colDef += ` ${upperSql}`;
            }
        } else {
            switch (String(col.col_type || 'string').toLowerCase()) {
                case 'number':   colDef += ' DECIMAL(10,2)'; break;
                case 'boolean':  colDef += ' TINYINT'; break;
                case 'date':     colDef += ' DATE'; break;
                case 'datetime': colDef += ' DATETIME'; break;
                case 'json':     colDef += ' TEXT'; break;
                case 'password': colDef += ' TEXT'; break;
                case 'integer':  colDef += ' INTEGER'; break;
                default:         colDef += ' TEXT';
            }
        }

        if (col.is_pk && col.auto_increment === false) colDef += ' PRIMARY KEY';
        if (col.is_required) colDef += ' NOT NULL';
        if (col.is_unique) colDef += ' UNIQUE';

        if (col.default_type === 'CURRENT_TIMESTAMP') {
            colDef += ` DEFAULT (datetime('now', 'localtime'))`;
        } else if (col.default_type === 'NULL') {
            colDef += ` DEFAULT NULL`;
        } else if (col.default_value !== undefined && col.default_value !== null && String(col.default_value).trim() !== '') {
            const isNum = ['number', 'int', 'integer', 'decimal', 'boolean', 'tinyint'].includes(String(col.sql_type || col.col_type || '').toLowerCase());
            const escaped = String(col.default_value).replace(/'/g, "''");
            colDef += ` DEFAULT ${isNum ? col.default_value : `'${escaped}'`}`;
        }

        if (col.ref_table && col.ref_col) {
            colDef += ` REFERENCES ${this.quoteId(col.ref_table)}(${this.quoteId(col.ref_col)}) ON DELETE ${col.on_delete || 'RESTRICT'}`;
        }
        return colDef;
    }

    buildCreateTableSQL(def) {
        const { table_name, columns = [], uniqueKeys = [], timestamps = true } = def;
        const parts = columns.map(col => this._columnSqlDef(col));
        if (timestamps !== false) {
            parts.push(`"created_at" TEXT DEFAULT (datetime('now', 'localtime'))`);
            parts.push(`"updated_at" TEXT DEFAULT (datetime('now', 'localtime'))`);
        }
        for (const uk of (uniqueKeys || [])) {
            if (Array.isArray(uk) && uk.length > 0) {
                parts.push(`UNIQUE(${uk.map(c => this.quoteId(c)).join(', ')})`);
            }
        }
        return `CREATE TABLE IF NOT EXISTS ${this.quoteId(table_name)} (\n  ${parts.join(',\n  ')}\n)`;
    }

    createTable(def) {
        const sql = this.buildCreateTableSQL(def);
        this.run(sql);
        for (const col of (def.columns || [])) {
            if (col.has_index && col.column_name !== '_id') {
                const idxName = `idx_${def.table_name}_${col.column_name}`;
                this.run(`CREATE INDEX IF NOT EXISTS ${this.quoteId(idxName)} ON ${this.quoteId(def.table_name)}(${this.quoteId(col.column_name)})`);
            }
        }
    }

    addColumn(tableName, col) {
        let colDef = this._columnSqlDef({ ...col, is_pk: false });
        // SQLite ALTER TABLE ADD COLUMN does not allow non-constant default like datetime() directly unless simple or nullable
        if (col.default_type === 'CURRENT_TIMESTAMP') {
            colDef = colDef.replace(/ DEFAULT \(datetime\('now', 'localtime'\)\)/, ' DEFAULT NULL');
        }
        this.run(`ALTER TABLE ${this.quoteId(tableName)} ADD COLUMN ${colDef}`);
    }

    renameColumn(tableName, fromCol, toCol) {
        this.run(`ALTER TABLE ${this.quoteId(tableName)} RENAME COLUMN ${this.quoteId(fromCol)} TO ${this.quoteId(toCol)}`);
    }

    dropColumn(tableName, colName) {
        this.run(`ALTER TABLE ${this.quoteId(tableName)} DROP COLUMN ${this.quoteId(colName)}`);
    }

    dropTable(tableName) {
        this.run(`DROP TABLE IF EXISTS ${this.quoteId(tableName)}`);
    }

    alterTable(tableName, plan) {
        const { incoming, addedCols, removedCols, renamedCols, existingMap, needsRebuild, physicalNames } = plan;
        const isNumericAffinity = (t) => ['number', 'boolean'].includes(String(t || '').toLowerCase());
        const qTbl = this.quoteId(tableName);

        if (!needsRebuild) {
            for (const ren of renamedCols) {
                if (physicalNames.has(ren.from)) {
                    this.renameColumn(tableName, ren.from, ren.to);
                    physicalNames.delete(ren.from);
                    physicalNames.add(ren.to);
                }
            }
            for (const rc of removedCols) {
                if (physicalNames.has(rc.column_name)) {
                    this.dropColumn(tableName, rc.column_name);
                    physicalNames.delete(rc.column_name);
                }
            }
            for (const ac of addedCols) {
                if (!physicalNames.has(ac.column_name)) {
                    this.addColumn(tableName, ac);
                    physicalNames.add(ac.column_name);
                }
            }
            for (const col of incoming) {
                if (col.has_index && col.column_name !== '_id') {
                    const idxName = `idx_${tableName}_${col.column_name}`;
                    this.run(`CREATE INDEX IF NOT EXISTS ${this.quoteId(idxName)} ON ${qTbl}(${this.quoteId(col.column_name)})`);
                }
            }
            return { strategy: 'in-place' };
        }

        const shadowName = `__sutram_rebuild_${tableName}_${Date.now()}`;
        const qShadow = this.quoteId(shadowName);
        const oldCount = this.queryOne(`SELECT COUNT(*) as c FROM ${qTbl}`)?.c || 0;

        this.db.pragma('foreign_keys = OFF');
        const needTx = !this.db.inTransaction;
        try {
            if (needTx) this.db.prepare('BEGIN IMMEDIATE').run();

            this.run(this.buildCreateTableSQL({ table_name: shadowName, columns: incoming }));

            const destCols = [];
            const selectExprs = [];
            const toDefaultExpr = (col) => {
                if (col.default_type === 'CURRENT_TIMESTAMP') return `datetime('now', 'localtime')`;
                if (isNumericAffinity(col.col_type)) {
                    return (col.default_value !== undefined && col.default_value !== null && String(col.default_value).trim() !== '' && !isNaN(Number(col.default_value)))
                        ? String(Number(col.default_value))
                        : '0';
                }
                return `'${String(col.default_value ?? '').replace(/'/g, "''")}'`;
            };

            for (const col of incoming) {
                const srcName = col.original_name && physicalNames.has(col.original_name)
                    ? col.original_name
                    : (physicalNames.has(col.column_name) ? col.column_name : null);

                const origMeta = srcName ? existingMap.get(srcName) : null;
                const prevDefNorm = origMeta?.default_value !== undefined && origMeta?.default_value !== null && String(origMeta.default_value).trim() !== ''
                    ? String(origMeta.default_value) : null;
                const nextDefNorm = col.default_value !== undefined && col.default_value !== null && String(col.default_value).trim() !== ''
                    ? String(col.default_value) : null;
                const hasExplicitNewDefault = (nextDefNorm !== null || col.default_type === 'CURRENT_TIMESTAMP') && nextDefNorm !== prevDefNorm;

                if (srcName) {
                    destCols.push(this.quoteId(col.column_name));
                    if ((col.is_required && !col.is_pk) || (hasExplicitNewDefault && !col.is_pk)) {
                        const fallback = toDefaultExpr(col);
                        if (isNumericAffinity(col.col_type)) {
                            selectExprs.push(`COALESCE(${this.quoteId(srcName)}, ${fallback})`);
                        } else {
                            selectExprs.push(`CASE WHEN ${this.quoteId(srcName)} IS NULL OR ${this.quoteId(srcName)} = '' THEN ${fallback} ELSE ${this.quoteId(srcName)} END`);
                        }
                    } else {
                        selectExprs.push(this.quoteId(srcName));
                    }
                } else if (!col.is_pk && (col.is_required || nextDefNorm !== null || col.default_type === 'CURRENT_TIMESTAMP')) {
                    destCols.push(this.quoteId(col.column_name));
                    selectExprs.push(toDefaultExpr(col));
                }
            }

            if (physicalNames.has('created_at')) { destCols.push('"created_at"'); selectExprs.push('"created_at"'); }
            if (physicalNames.has('updated_at')) { destCols.push('"updated_at"'); selectExprs.push('"updated_at"'); }

            if (oldCount > 0 && destCols.length > 0) {
                this.run(`INSERT INTO ${qShadow} (${destCols.join(', ')}) SELECT ${selectExprs.join(', ')} FROM ${qTbl}`);
            }

            const newCount = this.queryOne(`SELECT COUNT(*) as c FROM ${qShadow}`)?.c || 0;
            if (newCount !== oldCount) {
                throw new Error(`[sutramcore] Shadow rebuild row count mismatch (${newCount} !== ${oldCount}) — rolled back safely.`);
            }

            this.run(`DROP TABLE ${qTbl}`);
            this.run(`ALTER TABLE ${qShadow} RENAME TO ${qTbl}`);

            for (const col of incoming) {
                if (col.has_index && col.column_name !== '_id') {
                    const idxName = `idx_${tableName}_${col.column_name}`;
                    this.run(`CREATE INDEX IF NOT EXISTS ${this.quoteId(idxName)} ON ${qTbl}(${this.quoteId(col.column_name)})`);
                }
            }

            const fkViolations = this.db.prepare(`PRAGMA foreign_key_check(${qTbl})`).all();
            if (fkViolations.length > 0) {
                throw new Error(`[sutramcore] Foreign key check failed on "${tableName}" (${fkViolations.length} violation(s)) — rolled back safely.`);
            }

            if (needTx) this.db.prepare('COMMIT').run();
            return { strategy: 'rebuild' };
        } catch (err) {
            if (needTx && this.db.inTransaction) this.db.prepare('ROLLBACK').run();
            try { this.run(`DROP TABLE IF EXISTS ${qShadow}`); } catch {}
            throw err;
        } finally {
            this.db.pragma('foreign_keys = ON');
        }
    }

    introspect() {
        return SQLiteIntrospector.introspect(this.db);
    }

    purgeSutram() {
        return SQLiteIntrospector.purgeSutram(this.db);
    }
}

module.exports = { Sutram, col, ColBuilder, defineTable, defineView, SQLiteIntrospector };
