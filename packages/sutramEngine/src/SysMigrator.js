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

    constructor(dbOrAdapter) {
        this.target = dbOrAdapter;
        // Determine whether target is an async adapter (mysql2) or synchronous better-sqlite3 instance
        this.isAsync = typeof dbOrAdapter?.prepare !== 'function' && typeof dbOrAdapter?.run === 'function';
    }

    run() {
        if (this.isAsync) {
            return this._runMySQL();
        }
        return this._runSQLite();
    }

    // ─────────────────────────────────────────────────────────
    // SQLite Migration Runner (100% backward compatible sync)
    // ─────────────────────────────────────────────────────────
    _runSQLite() {
        const db = this.target;

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
                        db.prepare(sql).run();
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
        const adapter = this.target;

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
