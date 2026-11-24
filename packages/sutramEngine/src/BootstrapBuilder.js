// src/BootstrapBuilder.js
// ─────────────────────────────────────────────────────────────
// Reads sys_table, sys_column, sys_join from database (SQLite or MySQL)
// and builds the tableMeta object that sutramCore's Sutram expects.
// ─────────────────────────────────────────────────────────────

'use strict';

class BootstrapBuilder {

    constructor(dbOrAdapter) {
        this.db = dbOrAdapter;
        this.isAsync = typeof dbOrAdapter?.prepare !== 'function' && (typeof dbOrAdapter?.all === 'function' || typeof dbOrAdapter?.adapter?.all === 'function');
    }

    // ── Main entry point (sync for SQLite, async for MySQL) ─────
    build() {
        if (this.isAsync) {
            return this.buildAsync();
        }
        const tables  = this._loadTables();
        const columns = this._loadColumns();
        const joins   = this._loadJoins();

        // Build set of physically existing active tables so dangling FKs never crash the app
        const physicalTables = new Set(
            this.db.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table', 'view')`).all().map(r => r.name)
        );
        const activeTables = new Set(
            tables.map(t => t.table_name).filter(name => physicalTables.has(name))
        );

        const meta = {};

        for (const table of tables) {
            if (!physicalTables.has(table.table_name)) continue;
            const tableCols = columns.filter(c => c.table_id === table._id);
            const tableJoins = joins.filter(j => j.table_id === table._id);

            meta[table.table_name] = {
                columns: this._buildColumns(tableCols, activeTables, table.table_name),
                joins:   this._buildJoins(tableJoins, activeTables),
            };
        }

        return meta;
    }

    async buildAsync() {
        const adapter = this.db.adapter || this.db;
        const tables = await adapter.all(`SELECT * FROM sys_table WHERE active = 1 ORDER BY _id ASC`);
        const columns = await adapter.all(`
            SELECT c.* FROM sys_column c
            INNER JOIN sys_table t ON t._id = c.table_id
            WHERE c.active = 1 AND t.active = 1
            ORDER BY c.table_id ASC, c.sort_order ASC, c._id ASC
        `);
        const joins = await adapter.all(`
            SELECT j.* FROM sys_join j
            INNER JOIN sys_table t ON t._id = j.table_id
            WHERE j.active = 1 AND t.active = 1
            ORDER BY j.table_id ASC, j._id ASC
        `);

        const physRows = await adapter.all(`
            SELECT TABLE_NAME as name FROM information_schema.TABLES
            WHERE TABLE_SCHEMA = DATABASE()
        `);
        const physicalTables = new Set(physRows.map(r => r.name));
        const activeTables = new Set(
            tables.map(t => t.table_name).filter(name => physicalTables.has(name))
        );

        const meta = {};

        for (const table of tables) {
            if (!physicalTables.has(table.table_name)) continue;
            const tableCols = columns.filter(c => c.table_id === table._id);
            const tableJoins = joins.filter(j => j.table_id === table._id);

            meta[table.table_name] = {
                columns: this._buildColumns(tableCols, activeTables, table.table_name),
                joins:   this._buildJoins(tableJoins, activeTables),
            };
        }

        return meta;
    }

    // ── Load from sys_ tables ─────────────────────────────────

    _loadTables() {
        return this.db.prepare(
            `SELECT * FROM sys_table WHERE active = 1 ORDER BY _id ASC`
        ).all();
    }

    _loadColumns() {
        return this.db.prepare(`
            SELECT c.* FROM sys_column c
            INNER JOIN sys_table t ON t._id = c.table_id
            WHERE c.active = 1 AND t.active = 1
            ORDER BY c.table_id ASC, c.sort_order ASC, c._id ASC
        `).all();
    }

    _loadJoins() {
        return this.db.prepare(`
            SELECT j.* FROM sys_join j
            INNER JOIN sys_table t ON t._id = j.table_id
            WHERE j.active = 1 AND t.active = 1
            ORDER BY j.table_id ASC, j._id ASC
        `).all();
    }

    // ── Build column definitions ──────────────────────────────

    _buildColumns(cols, activeTables = null, ownerTable = '') {
        const result = {};

        for (const col of cols) {
            const def = { type: col.col_type };

            // default value
            if (col.default_value !== null && col.default_value !== undefined) {
                def.default = this._parseDefault(col.col_type, col.default_value);
            }

            // required (primary key is auto-incremented by database)
            if (col.is_required && col.column_name !== '_id' && !col.is_pk) {
                def.required = true;
            }
            if (col.column_name === '_id' || col.is_pk) {
                def.pk = true;
            }

            // hasOne join — ref declared on this column (guard against dangling missing target table)
            if (col.ref_table && col.ref_col) {
                if (activeTables && !activeTables.has(col.ref_table)) {
                    console.warn(`[sutramEngine] Ignoring dangling FK ${ownerTable}.${col.column_name} -> missing table "${col.ref_table}"`);
                } else {
                    def.ref    = `${col.ref_table}.${col.ref_col}`;
                    def.as     = col.ref_as ?? col.ref_table;
                    let parsedSelect = '*';
                    if (col.ref_select) {
                        try {
                            parsedSelect = JSON.parse(col.ref_select);
                        } catch {
                            parsedSelect = col.ref_select.includes(',') ? col.ref_select.split(',').map(s => s.trim()) : col.ref_select;
                        }
                    }
                    def.select = parsedSelect;
                }
            }

            result[col.column_name] = def;
        }

        return result;
    }

    // ── Build join definitions ────────────────────────────────

    _buildJoins(joins, activeTables = null) {
        const result = {};

        for (const join of joins) {
            if (activeTables && join.child_table && !activeTables.has(join.child_table)) continue;
            if (activeTables && join.junction_table && !activeTables.has(join.junction_table)) continue;
            const selectCols = join.select_cols
                ? JSON.parse(join.select_cols)
                : '*';

            if (join.join_type === 'hasMany') {
                result[join.join_key] = {
                    hasMany: true,
                    table:   join.child_table,
                    on:      join.fk_col,
                    target:  join.target_col,
                    as:      join.as_name,
                    select:  selectCols,
                };
            }

            else if (join.join_type === 'manyToMany') {
                result[join.join_key] = {
                    manyToMany: true,
                    table:      join.child_table,
                    junction:   join.junction_table,
                    on:         join.fk_col,
                    target:     join.target_col,
                    as:         join.as_name,
                    select:     selectCols,
                };
            }
        }

        return result;
    }

    // ── Helpers ───────────────────────────────────────────────

    _parseDefault(type, raw) {
        if (raw === null || raw === undefined) return undefined;
        if (type === 'number')  return Number(raw);
        if (type === 'boolean') return raw === 'true' || raw === '1' ? 1 : 0;
        if (type === 'json')    { try { return JSON.parse(raw); } catch { return null; } }
        return raw; // string
    }
}

module.exports = BootstrapBuilder;
