/**
 * SQLiteIntrospector.js — sutramcore
 * ─────────────────────────────────────────────────────────────
 * Pure, driver-native SQLite schema introspection using better-sqlite3.
 * • 100% database-agnostic, zero HisabKitab assumptions (Rule 12).
 * • Detects existing Sutram metadata signatures (sys_meta, sys_table).
 * • Extracts tables, columns, constraints, and foreign key relations.
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

class SQLiteIntrospector {
  /**
   * Checks whether the given SQLite database has already been Sutram-enabled.
   * @param {import('better-sqlite3').Database} db
   * @returns {{ isSutram: boolean, engineVersion: number }}
   */
  static checkIsSutram(db) {
    if (!db || typeof db.prepare !== 'function') {
      throw new Error('[SQLiteIntrospector] A valid better-sqlite3 instance is required.');
    }

    try {
      const hasSysMeta = db.prepare(`
        SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sys_meta'
      `).get();

      const hasSysTable = db.prepare(`
        SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sys_table'
      `).get();

      if (!hasSysMeta || !hasSysTable) {
        return { isSutram: false, engineVersion: 0 };
      }

      const versionRow = db.prepare(`
        SELECT value FROM sys_meta WHERE key = 'engine_version'
      `).get();

      return {
        isSutram: true,
        engineVersion: Number(versionRow?.value || 0)
      };
    } catch (err) {
      return { isSutram: false, engineVersion: 0 };
    }
  }

  /**
   * Introspects physical tables, columns, rows count, and foreign keys.
   * @param {import('better-sqlite3').Database} db
   * @returns {{
   *   isSutram: boolean,
   *   engineVersion: number,
   *   tablesCount: number,
   *   tables: Array<{
   *     tableName: string,
   *     rowCount: number,
   *     columns: Array<{ name: string, type: string, notnull: number, dflt_value: any, pk: number }>,
   *     foreignKeys: Array<{ id: number, table: string, from: string, to: string }>
   *   }>
   * }}
   */
  static introspect(db) {
    const sutramCheck = this.checkIsSutram(db);

    // Query non-system tables
    const tableRows = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
        AND name NOT LIKE 'sys_%'
        AND name NOT LIKE 'xls_%'
      ORDER BY name ASC
    `).all();

    const tables = [];

    for (const row of tableRows) {
      const tableName = row.name;

      // 1. Column info via PRAGMA table_info
      let columns = [];
      try {
        columns = db.prepare(`PRAGMA table_info("${tableName}")`).all();
      } catch (e) {
        columns = [];
      }

      // 2. Foreign keys via PRAGMA foreign_key_list
      let foreignKeys = [];
      try {
        foreignKeys = db.prepare(`PRAGMA foreign_key_list("${tableName}")`).all();
      } catch (e) {
        foreignKeys = [];
      }

      // 3. Row count
      let rowCount = 0;
      try {
        const countRes = db.prepare(`SELECT COUNT(*) as count FROM "${tableName}"`).get();
        rowCount = countRes?.count || 0;
      } catch (e) {
        rowCount = 0;
      }

      tables.push({
        tableName,
        rowCount,
        columns,
        foreignKeys
      });
    }

    return {
      isSutram: sutramCheck.isSutram,
      engineVersion: sutramCheck.engineVersion,
      tablesCount: tables.length,
      tables
    };
  }

  /**
   * Completely purges all Sutram system tables (sys_*) leaving the SQLite database spotless.
   * @param {import('better-sqlite3').Database} db
   * @returns {{ success: boolean, purgedCount: number, purgedTables: string[] }}
   */
  static purgeSutram(db) {
    if (!db || typeof db.prepare !== 'function') {
      throw new Error('[SQLiteIntrospector] A valid better-sqlite3 instance is required.');
    }

    const sysRows = db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'sys_%'
    `).all();

    const purgedTables = [];
    if (sysRows.length === 0) {
      return { success: true, purgedCount: 0, purgedTables: [] };
    }

    db.pragma('foreign_keys = OFF');
    try {
      for (const row of sysRows) {
        db.prepare(`DROP TABLE IF EXISTS "${row.name}"`).run();
        purgedTables.push(row.name);
      }
    } finally {
      db.pragma('foreign_keys = ON');
    }

    console.log(`🧹 [SQLiteIntrospector] Successfully purged ${purgedTables.length} Sutram system table(s).`);
    return {
      success: true,
      purgedCount: purgedTables.length,
      purgedTables
    };
  }
}

module.exports = SQLiteIntrospector;
