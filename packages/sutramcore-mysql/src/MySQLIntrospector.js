/**
 * MySQLIntrospector.js — sutramcore-mysql
 * ─────────────────────────────────────────────────────────────
 * Pure, driver-native MySQL schema introspection using mysql2.
 * • 100% database-agnostic, zero HisabKitab assumptions (Rule 12).
 * • Detects existing Sutram metadata signatures (sys_meta, sys_table).
 * • Extracts tables, columns, constraints, and foreign key relations.
 * • Lists available databases on server for instant discovery dropdown.
 * • Zero-trace cleanup: Completely purges all sys_* tables on request.
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

class MySQLIntrospector {
  /**
   * Helper to require mysql2/promise safely.
   */
  static _requireMySQL2() {
    try {
      return require('mysql2/promise');
    } catch {
      throw new Error('[sutramcore-mysql] mysql2 not installed. Run: npm install mysql2');
    }
  }

  /**
   * Connects to MySQL server to list available user databases.
   * @param {{ host: string, port?: number, user: string, password?: string }} config
   * @returns {Promise<Array<{ name: string, isSutram: boolean, tableCount: number }>>}
   */
  static async listDatabases(config = {}) {
    const mysql = this._requireMySQL2();
    const conn = await mysql.createConnection({
      host: config.host || 'localhost',
      port: Number(config.port || 3306),
      user: config.user || 'root',
      password: config.password || '',
      dateStrings: true,
      supportBigNumbers: true
    });

    try {
      const [rows] = await conn.execute(`
        SELECT SCHEMA_NAME as db_name
        FROM information_schema.SCHEMATA
        WHERE SCHEMA_NAME NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
        ORDER BY SCHEMA_NAME ASC
      `);

      const databases = [];
      for (const row of rows) {
        const dbName = row.db_name;
        try {
          const [tableRows] = await conn.execute(`
            SELECT TABLE_NAME as name
            FROM information_schema.TABLES
            WHERE TABLE_SCHEMA = ?
          `, [dbName]);

          const tableNames = new Set(tableRows.map(r => r.name));
          const isSutram = tableNames.has('sys_meta') && tableNames.has('sys_table');
          const userTables = tableRows.filter(r => !r.name.startsWith('sys_') && !r.name.startsWith('xls_'));

          databases.push({
            name: dbName,
            isSutram,
            tableCount: userTables.length
          });
        } catch {
          databases.push({
            name: dbName,
            isSutram: false,
            tableCount: 0
          });
        }
      }

      return databases;
    } finally {
      await conn.end();
    }
  }

  /**
   * Checks whether the given MySQL database has already been Sutram-enabled.
   * @param {import('./MySQLAdapter').MySQLAdapter} adapter
   * @param {string} [databaseName]
   * @returns {Promise<{ isSutram: boolean, engineVersion: number }>}
   */
  static async checkIsSutram(adapter, databaseName = null) {
    if (!adapter || typeof adapter.all !== 'function') {
      throw new Error('[MySQLIntrospector] A valid MySQLAdapter instance is required.');
    }

    const dbName = databaseName || adapter._config?.database;
    try {
      const rows = await adapter.all(`
        SELECT TABLE_NAME as name
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN ('sys_meta', 'sys_table')
      `, [dbName]);

      const found = new Set(rows.map(r => r.name));
      if (!found.has('sys_meta') || !found.has('sys_table')) {
        return { isSutram: false, engineVersion: 0 };
      }

      const versionRow = await adapter.get(`
        SELECT value FROM \`sys_meta\` WHERE \`key\` = 'engine_version'
      `);

      return {
        isSutram: true,
        engineVersion: Number(versionRow?.value || 0)
      };
    } catch {
      return { isSutram: false, engineVersion: 0 };
    }
  }

  /**
   * Introspects physical tables, columns, row counts, and foreign keys.
   * @param {import('./MySQLAdapter').MySQLAdapter} adapter
   * @param {string} [databaseName]
   * @returns {Promise<{
   *   isSutram: boolean,
   *   engineVersion: number,
   *   tablesCount: number,
   *   tables: Array<{
   *     tableName: string,
   *     rowCount: number,
   *     columns: Array<{ name: string, type: string, notnull: number, dflt_value: any, pk: number }>,
   *     foreignKeys: Array<{ id: number, table: string, from: string, to: string }>
   *   }>
   * }>}
   */
  static async introspect(adapter, databaseName = null) {
    const dbName = databaseName || adapter._config?.database;
    const sutramCheck = await this.checkIsSutram(adapter, dbName);

    // Query non-system tables
    const tableRows = await adapter.all(`
      SELECT TABLE_NAME as name, TABLE_ROWS as estimated_rows
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME NOT LIKE 'sys_%'
        AND TABLE_NAME NOT LIKE 'xls_%'
        AND TABLE_TYPE = 'BASE TABLE'
      ORDER BY TABLE_NAME ASC
    `, [dbName]);

    const tables = [];

    for (const row of tableRows) {
      const tableName = row.name;

      // 1. Column info (mapped to SQLite-compatible structure for parity)
      let columns = [];
      try {
        const colRows = await adapter.all(`
          SELECT 
            COLUMN_NAME as name,
            COLUMN_TYPE as type,
            DATA_TYPE as data_type,
            CHARACTER_MAXIMUM_LENGTH as max_len,
            IS_NULLABLE as is_nullable,
            COLUMN_DEFAULT as dflt_value,
            COLUMN_KEY as col_key,
            EXTRA as extra
          FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
          ORDER BY ORDINAL_POSITION ASC
        `, [dbName, tableName]);

        columns = colRows.map(c => ({
          name: c.name,
          type: c.type,
          notnull: c.is_nullable === 'NO' ? 1 : 0,
          dflt_value: c.dflt_value,
          pk: c.col_key === 'PRI' ? 1 : 0
        }));
      } catch {
        columns = [];
      }

      // 2. Foreign keys from KEY_COLUMN_USAGE & REFERENTIAL_CONSTRAINTS
      let foreignKeys = [];
      try {
        const fkRows = await adapter.all(`
          SELECT 
            k.CONSTRAINT_NAME as constraint_name,
            k.COLUMN_NAME as from_col,
            k.REFERENCED_TABLE_NAME as ref_table,
            k.REFERENCED_COLUMN_NAME as ref_col
          FROM information_schema.KEY_COLUMN_USAGE k
          WHERE k.TABLE_SCHEMA = ?
            AND k.TABLE_NAME = ?
            AND k.REFERENCED_TABLE_NAME IS NOT NULL
          ORDER BY k.ORDINAL_POSITION ASC
        `, [dbName, tableName]);

        foreignKeys = fkRows.map((fk, idx) => ({
          id: idx,
          table: fk.ref_table,
          from: fk.from_col,
          to: fk.ref_col
        }));
      } catch {
        foreignKeys = [];
      }

      // 3. Row count
      let rowCount = 0;
      try {
        const countRes = await adapter.get(`SELECT COUNT(*) as count FROM \`${tableName}\``);
        rowCount = Number(countRes?.count ?? row.estimated_rows ?? 0);
      } catch {
        rowCount = Number(row.estimated_rows || 0);
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
   * Completely purges all Sutram system tables (sys_*) leaving the database spotless.
   * @param {import('./MySQLAdapter').MySQLAdapter} adapter
   * @param {string} [databaseName]
   * @returns {Promise<{ success: boolean, purgedCount: number, purgedTables: string[] }>}
   */
  static async purgeSutram(adapter, databaseName = null) {
    const dbName = databaseName || adapter._config?.database;
    const sysRows = await adapter.all(`
      SELECT TABLE_NAME as name
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME LIKE 'sys_%'
    `, [dbName]);

    const purgedTables = [];
    if (sysRows.length === 0) {
      return { success: true, purgedCount: 0, purgedTables: [] };
    }

    await adapter.run('SET FOREIGN_KEY_CHECKS = 0');
    try {
      for (const row of sysRows) {
        await adapter.run(`DROP TABLE IF EXISTS \`${row.name}\``);
        purgedTables.push(row.name);
      }
    } finally {
      await adapter.run('SET FOREIGN_KEY_CHECKS = 1');
    }

    console.log(`🧹 [MySQLIntrospector] Successfully purged ${purgedTables.length} Sutram system table(s) from "${dbName}".`);
    return {
      success: true,
      purgedCount: purgedTables.length,
      purgedTables
    };
  }

  /**
   * Clones an existing MySQL database (schema + data) into a new target database.
   * @param {import('./MySQLAdapter').MySQLAdapter} adapter
   * @param {string} sourceDb
   * @param {string} targetDb
   * @returns {Promise<{ success: boolean, clonedTables: number, targetDb: string }>}
   */
  static async cloneDatabase(adapter, sourceDb, targetDb) {
    if (!sourceDb || !targetDb) {
      throw new Error('Both sourceDb and targetDb are required to clone a database.');
    }
    if (sourceDb === targetDb) {
      throw new Error(`Target database "${targetDb}" cannot have the same name as source database.`);
    }

    await adapter.run(`CREATE DATABASE IF NOT EXISTS \`${targetDb}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);

    const tableRows = await adapter.all(`
      SELECT TABLE_NAME as name
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
      ORDER BY TABLE_NAME ASC
    `, [sourceDb]);

    await adapter.run('SET FOREIGN_KEY_CHECKS = 0');
    try {
      for (const t of tableRows) {
        const tbl = t.name;
        await adapter.run(`CREATE TABLE IF NOT EXISTS \`${targetDb}\`.\`${tbl}\` LIKE \`${sourceDb}\`.\`${tbl}\``);
        await adapter.run(`INSERT INTO \`${targetDb}\`.\`${tbl}\` SELECT * FROM \`${sourceDb}\`.\`${tbl}\``);
      }
    } finally {
      await adapter.run('SET FOREIGN_KEY_CHECKS = 1');
    }

    console.log(`📦 [MySQLIntrospector] Successfully cloned database "${sourceDb}" -> "${targetDb}" (${tableRows.length} tables).`);
    return {
      success: true,
      clonedTables: tableRows.length,
      targetDb
    };
  }
}

module.exports = MySQLIntrospector;
