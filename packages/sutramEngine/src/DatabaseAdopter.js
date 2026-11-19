/**
 * DatabaseAdopter.js — sutramEngine
 * ─────────────────────────────────────────────────────────────
 * Universal Non-Destructive Database Adoption Pipeline (Sutramization).
 * • Detects existing Sutram DB vs Raw SQLite DB.
 * • Safely injects sys_* metadata without altering user tables or data.
 * • Synchronizes any user tables from sqlite_master missing in sys_table.
 * • Auto-synthesizes sys_table, sys_column, and sys_join from live PRAGMAs.
 * • 100% domain-agnostic, zero hardcoded tables (Rule 12).
 * • Explicit transaction control (Rule 13).
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

const SysMigrator = require('./SysMigrator');
const SchemaHeuristics = require('./SchemaHeuristics');

class DatabaseAdopter {
  constructor(db) {
    if (!db || typeof db.prepare !== 'function') {
      throw new Error('[DatabaseAdopter] A valid better-sqlite3 Database instance is required.');
    }
    this.db = db;
  }

  /**
   * Adopts a database, reporting step-by-step progress via onProgress callback.
   * @param {Object} introspectedSchema - Output of SQLiteIntrospector.introspect()
   * @param {Object} adminCredentials - { username, password, displayName }
   * @param {Function} [onProgress] - (stepKey: string, message: string) => void
   * @returns {{ isSutram: boolean, adopted: boolean, adoptedCount: number, tablesCount: number, logs: string[] }}
   */
  adopt(introspectedSchema, adminCredentials = {}, onProgress = null) {
    const logs = [];
    const log = (step, msg) => {
      const line = `[${step}] ${msg}`;
      logs.push(line);
      console.log(`⚡ [DatabaseAdopter] ${line}`);
      if (typeof onProgress === 'function') {
        try {
          onProgress(step, msg);
        } catch (e) {}
      }
    };

    const cleanUsername = String(adminCredentials.username || 'admin').trim();
    const cleanPassword = adminCredentials.password ? String(adminCredentials.password).trim() : 'admin';
    const cleanDisplayName = adminCredentials.displayName || `${cleanUsername} Administrator`;

    // ── 1. Ensure Sys Migrations ─────────────────────────────────
    log('MIGRATE', 'Ensuring Sutram system schema is up to date...');
    new SysMigrator(this.db).run();

    // ── 2. Identify Registered vs Unregistered User Tables ───────
    const existingSysTables = new Set(
      this.db.prepare(`SELECT table_name FROM sys_table WHERE active = 1`).all().map(r => r.table_name)
    );

    const allUserTables = introspectedSchema.tables || [];
    const tablesToAdopt = allUserTables.filter(t => !existingSysTables.has(t.tableName));

    log('CHECK', `Database has ${allUserTables.length} user tables (${existingSysTables.size} registered, ${tablesToAdopt.length} to adopt).`);

    // ── 3. If All Tables Already Adopted ─────────────────────────
    if (tablesToAdopt.length === 0) {
      log('CHECK', 'All user tables are already registered in sys_table.');

      // Update admin user credentials if password was provided
      if (adminCredentials.password) {
        try {
          this.db.prepare(`
            INSERT INTO sys_user (username, password, display_name, role, active)
            VALUES (?, ?, ?, 'admin', 1)
            ON CONFLICT(username) DO UPDATE SET
              password = excluded.password,
              display_name = excluded.display_name,
              role = 'admin',
              active = 1
          `).run(cleanUsername, cleanPassword, cleanDisplayName);
          log('USER', `Updated project administrator (${cleanUsername}).`);
        } catch (err) {
          log('WARN', `Could not update admin in sys_user: ${err.message}`);
        }
      }

      log('SUCCESS', `Database ready with ${allUserTables.length} tables. Launching Studio...`);
      return {
        isSutram: true,
        adopted: false,
        adoptedCount: 0,
        tablesCount: allUserTables.length,
        logs
      };
    }

    // ── 4. Adopt Unregistered Tables into sys_* ───────────────────
    log('INTROSPECT', `Synthesizing ${tablesToAdopt.length} table schemas, columns, and foreign keys...`);

    // Pre-build map of table columns across all tables for descriptor inference
    const tableColsMap = new Map();
    for (const t of allUserTables) {
      tableColsMap.set(t.tableName, t.columns.map(c => c.name));
    }

    // Atomic Population of sys_table, sys_column, sys_join (Rule 13)
    const needTx = !this.db.inTransaction;
    try {
      if (needTx) this.db.prepare('BEGIN').run();

      let totalColumns = 0;
      let totalJoins = 0;

      const insertTableStmt = this.db.prepare(`
        INSERT INTO sys_table (table_name, label, description, is_system, active)
        VALUES (?, ?, ?, 0, 1)
        ON CONFLICT(table_name) DO UPDATE SET active = 1
      `);

      const getTableIdStmt = this.db.prepare(`SELECT _id FROM sys_table WHERE table_name = ?`);

      const insertColStmt = this.db.prepare(`
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

      const insertJoinStmt = this.db.prepare(`
        INSERT INTO sys_join (
          table_id, join_type, join_key, child_table, fk_col, target_col, as_name, select_cols, active
        ) VALUES (?, 'hasMany', ?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT(table_id, join_key) DO UPDATE SET active = 1
      `);

      for (const t of tablesToAdopt) {
        const tableLabel = t.tableName
          .replace(/[_\-]+/g, ' ')
          .replace(/\b\w/g, l => l.toUpperCase());

        insertTableStmt.run(t.tableName, tableLabel, `Imported table ${t.tableName}`);
        const tableId = getTableIdStmt.get(t.tableName)?._id;
        if (!tableId) continue;

        let sortOrder = 1;
        for (const col of t.columns) {
          const colName = col.name;
          const inferred = SchemaHeuristics.inferTypeFromName(colName);
          const colLabel = colName
            .replace(/[_\-]+/g, ' ')
            .replace(/\b\w/g, l => l.toUpperCase());

          const isPk = col.pk > 0 ? 1 : 0;
          const isRequired = (col.notnull === 1 && !isPk) ? 1 : (inferred.is_required ? 1 : 0);
          const defaultValue = col.dflt_value !== null ? String(col.dflt_value) : null;

          // Normalize col_type strictly to allowed sutramEngine types
          let colType = String(inferred.col_type || 'string').toLowerCase();
          if (!['number', 'string', 'boolean', 'json', 'date', 'datetime', 'password'].includes(colType)) {
            colType = 'string';
          }

          // Foreign Key resolution
          const matchedFk = (t.foreignKeys || []).find(fk => fk.from === colName);
          let refTable = null;
          let refCol = null;
          let refAs = null;
          let refSelect = null;

          if (matchedFk) {
            refTable = matchedFk.table;
            refCol = matchedFk.to || '_id';
            refAs = colName.replace(/_(id|fk|ref)$/, '') || refTable;

            const targetCols = tableColsMap.get(refTable) || [];
            const descriptors = SchemaHeuristics.inferCandidateDisplayColumns(targetCols);
            refSelect = JSON.stringify(descriptors.length > 0 ? descriptors : ['*']);
          }

          insertColStmt.run(
            tableId,
            colName,
            colLabel,
            colType,
            isRequired,
            defaultValue,
            isPk,
            refTable,
            refCol,
            refAs,
            refSelect,
            sortOrder
          );

          sortOrder++;
          totalColumns++;
        }

        // Map reverse hasMany joins into target parent tables
        for (const fk of (t.foreignKeys || [])) {
          const parentTableId = getTableIdStmt.get(fk.table)?._id;
          if (parentTableId) {
            const joinKey = `${t.tableName}_list`;
            const asName = `${t.tableName}_list`;
            insertJoinStmt.run(
              parentTableId,
              joinKey,
              t.tableName,
              fk.from,
              fk.to || '_id',
              asName,
              '["*"]'
            );
            totalJoins++;
          }
        }
      }

      // Configure Administrator in sys_user
      this.db.prepare(`
        INSERT INTO sys_user (username, password, display_name, role, active)
        VALUES (?, ?, ?, 'admin', 1)
        ON CONFLICT(username) DO UPDATE SET
          password = excluded.password,
          display_name = excluded.display_name,
          role = 'admin',
          active = 1
      `).run(cleanUsername, cleanPassword, cleanDisplayName);

      if (needTx) this.db.prepare('COMMIT').run();

      log('HEURISTICS', `Successfully adopted ${tablesToAdopt.length} tables, ${totalColumns} columns, and ${totalJoins} joins.`);
      log('USER', `Configured project administrator (${cleanUsername}) in sys_user.`);
      log('SUCCESS', `Adoption complete! Total active tables: ${allUserTables.length}.`);

      return {
        isSutram: introspectedSchema.isSutram,
        adopted: true,
        adoptedCount: tablesToAdopt.length,
        tablesCount: allUserTables.length,
        columnsCount: totalColumns,
        joinsCount: totalJoins,
        logs
      };

    } catch (err) {
      if (needTx && this.db.inTransaction) {
        this.db.prepare('ROLLBACK').run();
      }
      log('ERROR', `Adoption failed: ${err.message}`);
      throw err;
    }
  }
}

module.exports = DatabaseAdopter;
