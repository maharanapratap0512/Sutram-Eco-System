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
    // RAW QUERY ACCESS
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

    prepare(sql) {
        const adapter = this.adapter;
        return {
            all: (...params) => adapter.all(sql, params.flat()),
            get: (...params) => adapter.get(sql, params.flat()),
            run: (...params) => adapter.run(sql, params.flat()),
        };
    }

    async introspect() {
        return MySQLIntrospector.introspect(this.adapter);
    }

    async purgeSutram() {
        return MySQLIntrospector.purgeSutram(this.adapter);
    }

    async cloneDatabase(sourceDb, targetDb) {
        return MySQLIntrospector.cloneDatabase(this.adapter, sourceDb, targetDb);
    }

    async createTable(def) {
        const { table_name, columns = [] } = def;
        const parts = [];
        for (const col of columns) {
            if (col.is_pk || col.column_name === '_id') {
                parts.push('`_id` INT AUTO_INCREMENT PRIMARY KEY');
                continue;
            }
            const colName = `\`${col.column_name}\``;
            let sqlType = 'VARCHAR(255)';
            const t = String(col.col_type || col.sql_type || 'string').toLowerCase();
            if (t === 'number' || t === 'integer' || t === 'int') sqlType = 'INT';
            else if (t === 'decimal' || t === 'float' || t === 'double') sqlType = 'DECIMAL(15,2)';
            else if (t === 'boolean' || t === 'tinyint') sqlType = 'TINYINT(1)';
            else if (t === 'json') sqlType = 'JSON';
            else if (t === 'date') sqlType = 'DATE';
            else if (t === 'datetime') sqlType = 'DATETIME';
            else if (t === 'text') sqlType = 'TEXT';
            else if (t === 'password') sqlType = 'VARCHAR(255)';

            const req = col.is_required ? 'NOT NULL' : 'NULL';
            const defVal = (col.default_value !== undefined && col.default_value !== null) ? `DEFAULT '${col.default_value}'` : '';
            parts.push(`${colName} ${sqlType} ${req} ${defVal}`.trim());
        }
        const sql = `CREATE TABLE IF NOT EXISTS \`${table_name}\` (\n  ${parts.join(',\n  ')}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`;
        return this.adapter.run(sql);
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
