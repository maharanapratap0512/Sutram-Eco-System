// src/SysMigrator.js
// ─────────────────────────────────────────────────────────────
// Runs sutramEngine's own sys_ migrations.
// Uses sys_meta table for version tracking (NOT user_version pragma)
// Supports SQLite (synchronous) and MySQL (asynchronous).
// ─────────────────────────────────────────────────────────────

'use strict';

const sqliteMigrations = require('./migrations/sys.migrations');
const mysqlMigrations   = require('./migrations/sys.migrations.mysql');

class SysMigrator {

    constructor(coreOrDb) {
        this.target = coreOrDb;
        // Core object has .query/.run/.dialect; legacy callers may pass better-sqlite3 db or MySQLAdapter
        this.isCore = typeof coreOrDb?.query === 'function' && typeof coreOrDb?.dialect === 'string';
        this.dialect = this.isCore ? coreOrDb.dialect : (coreOrDb?.dialect === 'mysql' ? 'mysql' : 'sqlite');
        this.isAsync = this.dialect === 'mysql' || (typeof coreOrDb?.prepare !== 'function' && typeof coreOrDb?.run === 'function');
    }

    async run() {
        if (this.isAsync) {
            return await this._runMySQL();
        }
        return this._runSQLite();
    }

    // ─────────────────────────────────────────────────────────
    // SQLite Migration Runner
    // ─────────────────────────────────────────────────────────
    _runSQLite() {
        const db = this.isCore ? this.target.db : this.target;
        if (!db || typeof db.pragma !== 'function') {
            return;
        }

        // Step 1: ensure sys_meta exists
        db.pragma('foreign_keys = OFF');
        db.prepare(`
            CREATE TABLE IF NOT EXISTS sys_meta (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
        `).run();
        db.prepare(`
            INSERT OR IGNORE INTO sys_meta (key, value)
            VALUES ('engine_version', '0')
        `).run();
        db.pragma('foreign_keys = ON');

        // Step 2: read current engine version
        const currentVersion = Number(
            db.prepare(`SELECT value FROM sys_meta WHERE key = 'engine_version'`)
                .get()?.value ?? 0
        );
        const targetVersion = sqliteMigrations.length;

        console.log(`[sutramEngine] SQLite Migrations: v${currentVersion} → v${targetVersion}`);
        if (currentVersion >= targetVersion) return;

        // Step 3: run pending versions
        const pending = sqliteMigrations.slice(currentVersion);
        let version   = currentVersion;

        db.pragma('foreign_keys = OFF');
        try {
            for (const sqlList of pending) {
                version++;
                if (!Array.isArray(sqlList)) {
                    throw new Error(`[sutramEngine] Migration v${version} must be an array of SQL strings.`);
                }

                const runVersion = db.transaction(() => {
                    for (const sql of sqlList) {
                        try {
                            db.prepare(sql).run();
                        } catch (sqlErr) {
                            if (!/duplicate column name|already exists/i.test(sqlErr.message || '')) {
                                throw sqlErr;
                            }
                        }
                    }
                    db.prepare(
                        `UPDATE sys_meta SET value = ? WHERE key = 'engine_version'`
                    ).run(String(version));
                });

                try {
                    runVersion();
                    console.log(`[sutramEngine] ✓ sys migration v${version} applied`);
                } catch (err) {
                    throw new Error(`[sutramEngine] ✗ sys migration v${version} failed: ${err.message}`);
                }
            }
        } finally {
            db.pragma('foreign_keys = ON');
        }
    }

    // ─────────────────────────────────────────────────────────
    // MySQL Migration Runner (Async)
    // ─────────────────────────────────────────────────────────
    async _runMySQL() {
        const adapter = this.isCore ? this.target.adapter : this.target;
        if (!adapter || typeof adapter.run !== 'function') {
            return;
        }

        // Step 1: ensure sys_meta exists
        await adapter.run('SET FOREIGN_KEY_CHECKS = 0');
        await adapter.run(`
            CREATE TABLE IF NOT EXISTS sys_meta (
                \`key\`   VARCHAR(191) PRIMARY KEY,
                \`value\` TEXT NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        await adapter.run(`
            INSERT IGNORE INTO sys_meta (\`key\`, \`value\`) VALUES ('engine_version', '0')
        `);
        await adapter.run('SET FOREIGN_KEY_CHECKS = 1');

        // Step 2: read current engine version
        const row = await adapter.get(`SELECT \`value\` FROM sys_meta WHERE \`key\` = 'engine_version'`);
        const currentVersion = Number(row?.value ?? 0);
        const targetVersion = mysqlMigrations.length;

        console.log(`[sutramEngine] MySQL Migrations: v${currentVersion} → v${targetVersion}`);
        if (currentVersion >= targetVersion) return;

        // Step 3: run pending versions
        const pending = mysqlMigrations.slice(currentVersion);
        let version   = currentVersion;

        await adapter.run('SET FOREIGN_KEY_CHECKS = 0');
        try {
            for (const sqlList of pending) {
                version++;
                if (!Array.isArray(sqlList)) {
                    throw new Error(`[sutramEngine] Migration v${version} must be an array of SQL strings.`);
                }

                for (const sql of sqlList) {
                    try {
                        await adapter.run(sql);
                    } catch (sqlErr) {
                        // Tolerate existing index or duplicate column safely
                        if (!sqlErr.message?.includes('Duplicate column') && !sqlErr.message?.includes('Duplicate key')) {
                            console.warn(`[sutramEngine] Notice on v${version}: ${sqlErr.message}`);
                        }
                    }
                }

                await adapter.run(`UPDATE sys_meta SET \`value\` = ? WHERE \`key\` = 'engine_version'`, [String(version)]);
                console.log(`[sutramEngine] ✓ MySQL sys migration v${version} applied`);
            }
        } finally {
            await adapter.run('SET FOREIGN_KEY_CHECKS = 1');
        }
    }
}

module.exports = SysMigrator;
