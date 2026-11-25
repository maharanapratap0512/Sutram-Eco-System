// src/MySQLSutram.js
// ─────────────────────────────────────────────────────────────
// Async Sutram class for MySQL — mirrors sutramCore's Sutram API
// but all methods return Promises.
//
// Usage:
//   const { MySQLSutram } = require('sutramcore-mysql');
//
//   const db = new MySQLSutram({
//     host: 'localhost', user: 'root',
//     password: 'secret', database: 'myapp',
//     schema: require('./schema'),
//   });
//   await db.connect();
//
//   const row = await db.table('product').getById(1);
// ─────────────────────────────────────────────────────────────

'use strict';

const { MySQLAdapter }    = require('./MySQLAdapter');
const MySQLBaseTable      = require('./MySQLBaseTable');
const MySQLReportManager  = require('./MySQLReportManager');
const MySQLIntrospector   = require('./MySQLIntrospector');

class MySQLSutram {

    constructor(opts = {}) {
        const {
            host, port, user, password, database, connectionLimit,
            adapter = null,
            schema,
            reports = [],
        } = opts;
        if (!schema) throw new Error('[sutramcore-mysql] MySQLSutram requires schema');

        if (adapter) {
            // accept pre-configured adapter
            if (typeof adapter.run !== 'function') {
                throw new Error('[sutramcore-mysql] adapter must be a MySQLAdapter instance');
            }
            this.adapter = adapter;
        } else {
            // create adapter from config
            this.adapter = new MySQLAdapter({ host, port, user, password, database, connectionLimit });
        }

        this.schema          = schema;
        this._tableCache     = {};
        this._directReports  = opts.reports ?? [];
        this.report          = null;  // initialized after connect()

        // expose for sutramEngine compatibility
        this.db      = null;
        this.dialect = 'mysql';
    }

    // ─────────────────────────────────────────────────────────
    // CONNECT — must call before using
    // ─────────────────────────────────────────────────────────

    async connect() {
        await this.adapter.connect();

        // init report manager
        this.report = new MySQLReportManager(this.adapter);
        if (this._directReports?.length) {
            this.report.loadFromArray(this._directReports);
        }

        console.log('[sutramcore-mysql] MySQLSutram ready');
        return this;
    }

    // ─────────────────────────────────────────────────────────
    // TABLE — cached MySQLBaseTable instance
    // ─────────────────────────────────────────────────────────

    table(tableName) {
        if (!this._tableCache[tableName]) {
            this._tableCache[tableName] = new MySQLBaseTable(tableName, {
                adapter: this.adapter,
                schema:  this.schema,
            });
        }
        return this._tableCache[tableName];
    }

    get dbName() {
        return this.adapter?._config?.database || 'mysql';
    }

    get inTransaction() {
        return Boolean(this.adapter?.inTransaction);
    }

    setSchema(schema = {}) {
        this.schema = schema || {};
        this._tableCache = {};
    }

    quoteId(name) {
        return `\`${String(name).replace(/`/g, '``')}\``;
    }

    // ─────────────────────────────────────────────────────────
    // TRANSACTIONS
    // ─────────────────────────────────────────────────────────

    // Automatic — commits on success, rolls back on throw
    async transaction(fn) {
        return this.adapter.transaction(async (scopedAdapter) => {
            // create a scoped MySQLSutram that uses the transaction connection
            const scoped = new _ScopedMySQLSutram(scopedAdapter, this.schema);
            return fn(scoped);
        });
    }

    // Manual
    async begin()    { await this.adapter.begin(); }
    async commit()   { await this.adapter.commit(); }
    async rollback() { await this.adapter.rollback(); }

    // ─────────────────────────────────────────────────────────
    // PROCEDURE ACCESS
    // ─────────────────────────────────────────────────────────

    procedure(name) {
        if (!this.report) {
            throw new Error('[sutramcore-mysql] Call connect() before procedure()');
        }
        return this.report.procedure(name);
    }

    // ─────────────────────────────────────────────────────────
    // RAW QUERY & UPSERT ACCESS
    // ─────────────────────────────────────────────────────────

    async query(sql, params = []) {
        return this.adapter.all(sql, params);
    }

    async queryOne(sql, params = []) {
        return this.adapter.get(sql, params);
    }

    async run(sql, params = []) {
        return this.adapter.run(sql, params);
    }

    async exec(sql) {
        return this.adapter.run(sql);
    }

    prepare(sql) {
        const adapter = this.adapter;
        return {
            all: (...params) => adapter.all(sql, params.flat()),
            get: (...params) => adapter.get(sql, params.flat()),
            run: (...params) => adapter.run(sql, params.flat()),
        };
    }

    async upsert(tableName, conflictCols = [], data = {}) {
        const keys = Object.keys(data);
        if (keys.length === 0) return { changes: 0, affectedRows: 0 };

        const qTbl = this.quoteId(tableName);
        const colsSql = keys.map(k => this.quoteId(k)).join(', ');
        const placeholders = keys.map(() => '?').join(', ');
        const vals = Object.values(data);
        const conflicts = (Array.isArray(conflictCols) ? conflictCols : [conflictCols]).filter(Boolean);
        const updateKeys = keys.filter(k => !conflicts.includes(k));

        if (conflicts.length > 0 && updateKeys.length > 0) {
            const updates = updateKeys.map(k => `${this.quoteId(k)} = VALUES(${this.quoteId(k)})`).join(', ');
            const sql = `INSERT INTO ${qTbl} (${colsSql}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${updates}`;
            return await this.run(sql, vals);
        }

        const sql = `INSERT IGNORE INTO ${qTbl} (${colsSql}) VALUES (${placeholders})`;
        return await this.run(sql, vals);
    }

    // ─────────────────────────────────────────────────────────
    // METADATA & INTROSPECTION
    // ─────────────────────────────────────────────────────────

    async hasTable(tableName) {
        const row = await this.queryOne(
            `SELECT 1 as ok FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
            [tableName]
        );
        return Boolean(row);
    }

    async listPhysicalTables() {
        const rows = await this.query(
            `SELECT TABLE_NAME as name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()`
        );
        return rows.map(r => r.name);
    }

    async listViews() {
        const rows = await this.query(
            `SELECT TABLE_NAME as name FROM information_schema.VIEWS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME NOT LIKE 'sys_%' ORDER BY TABLE_NAME ASC`
        );
        return rows.map(r => r.name);
    }

    async inspectTable(tableName) {
        const colRows = await this.query(`
            SELECT
                COLUMN_NAME as name,
                COLUMN_TYPE as type,
                IS_NULLABLE as is_nullable,
                COLUMN_DEFAULT as dflt_value,
                COLUMN_KEY as col_key
            FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
            ORDER BY ORDINAL_POSITION ASC
        `, [tableName]);

        const columns = colRows.map(c => ({
            name: c.name,
            type: c.type,
            notnull: c.is_nullable === 'NO' ? 1 : 0,
            dflt_value: c.dflt_value,
            pk: c.col_key === 'PRI' ? 1 : 0
        }));

        const statRows = await this.query(`
            SELECT INDEX_NAME as name, NON_UNIQUE as non_unique, COLUMN_NAME as column_name
            FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
            ORDER BY INDEX_NAME, SEQ_IN_INDEX
        `, [tableName]);

        const idxMap = new Map();
        for (const s of statRows) {
            if (!idxMap.has(s.name)) {
                idxMap.set(s.name, { name: s.name, unique: s.non_unique === 0, columns: [] });
            }
            idxMap.get(s.name).columns.push(s.column_name);
        }

        const fkRows = await this.query(`
            SELECT
                COLUMN_NAME as \`from\`,
                REFERENCED_TABLE_NAME as \`table\`,
                REFERENCED_COLUMN_NAME as \`to\`
            FROM information_schema.KEY_COLUMN_USAGE
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL
        `, [tableName]);

        return {
            columns,
            indexes: Array.from(idxMap.values()),
            foreignKeys: fkRows.map(f => ({ from: f.from, table: f.table, to: f.to || '_id' }))
        };
    }

    async getForeignKeysTo(tableName) {
        const rows = await this.query(`
            SELECT
                TABLE_NAME as table_name,
                COLUMN_NAME as column_name,
                COALESCE(REFERENCED_COLUMN_NAME, '_id') as ref_col
            FROM information_schema.KEY_COLUMN_USAGE
            WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME = ? AND TABLE_NAME != ?
        `, [tableName, tableName]);
        return rows;
    }

    async introspect() {
        return MySQLIntrospector.introspect(this.adapter, this.dbName);
    }

    async purgeSutram() {
        return MySQLIntrospector.purgeSutram(this.adapter, this.dbName);
    }

    async cloneDatabase(sourceDb, targetDb) {
        return MySQLIntrospector.cloneDatabase(this.adapter, sourceDb, targetDb);
    }

    // ─────────────────────────────────────────────────────────
    // DDL ENGINE (MySQL Dialect)
    // ─────────────────────────────────────────────────────────

    _columnSqlDef(col, { skipUnique = false } = {}) {
        const colName = col.column_name;
        if (col.is_pk && col.auto_increment !== false && colName === '_id') {
            return `${this.quoteId(colName)} INT AUTO_INCREMENT PRIMARY KEY`;
        }

        let colDef = this.quoteId(colName);
        let resolvedType = '';
        if (col.sql_type) {
            const upperSql = String(col.sql_type).toUpperCase();
            if (upperSql === 'PASSWORD') {
                resolvedType = `VARCHAR(${col.length_precision || 255})`;
            } else if (upperSql === 'FK') {
                resolvedType = 'INT';
            } else if (upperSql === 'INTEGER') {
                resolvedType = 'INT';
            } else if (upperSql === 'BOOLEAN') {
                resolvedType = 'TINYINT(1)';
            } else if (col.length_precision && ['VARCHAR', 'CHAR', 'DECIMAL', 'NUMERIC', 'FLOAT'].includes(upperSql)) {
                resolvedType = `${upperSql}(${col.length_precision})`;
            } else if (upperSql === 'ENUM' && col.length_precision) {
                resolvedType = `ENUM(${col.length_precision})`;
            } else {
                resolvedType = upperSql;
            }
        } else {
            switch (String(col.col_type || 'string').toLowerCase()) {
                case 'number':   resolvedType = 'DECIMAL(15,2)'; break;
                case 'boolean':  resolvedType = 'TINYINT(1)'; break;
                case 'date':     resolvedType = 'DATE'; break;
                case 'datetime': resolvedType = 'DATETIME'; break;
                case 'json':     resolvedType = 'JSON'; break;
                case 'password': resolvedType = `VARCHAR(${col.length_precision || 255})`; break;
                case 'integer':  resolvedType = 'INT'; break;
                case 'text':     resolvedType = 'TEXT'; break;
                default:         resolvedType = `VARCHAR(${col.length_precision || 255})`;
            }
        }
        colDef += ` ${resolvedType}`;

        if (col.is_pk && col.auto_increment === false) colDef += ' PRIMARY KEY';
        if (col.is_required) colDef += ' NOT NULL';
        if (col.is_unique && !skipUnique) colDef += ' UNIQUE';

        const disallowLiteralDefault = /^(TEXT|TINYTEXT|MEDIUMTEXT|LONGTEXT|BLOB|JSON)$/i.test(resolvedType.trim());
        if (col.default_type === 'CURRENT_TIMESTAMP') {
            colDef += ' DEFAULT CURRENT_TIMESTAMP';
        } else if (col.default_type === 'NULL' && !disallowLiteralDefault) {
            colDef += ' DEFAULT NULL';
        } else if (!disallowLiteralDefault && col.default_value !== undefined && col.default_value !== null && String(col.default_value).trim() !== '') {
            const isNum = ['number', 'int', 'integer', 'decimal', 'boolean', 'tinyint'].includes(String(col.sql_type || col.col_type || '').toLowerCase());
            const escaped = String(col.default_value).replace(/'/g, "''");
            colDef += ` DEFAULT ${isNum ? col.default_value : `'${escaped}'`}`;
        }

        return colDef;
    }

    buildCreateTableSQL(def) {
        const { table_name, columns = [], uniqueKeys = [], timestamps = true } = def;
        const parts = columns.map(col => this._columnSqlDef(col));
        if (timestamps !== false) {
            parts.push('`created_at` DATETIME DEFAULT CURRENT_TIMESTAMP');
            parts.push('`updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');
        }
        for (const uk of (uniqueKeys || [])) {
            if (Array.isArray(uk) && uk.length > 0) {
                parts.push(`UNIQUE KEY ${this.quoteId(`uk_${uk.join('_')}`)} (${uk.map(c => this.quoteId(c)).join(', ')})`);
            }
        }
        for (const col of columns) {
            if (col.ref_table && col.ref_col) {
                const fkName = `fk_${table_name}_${col.column_name}`;
                parts.push(
                    `CONSTRAINT ${this.quoteId(fkName)} FOREIGN KEY (${this.quoteId(col.column_name)}) ` +
                    `REFERENCES ${this.quoteId(col.ref_table)}(${this.quoteId(col.ref_col)}) ON DELETE ${col.on_delete || 'RESTRICT'}`
                );
            }
        }
        return `CREATE TABLE IF NOT EXISTS ${this.quoteId(table_name)} (\n  ${parts.join(',\n  ')}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;
    }

    async createTable(def) {
        const sql = this.buildCreateTableSQL(def);
        await this.run(sql);
        for (const col of (def.columns || [])) {
            if (col.has_index && col.column_name !== '_id') {
                const idxName = `idx_${def.table_name}_${col.column_name}`;
                try {
                    await this.run(`CREATE INDEX ${this.quoteId(idxName)} ON ${this.quoteId(def.table_name)}(${this.quoteId(col.column_name)})`);
                } catch {}
            }
        }
    }

    async addColumn(tableName, col) {
        const colDef = this._columnSqlDef({ ...col, is_pk: false });
        const qTbl = this.quoteId(tableName);
        await this.run(`ALTER TABLE ${qTbl} ADD COLUMN ${colDef}`);
        if (col.ref_table && col.ref_col) {
            const fkName = `fk_${tableName}_${col.column_name}`;
            try {
                await this.run(
                    `ALTER TABLE ${qTbl} ADD CONSTRAINT ${this.quoteId(fkName)} FOREIGN KEY (${this.quoteId(col.column_name)}) ` +
                    `REFERENCES ${this.quoteId(col.ref_table)}(${this.quoteId(col.ref_col)}) ON DELETE ${col.on_delete || 'RESTRICT'}`
                );
            } catch {}
        }
    }

    async renameColumn(tableName, fromCol, toCol, colDef = null) {
        if (colDef) {
            const defSql = this._columnSqlDef({ ...colDef, column_name: toCol, is_pk: false, skipUnique: false }, { skipUnique: true });
            await this.run(`ALTER TABLE ${this.quoteId(tableName)} CHANGE COLUMN ${this.quoteId(fromCol)} ${defSql}`);
        } else {
            await this.run(`ALTER TABLE ${this.quoteId(tableName)} RENAME COLUMN ${this.quoteId(fromCol)} TO ${this.quoteId(toCol)}`);
        }
    }

    async dropColumn(tableName, colName) {
        const qTbl = this.quoteId(tableName);
        // Drop any foreign keys on this column before dropping column in MySQL
        const fkRows = await this.query(`
            SELECT CONSTRAINT_NAME as cname FROM information_schema.KEY_COLUMN_USAGE
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL
        `, [tableName, colName]);
        for (const fk of fkRows) {
            try { await this.run(`ALTER TABLE ${qTbl} DROP FOREIGN KEY ${this.quoteId(fk.cname)}`); } catch {}
        }
        await this.run(`ALTER TABLE ${qTbl} DROP COLUMN ${this.quoteId(colName)}`);
    }

    async dropTable(tableName) {
        await this.run(`DROP TABLE IF EXISTS ${this.quoteId(tableName)}`);
    }

    async alterTable(tableName, plan) {
        const { incoming, addedCols, removedCols, renamedCols, physicalNames } = plan;
        const qTbl = this.quoteId(tableName);

        for (const ren of renamedCols) {
            if (physicalNames.has(ren.from)) {
                const targetCol = incoming.find(c => c.column_name === ren.to);
                await this.renameColumn(tableName, ren.from, ren.to, targetCol);
                physicalNames.delete(ren.from);
                physicalNames.add(ren.to);
            }
        }

        for (const rc of removedCols) {
            if (physicalNames.has(rc.column_name)) {
                await this.dropColumn(tableName, rc.column_name);
                physicalNames.delete(rc.column_name);
            }
        }

        const inspected = await this.inspectTable(tableName);
        const existingUniqueCols = new Set(
            (inspected.indexes || [])
                .filter(idx => idx.unique && idx.columns.length === 1 && idx.name !== 'PRIMARY')
                .map(idx => idx.columns[0])
        );

        for (const col of incoming) {
            if (col.is_pk || col.column_name === '_id') continue;
            if (!physicalNames.has(col.column_name) && addedCols.some(a => a.column_name === col.column_name)) {
                await this.addColumn(tableName, col);
                physicalNames.add(col.column_name);
            } else if (physicalNames.has(col.column_name)) {
                const modSql = this._columnSqlDef(
                    { ...col, is_pk: false },
                    { skipUnique: existingUniqueCols.has(col.column_name) }
                );
                try {
                    await this.run(`ALTER TABLE ${qTbl} MODIFY COLUMN ${modSql}`);
                } catch (e) {
                    if (!/Duplicate/i.test(e.message)) throw e;
                }
            }
        }

        for (const col of incoming) {
            if (col.has_index && col.column_name !== '_id') {
                const idxName = `idx_${tableName}_${col.column_name}`;
                try {
                    await this.run(`CREATE INDEX ${this.quoteId(idxName)} ON ${qTbl}(${this.quoteId(col.column_name)})`);
                } catch {}
            }
        }

        return { strategy: 'mysql-alter' };
    }

    async close() {
        await this.adapter.close();
    }
}

// ─────────────────────────────────────────────────────────────
// Internal — scoped Sutram for transaction context
// Same API but uses the transaction connection adapter
// ─────────────────────────────────────────────────────────────

class _ScopedMySQLSutram {

    constructor(scopedAdapter, schema) {
        this.dialect     = 'mysql';
        this._adapter    = scopedAdapter;
        this.schema      = schema;
        this._tableCache = {};
    }

    table(tableName) {
        if (!this._tableCache[tableName]) {
            this._tableCache[tableName] = new MySQLBaseTable(tableName, {
                adapter: this._adapter,
                schema:  this.schema,
            });
        }
        return this._tableCache[tableName];
    }
}

module.exports = { MySQLSutram };
