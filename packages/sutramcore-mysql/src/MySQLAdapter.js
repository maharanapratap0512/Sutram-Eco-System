// src/MySQLAdapter.js
// ─────────────────────────────────────────────────────────────
// Wraps mysql2 connection pool.
// Provides same interface as better-sqlite3 but async.
//
// Usage:
//   const adapter = new MySQLAdapter({
//     host:     'localhost',
//     port:     3306,
//     user:     'root',
//     password: 'secret',
//     database: 'myapp',
//   });
//   await adapter.connect();
// ─────────────────────────────────────────────────────────────

'use strict';

class MySQLAdapter {

    constructor(config = {}) {
        if (!config.host)     throw new Error('[sutramcore-mysql] host required');
        if (!config.user)     throw new Error('[sutramcore-mysql] user required');
        if (!config.database) throw new Error('[sutramcore-mysql] database required');

        this._config = {
            host:              config.host,
            port:              config.port     ?? 3306,
            user:              config.user,
            password:          config.password ?? '',
            database:          config.database,
            waitForConnections: true,
            connectionLimit:   config.connectionLimit ?? 10,
            queueLimit:        0,
            // return JS Date objects for datetime columns
            dateStrings:       false,
            // always return bigints as numbers
            supportBigNumbers: true,
            bigNumberStrings:  false,
        };

        this.pool = null;
        this._conn = null;
        this.dialect = 'mysql';
    }

    get inTransaction() {
        return Boolean(this._conn);
    }

    // ─────────────────────────────────────────────────────────
    // CONNECT — create pool + test connection
    // ─────────────────────────────────────────────────────────

    async connect() {
        const mysql = this._requireMySQL2();
        this.pool   = mysql.createPool(this._config);

        // test connection
        try {
            const conn = await this.pool.getConnection();
            conn.release();
            console.log(`[sutramcore-mysql] Connected: ${this._config.host}/${this._config.database}`);
        } catch (err) {
            throw new Error(`[sutramcore-mysql] Connection failed: ${err.message}`);
        }

        return this;
    }

    // ─────────────────────────────────────────────────────────
    // CORE METHODS
    // All return Promises — use await
    // ─────────────────────────────────────────────────────────

    async _exec(sql, params = []) {
        const target = this._conn || this.pool;
        if (!target) throw new Error('[sutramcore-mysql] Not connected — call connect() first');
        const flatParams = this._flattenParams(params);
        const finalSql = this._toMySQLPlaceholders(sql);
        if (flatParams.length === 0) {
            return await target.query(finalSql);
        }
        try {
            return await target.execute(finalSql, flatParams);
        } catch (err) {
            if (err && err.code === 'ER_UNSUPPORTED_PS') {
                return await target.query(finalSql, flatParams);
            }
            throw err;
        }
    }

    // Execute INSERT / UPDATE / DELETE / DDL
    // Returns { insertId, affectedRows, changedRows }
    async run(sql, params = []) {
        const [result] = await this._exec(sql, params);
        return {
            insertId:        result?.insertId ?? 0,
            affectedRows:    result?.affectedRows ?? 0,
            changedRows:     result?.changedRows ?? 0,
            // compat with better-sqlite3 naming
            lastInsertRowid: result?.insertId ?? 0,
            changes:         result?.affectedRows ?? 0,
        };
    }

    // Execute SELECT — return single row or null
    async get(sql, params = []) {
        const [rows] = await this._exec(sql, params);
        return (Array.isArray(rows) ? rows[0] : null) ?? null;
    }

    // Execute SELECT — return all rows
    async all(sql, params = []) {
        const [rows] = await this._exec(sql, params);
        return Array.isArray(rows) ? rows : [];
    }

    // ─────────────────────────────────────────────────────────
    // TRANSACTION
    // fn receives a connection-scoped adapter for atomic ops
    // ─────────────────────────────────────────────────────────

    async transaction(fn) {
        const conn = await this.pool.getConnection();
        await conn.beginTransaction();

        // create a scoped adapter that uses this connection
        const scoped = new MySQLScopedAdapter(conn);

        try {
            const result = await fn(scoped);
            await conn.commit();
            return result;
        } catch (err) {
            await conn.rollback();
            throw err;
        } finally {
            conn.release();
        }
    }

    // Manual transaction control (for router-level use)
    async begin() {
        if (this._conn) throw new Error('[sutramcore-mysql] Transaction already active');
        this._conn = await this.pool.getConnection();
        await this._conn.beginTransaction();
    }

    async commit() {
        if (!this._conn) throw new Error('[sutramcore-mysql] No active transaction');
        await this._conn.commit();
        this._conn.release();
        this._conn = null;
    }

    async rollback() {
        if (!this._conn) return;
        await this._conn.rollback();
        this._conn.release();
        this._conn = null;
    }

    // ─────────────────────────────────────────────────────────
    // HELPERS
    // ─────────────────────────────────────────────────────────

    // better-sqlite3 uses ? for params — MySQL also uses ?
    // but sutramCore builds SQL with ? already — compatible
    _toMySQLPlaceholders(sql) {
        return sql;
    }

    // params come in as array or spread — normalize to flat array
    _flattenParams(params) {
        if (!params) return [];
        if (Array.isArray(params)) return params;
        return [params];
    }

    _requireMySQL2() {
        try {
            return require('mysql2/promise');
        } catch {
            throw new Error(
                '[sutramcore-mysql] mysql2 not installed.\n' +
                'Run: npm install mysql2'
            );
        }
    }

    async close() {
        if (this.pool) {
            await this.pool.end();
            console.log('[sutramcore-mysql] Pool closed');
        }
    }
}

// ─────────────────────────────────────────────────────────────
// MySQLScopedAdapter — single connection adapter for transactions
// Used internally by transaction() to ensure atomicity
// ─────────────────────────────────────────────────────────────

class MySQLScopedAdapter {

    constructor(conn) {
        this._conn   = conn;
        this.dialect = 'mysql';
    }

    get inTransaction() {
        return true;
    }

    async _exec(sql, params = []) {
        const flatParams = Array.isArray(params) ? params : (params !== undefined && params !== null ? [params] : []);
        if (flatParams.length === 0) {
            return await this._conn.query(sql);
        }
        try {
            return await this._conn.execute(sql, flatParams);
        } catch (err) {
            if (err && err.code === 'ER_UNSUPPORTED_PS') {
                return await this._conn.query(sql, flatParams);
            }
            throw err;
        }
    }

    async run(sql, params = []) {
        const [result] = await this._exec(sql, params);
        return {
            insertId:        result?.insertId ?? 0,
            affectedRows:    result?.affectedRows ?? 0,
            lastInsertRowid: result?.insertId ?? 0,
            changes:         result?.affectedRows ?? 0,
        };
    }

    async get(sql, params = []) {
        const [rows] = await this._exec(sql, params);
        return (Array.isArray(rows) ? rows[0] : null) ?? null;
    }

    async all(sql, params = []) {
        const [rows] = await this._exec(sql, params);
        return Array.isArray(rows) ? rows : [];
    }
}

module.exports = { MySQLAdapter, MySQLScopedAdapter };
