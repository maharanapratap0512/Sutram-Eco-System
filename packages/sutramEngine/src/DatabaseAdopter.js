/**
 * DatabaseAdopter.js — sutramEngine
 * ─────────────────────────────────────────────────────────────
 * Universal Non-Destructive Database Adoption Pipeline (Sutramization).
 * • Detects existing Sutram DB vs Raw Database.
 * • Safely injects sys_* metadata without altering user tables or data.
 * • Synchronizes any user tables missing in sys_table.
 * • Auto-synthesizes sys_table, sys_column, and sys_join from live schemas.
 * • Supports both SQLite and MySQL natively.
 * • 100% domain-agnostic, zero hardcoded tables (Rule 12).
 * • Explicit transaction control (Rule 13).
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

const SysMigrator = require('./SysMigrator');
const SchemaHeuristics = require('./SchemaHeuristics');
const AuthManager = require('./AuthManager');

class DatabaseAdopter {
  constructor(dbOrAdapter) {
    if (!dbOrAdapter) {
      throw new Error('[DatabaseAdopter] A valid database connection instance is required.');
    }
    this.target = dbOrAdapter;
    this.isAsync = typeof dbOrAdapter.prepare !== 'function' && typeof dbOrAdapter.run === 'function';
  }

  /**
   * Adopts a database, reporting step-by-step progress via onProgress callback.
   * Dispatches to sync SQLite or async MySQL based on target driver.
   */
  adopt(introspectedSchema, adminCredentials = {}, onProgress = null) {
    if (this.isAsync) {
      return this.adoptAsync(introspectedSchema, adminCredentials, onProgress);
    }
    return this._adoptSQLite(introspectedSchema, adminCredentials, onProgress);
  }

  // ─────────────────────────────────────────────────────────────
  // SQLite Adoption (Synchronous)
  // ─────────────────────────────────────────────────────────────
  _adoptSQLite(introspectedSchema, adminCredentials = {}, onProgress = null) {
    const db = this.target;
    const logs = [];
    const log = (step, msg) => {
      const line = `[${step}] ${msg}`;
      logs.push(line);
      console.log(`⚡ [DatabaseAdopter] ${line}`);
      if (typeof onProgress === 'function') {
        try { onProgress(step, msg); } catch {}
      }
    };

    const cleanUsername = String(adminCredentials.username || 'admin').trim();
    const hasExplicitPass = Object.prototype.hasOwnProperty.call(adminCredentials || {}, 'password') &&
      adminCredentials.password !== undefined && adminCredentials.password !== null;
    const rawPass = hasExplicitPass ? String(adminCredentials.password).trim() : 'admin';
    const hashedPass = AuthManager.hashPassword(rawPass);
    const adminMisc = AuthManager.stringifyMisc({ can_ocr: 1, is_blank_password: rawPass === '' });
    const cleanDisplayName = adminCredentials.displayName || `${cleanUsername} Administrator`;

    // 1. Ensure Sys Migrations
    log('MIGRATE', 'Ensuring Sutram system schema is up to date...');
    new SysMigrator(db).run();

    // 2. Identify Registered vs Unregistered User Tables
    const existingSysTables = new Set(
      db.prepare(`SELECT table_name FROM sys_table WHERE active = 1`).all().map(r => r.table_name)
    );

    const allUserTables = introspectedSchema.tables || [];
    const tablesToAdopt = allUserTables.filter(t => !existingSysTables.has(t.tableName));

    log('CHECK', `Database has ${allUserTables.length} user tables (${existingSysTables.size} registered, ${tablesToAdopt.length} to adopt).`);

    if (tablesToAdopt.length === 0) {
      log('CHECK', 'All user tables are already registered in sys_table.');
      if (hasExplicitPass) {
        try {
          db.prepare(`
            INSERT INTO sys_user (username, password, display_name, role, active, misc_settings)
            VALUES (?, ?, ?, 'admin', 1, ?)
            ON CONFLICT(username) DO UPDATE SET
              password = excluded.password,
              display_name = excluded.display_name,
              role = 'admin',
              active = 1,
              misc_settings = excluded.misc_settings
          `).run(cleanUsername, hashedPass, cleanDisplayName, adminMisc);
          log('USER', `Updated project administrator (${cleanUsername}).`);
        } catch (err) {
          log('WARN', `Could not update admin in sys_user: ${err.message}`);
        }
      }
      return { isSutram: true, adopted: false, adoptedCount: 0, tablesCount: allUserTables.length, logs };
    }

    log('INTROSPECT', `Synthesizing ${tablesToAdopt.length} table schemas, columns, and foreign keys...`);
    const tableColsMap = new Map();
    for (const t of allUserTables) {
      tableColsMap.set(t.tableName, t.columns.map(c => c.name));
    }

    const needTx = !db.inTransaction;
    try {
      if (needTx) db.prepare('BEGIN').run();

      let totalColumns = 0;
      let totalJoins = 0;

      const insertTableStmt = db.prepare(`
        INSERT INTO sys_table (table_name, label, description, is_system, active)
        VALUES (?, ?, ?, 0, 1)
        ON CONFLICT(table_name) DO UPDATE SET active = 1
      `);
      const getTableIdStmt = db.prepare(`SELECT _id FROM sys_table WHERE table_name = ?`);
      const insertColStmt = db.prepare(`
        INSERT INTO sys_column (
          table_id, column_name, label, col_type, is_required, default_value,
          is_pk, ref_table, ref_col, ref_as, ref_select, sort_order, active
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT(table_id, column_name) DO UPDATE SET
          col_type = excluded.col_type,
          ref_table = excluded.ref_table,
          ref_col = excluded.ref_col,
          ref_as = excluded.ref_as,
          ref_select = excluded.ref_select,
          active = 1
      `);
      const insertJoinStmt = db.prepare(`
        INSERT INTO sys_join (
          table_id, join_type, join_key, child_table, fk_col, target_col, as_name, select_cols, active
        ) VALUES (?, 'hasMany', ?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT(table_id, join_key) DO UPDATE SET active = 1
      `);

      for (const t of tablesToAdopt) {
        const tableLabel = t.tableName.replace(/[_\-]+/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
        insertTableStmt.run(t.tableName, tableLabel, `Imported table ${t.tableName}`);
        const tableId = getTableIdStmt.get(t.tableName)?._id;
        if (!tableId) continue;

        let sortOrder = 1;
        for (const col of t.columns) {
          const colName = col.name;
          const inferred = SchemaHeuristics.inferTypeFromName(colName);
          const colLabel = colName.replace(/[_\-]+/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
          const isPk = col.pk > 0 ? 1 : 0;
          const isRequired = (col.notnull === 1 && !isPk) ? 1 : (inferred.is_required ? 1 : 0);
          const defaultValue = col.dflt_value !== null ? String(col.dflt_value) : null;

          let colType = String(inferred.col_type || 'string').toLowerCase();
          if (!['number', 'string', 'boolean', 'json', 'date', 'datetime', 'password'].includes(colType)) {
            colType = 'string';
          }

          const matchedFk = (t.foreignKeys || []).find(fk => fk.from === colName);
          let refTable = null, refCol = null, refAs = null, refSelect = null;
          if (matchedFk) {
            refTable = matchedFk.table;
            refCol = matchedFk.to || '_id';
            refAs = colName.replace(/_(id|fk|ref)$/, '') || refTable;
            const targetCols = tableColsMap.get(refTable) || [];
            const descriptors = SchemaHeuristics.inferCandidateDisplayColumns(targetCols);
            refSelect = JSON.stringify(descriptors.length > 0 ? descriptors : ['*']);
          }

          insertColStmt.run(tableId, colName, colLabel, colType, isRequired, defaultValue, isPk, refTable, refCol, refAs, refSelect, sortOrder);
          sortOrder++;
          totalColumns++;
        }

        for (const fk of (t.foreignKeys || [])) {
          const parentTableId = getTableIdStmt.get(fk.table)?._id;
          if (parentTableId) {
            insertJoinStmt.run(parentTableId, `${t.tableName}_list`, t.tableName, fk.from, fk.to || '_id', `${t.tableName}_list`, '["*"]');
            totalJoins++;
          }
        }
      }

      db.prepare(`
        INSERT INTO sys_user (username, password, display_name, role, active, misc_settings)
        VALUES (?, ?, ?, 'admin', 1, ?)
        ON CONFLICT(username) DO UPDATE SET
          password = excluded.password,
          display_name = excluded.display_name,
          role = 'admin',
          active = 1,
          misc_settings = excluded.misc_settings
      `).run(cleanUsername, hashedPass, cleanDisplayName, adminMisc);

      if (needTx) db.prepare('COMMIT').run();
      log('SUCCESS', `Adoption complete! Total active tables: ${allUserTables.length}.`);
      return { isSutram: introspectedSchema.isSutram, adopted: true, adoptedCount: tablesToAdopt.length, tablesCount: allUserTables.length, columnsCount: totalColumns, joinsCount: totalJoins, logs };
    } catch (err) {
      if (needTx && db.inTransaction) db.prepare('ROLLBACK').run();
      log('ERROR', `Adoption failed: ${err.message}`);
      throw err;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // MySQL Adoption (Asynchronous)
  // ─────────────────────────────────────────────────────────────
  async adoptAsync(introspectedSchema, adminCredentials = {}, onProgress = null) {
    const adapter = this.target.adapter || this.target;
    const logs = [];
    const log = (step, msg) => {
      const line = `[${step}] ${msg}`;
      logs.push(line);
      console.log(`⚡ [DatabaseAdopter-MySQL] ${line}`);
      if (typeof onProgress === 'function') {
        try { onProgress(step, msg); } catch {}
      }
    };

    const cleanUsername = String(adminCredentials.username || 'admin').trim();
    const hasExplicitPass = Object.prototype.hasOwnProperty.call(adminCredentials || {}, 'password') &&
      adminCredentials.password !== undefined && adminCredentials.password !== null;
    const rawPass = hasExplicitPass ? String(adminCredentials.password).trim() : 'admin';
    const hashedPass = AuthManager.hashPassword(rawPass);
    const adminMisc = AuthManager.stringifyMisc({ can_ocr: 1, is_blank_password: rawPass === '' });
    const cleanDisplayName = adminCredentials.displayName || `${cleanUsername} Administrator`;

    // 1. Ensure Sys Migrations
    log('MIGRATE', 'Ensuring Sutram system schema is up to date in MySQL...');
    await new SysMigrator(adapter).run();

    // 2. Identify Registered vs Unregistered User Tables
    const sysRows = await adapter.all(`SELECT table_name FROM sys_table WHERE active = 1`);
    const existingSysTables = new Set(sysRows.map(r => r.table_name));

    const allUserTables = introspectedSchema.tables || [];
    const tablesToAdopt = allUserTables.filter(t => !existingSysTables.has(t.tableName));

    log('CHECK', `MySQL Database has ${allUserTables.length} user tables (${existingSysTables.size} registered, ${tablesToAdopt.length} to adopt).`);

    if (tablesToAdopt.length === 0) {
      log('CHECK', 'All user tables are already registered in sys_table.');
      if (hasExplicitPass) {
        try {
          await adapter.run(`
            INSERT INTO sys_user (username, password, display_name, role, active, misc_settings)
            VALUES (?, ?, ?, 'admin', 1, ?)
            ON DUPLICATE KEY UPDATE
              password = VALUES(password),
              display_name = VALUES(display_name),
              role = 'admin',
              active = 1,
              misc_settings = VALUES(misc_settings)
          `, [cleanUsername, hashedPass, cleanDisplayName, adminMisc]);
          log('USER', `Updated project administrator (${cleanUsername}).`);
        } catch (err) {
          log('WARN', `Could not update admin in sys_user: ${err.message}`);
        }
      }
      return { isSutram: true, adopted: false, adoptedCount: 0, tablesCount: allUserTables.length, logs };
    }

    log('INTROSPECT', `Synthesizing ${tablesToAdopt.length} table schemas, columns, and foreign keys...`);
    const tableColsMap = new Map();
    for (const t of allUserTables) {
      tableColsMap.set(t.tableName, t.columns.map(c => c.name));
    }

    let totalColumns = 0;
    let totalJoins = 0;

    for (const t of tablesToAdopt) {
      const tableLabel = t.tableName.replace(/[_\-]+/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
      await adapter.run(`
        INSERT INTO sys_table (table_name, label, description, is_system, active)
        VALUES (?, ?, ?, 0, 1)
        ON DUPLICATE KEY UPDATE active = 1
      `, [t.tableName, tableLabel, `Imported table ${t.tableName}`]);

      const tableRow = await adapter.get(`SELECT _id FROM sys_table WHERE table_name = ?`, [t.tableName]);
      const tableId = tableRow?._id;
      if (!tableId) continue;

      let sortOrder = 1;
      for (const col of t.columns) {
        const colName = col.name;
        const inferred = SchemaHeuristics.inferTypeFromName(colName);
        const colLabel = colName.replace(/[_\-]+/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
        const isPk = col.pk > 0 ? 1 : 0;
        const isRequired = (col.notnull === 1 && !isPk) ? 1 : (inferred.is_required ? 1 : 0);
        const defaultValue = col.dflt_value !== null ? String(col.dflt_value) : null;

        let colType = String(inferred.col_type || 'string').toLowerCase();
        if (!['number', 'string', 'boolean', 'json', 'date', 'datetime', 'password'].includes(colType)) {
          colType = 'string';
        }

        const matchedFk = (t.foreignKeys || []).find(fk => fk.from === colName);
        let refTable = null, refCol = null, refAs = null, refSelect = null;
        if (matchedFk) {
          refTable = matchedFk.table;
          refCol = matchedFk.to || '_id';
          refAs = colName.replace(/_(id|fk|ref)$/, '') || refTable;
          const targetCols = tableColsMap.get(refTable) || [];
          const descriptors = SchemaHeuristics.inferCandidateDisplayColumns(targetCols);
          refSelect = JSON.stringify(descriptors.length > 0 ? descriptors : ['*']);
        }

        await adapter.run(`
          INSERT INTO sys_column (
            table_id, column_name, label, col_type, is_required, default_value,
            is_pk, ref_table, ref_col, ref_as, ref_select, sort_order, active
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
          ON DUPLICATE KEY UPDATE
            col_type = VALUES(col_type),
            ref_table = VALUES(ref_table),
            ref_col = VALUES(ref_col),
            ref_as = VALUES(ref_as),
            ref_select = VALUES(ref_select),
            active = 1
        `, [tableId, colName, colLabel, colType, isRequired, defaultValue, isPk, refTable, refCol, refAs, refSelect, sortOrder]);

        sortOrder++;
        totalColumns++;
      }

      for (const fk of (t.foreignKeys || [])) {
        const parentRow = await adapter.get(`SELECT _id FROM sys_table WHERE table_name = ?`, [fk.table]);
        if (parentRow?._id) {
          await adapter.run(`
            INSERT INTO sys_join (
              table_id, join_type, join_key, child_table, fk_col, target_col, as_name, select_cols, active
            ) VALUES (?, 'hasMany', ?, ?, ?, ?, ?, ?, 1)
            ON DUPLICATE KEY UPDATE active = 1
          `, [parentRow._id, `${t.tableName}_list`, t.tableName, fk.from, fk.to || '_id', `${t.tableName}_list`, '["*"]']);
          totalJoins++;
        }
      }
    }

    await adapter.run(`
      INSERT INTO sys_user (username, password, display_name, role, active, misc_settings)
      VALUES (?, ?, ?, 'admin', 1, ?)
      ON DUPLICATE KEY UPDATE
        password = VALUES(password),
        display_name = VALUES(display_name),
        role = 'admin',
        active = 1,
        misc_settings = VALUES(misc_settings)
    `, [cleanUsername, hashedPass, cleanDisplayName, adminMisc]);

    log('SUCCESS', `MySQL Adoption complete! Total active tables: ${allUserTables.length}.`);
    return {
      isSutram: introspectedSchema.isSutram,
      adopted: true,
      adoptedCount: tablesToAdopt.length,
      tablesCount: allUserTables.length,
      columnsCount: totalColumns,
      joinsCount: totalJoins,
      logs
    };
  }
}

module.exports = DatabaseAdopter;
