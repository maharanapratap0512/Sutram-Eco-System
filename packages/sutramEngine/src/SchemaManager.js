// src/SchemaManager.js
// ─────────────────────────────────────────────────────────────
// Manages user-defined schema changes.
//
// Every write operation:
//   1. Writes to sys_ tables (persistent record)
//   2. Executes actual SQLite DDL (CREATE TABLE / ALTER TABLE)
//   3. Calls engine.rebootstrap() — rebuilds sutramCore cache
//
// Import/Export supports sutramCore schema.js format directly.
// All imports are idempotent — safe to call on every startup.
// ─────────────────────────────────────────────────────────────

'use strict';

class SchemaManager {

    constructor(db, rebootstrap) {
        this.db = db;
        this.rebootstrap = rebootstrap; // callback → Engine.rebootstrap()
        this.ensureHlColumns();
    }

    // ═════════════════════════════════════════════════════════
    // ── IMPORT ALL ────────────────────────────────────────────
    // ═════════════════════════════════════════════════════════
    //
    // One call to register everything from your database/ files.
    //
    // Usage:
    //   engine.schema.importAll({
    //     schema:   require('./schema'),     // tableMeta object
    //     triggers: require('./triggers'),   // trigger array (optional)
    //     reports:  require('./reports'),    // report array  (optional)
    //   });

    importAll({ schema, triggers = [], reports = [] } = {}) {
        if (schema) this.importSchema(schema);
        if (triggers?.length) this._importTriggers(triggers);
        if (reports?.length) this._importReports(reports);
        // single rebootstrap at the very end
        this.rebootstrap();
        console.log('[sutramEngine] ✓ importAll complete');
    }

    // ═════════════════════════════════════════════════════════
    // ── IMPORT SCHEMA ─────────────────────────────────────────
    // ═════════════════════════════════════════════════════════
    //
    // Accepts sutramCore tableMeta format (defineTable / raw object).
    // For each table:
    //   - inserts into sys_table, sys_column, sys_join
    //   - executes CREATE TABLE IF NOT EXISTS
    //   - skips if table already in sys_table (idempotent)
    //
    // Usage:
    //   engine.schema.importSchema(require('./schema'));

    importSchema(tableMeta) {
        if (!tableMeta || typeof tableMeta !== 'object') {
            throw new Error('[sutramEngine] importSchema: tableMeta must be a plain object');
        }

        let imported = 0;
        let skipped = 0;

        for (const [tableName, def] of Object.entries(tableMeta)) {
            if (tableName.startsWith('sys_')) continue; // never import sys_ tables

            const exists = this.db.prepare(
                `SELECT _id FROM sys_table WHERE table_name = ?`
            ).get(tableName);

            if (exists) {
                skipped++;
                continue;
            }

            const columns = this._parseColumns(def.columns ?? {});
            const joins = this._parseJoins(def.joins ?? {});

            // createTable handles sys_ insert + DDL — no rebootstrap here
            // (importAll / importSchema calls it once at the end)
            this._createTableInternal(tableName, null, null, columns, joins);
            imported++;
        }

        console.log(`[sutramEngine] importSchema — imported: ${imported}, skipped: ${skipped}`);

        // rebootstrap only when called standalone (not via importAll)
        if (arguments[1] !== '_batch') this.rebootstrap();
    }

    // ═════════════════════════════════════════════════════════
    // ── IMPORT TRIGGERS ───────────────────────────────────────
    // ═════════════════════════════════════════════════════════
    //
    // Accepts triggers.js array format.
    // Skips if trigger_name already in sys_trigger.
    //
    // Usage:
    //   engine.schema.importTriggers(require('./triggers'));

    importTriggers(triggers) {
        if (!Array.isArray(triggers)) {
            throw new Error('[sutramEngine] importTriggers: expects an array');
        }
        this._importTriggers(triggers);
        this.rebootstrap();
    }

    // ═════════════════════════════════════════════════════════
    // ── IMPORT REPORTS ────────────────────────────────────────
    // ═════════════════════════════════════════════════════════
    //
    // Accepts reports.js array format.
    // Skips if report_name already in sys_report.
    //
    // Usage:
    //   engine.schema.importReports(require('./reports'));

    importReports(reports) {
        if (!Array.isArray(reports)) {
            throw new Error('[sutramEngine] importReports: expects an array');
        }
        this._importReports(reports);
        this.rebootstrap();
    }

    // ═════════════════════════════════════════════════════════
    // ── EXPORT ALL ────────────────────────────────────────────
    // ═════════════════════════════════════════════════════════
    //
    // Returns all three in one call — exact format matching
    // the input files so it can be roundtripped.
    //
    // Usage:
    //   const { schema, triggers, reports } = engine.schema.exportAll();

    exportAll() {
        return {
            schema: this.exportSchema(),
            triggers: this.exportTriggers(),
            reports: this.exportReports(),
        };
    }

    // ═════════════════════════════════════════════════════════
    // ── EXPORT SCHEMA ─────────────────────────────────────────
    // ═════════════════════════════════════════════════════════
    //
    // Returns tableMeta object — same format as schema.js.
    // Useful for debugging, or switching back to sutramCore.
    //
    // Usage:
    //   const schema = engine.schema.exportSchema();
    //   // { product: { columns: {...}, joins: {...} }, ... }

    exportSchema() {
        const tables = this.db.prepare(
            `SELECT * FROM sys_table WHERE active = 1 AND is_system = 0 ORDER BY _id ASC`
        ).all();

        const result = {};

        for (const table of tables) {
            const cols = this.db.prepare(
                `SELECT * FROM sys_column WHERE table_id = ? AND active = 1 ORDER BY sort_order ASC`
            ).all(table._id);

            const joins = this.db.prepare(
                `SELECT * FROM sys_join WHERE table_id = ? AND active = 1`
            ).all(table._id);

            result[table.table_name] = {
                columns: this._exportColumns(cols),
                joins: this._exportJoins(joins),
            };
        }

        return result;
    }

    // ═════════════════════════════════════════════════════════
    // ── EXPORT TRIGGERS ───────────────────────────────────────
    // ═════════════════════════════════════════════════════════
    //
    // Returns triggers array — same format as triggers.js.
    //
    // Usage:
    //   const triggers = engine.schema.exportTriggers();

    exportTriggers() {
        const triggers = this.db.prepare(
            `SELECT * FROM sys_trigger ORDER BY _id ASC`
        ).all();

        return triggers.map(t => {
            const actions = this.db.prepare(
                `SELECT * FROM sys_trigger_action
                 WHERE trigger_id = ? ORDER BY sort_order ASC`
            ).all(t._id);

            const def = {
                trigger_name: t.trigger_name,
                label: t.label,
                source_table: t.source_table,
                event: t.event,
                active: t.active === 1,
            };

            // only include condition fields if not 'always'
            if (t.condition_type !== 'always') {
                def.condition_type = t.condition_type;
                if (t.condition_col) def.condition_col = t.condition_col;
                if (t.condition_value) def.condition_value = t.condition_value;
                if (t.condition_sql) def.condition_sql = t.condition_sql;
            }

            def.actions = actions.map(a => {
                const action = {
                    action_type: a.action_type,
                    sort_order: a.sort_order,
                };
                if (a.target_table) action.target_table = a.target_table;
                if (a.field_map && a.field_map !== '{}') {
                    action.field_map = JSON.parse(a.field_map);
                }
                if (a.condition) action.condition = a.condition;
                if (a.raw_sql) action.raw_sql = a.raw_sql;
                return action;
            });

            return def;
        });
    }

    // ═════════════════════════════════════════════════════════
    // ── EXPORT REPORTS ────────────────────────────────────────
    // ═════════════════════════════════════════════════════════
    //
    // Returns reports array — same format as reports.js.
    //
    // Usage:
    //   const reports = engine.schema.exportReports();

    exportReports() {
        return this.db.prepare(
            `SELECT * FROM sys_report ORDER BY _id ASC`
        ).all().map(r => ({
            report_name: r.report_name,
            label: r.label,
            description: r.description,
            cte_sql: r.cte_sql,
            params: r.params ? JSON.parse(r.params) : [],
            active: r.active === 1,
        }));
    }

    // ═════════════════════════════════════════════════════════
    // ── CREATE TABLE ──────────────────────────────────────────
    // ═════════════════════════════════════════════════════════
    //
    // Direct create — for SchemaManager.createTable() API.
    // def: {
    //   table_name, label?, description?,
    //   columns: [ { column_name, col_type, ... } ],
    //   joins?:  [ { join_type, join_key, ... } ]
    // }

    createTable(def) {
        const { table_name, label, description, columns = [], joins = [] } = def;

        if (!table_name) throw new Error('[sutramEngine] createTable: table_name required');
        if (columns.length === 0) throw new Error('[sutramEngine] createTable: at least one column required');
        if (table_name.startsWith('sys_')) {
            throw new Error(`[sutramEngine] Cannot use "sys_" prefix — reserved for engine`);
        }

        this._createTableInternal(table_name, label, description, columns, joins);
        this.rebootstrap();
        console.log(`[sutramEngine] ✓ Table "${table_name}" created`);
    }

    // ─────────────────────────────────────────────────────────
    // ADD COLUMN
    // col: { column_name, col_type, label?, is_required?,
    //        default_value?, ref_table?, ref_col?, ref_as?, ref_select? }

    addColumn(tableName, col) {
        if (!tableName || !col?.column_name) {
            throw new Error('[sutramEngine] addColumn: tableName and col.column_name required');
        }

        const tableRow = this._getTable(tableName);

        this.db.transaction(() => {
            const maxOrder = this.db.prepare(
                `SELECT MAX(sort_order) as m FROM sys_column WHERE table_id = ?`
            ).get(tableRow._id)?.m ?? -1;

            this._insertColumn(tableRow._id, col, maxOrder + 1);
            this.db.prepare(this._buildAlterAddColumn(tableName, col)).run();
        })();

        this.rebootstrap();
        console.log(`[sutramEngine] ✓ Column "${col.column_name}" added to "${tableName}"`);
    }

    // ─────────────────────────────────────────────────────────
    // DROP COLUMN

    dropColumn(tableName, columnName) {
        const tableRow = this._getTable(tableName);
        const colRow = this.db.prepare(
            `SELECT * FROM sys_column WHERE table_id = ? AND column_name = ?`
        ).get(tableRow._id, columnName);

        if (!colRow) throw new Error(`[sutramEngine] Column "${columnName}" not found in "${tableName}"`);
        if (colRow.is_pk) throw new Error(`[sutramEngine] Cannot drop primary key column`);

        const refs = this.getReferencingConstraints(tableName, columnName);
        if (refs.length > 0) {
            const err = new Error(
                `Cannot drop column "${tableName}.${columnName}": referenced by ${refs.map(r => `"${r.table_name}.${r.column_name}"`).join(', ')}. Remove referencing foreign key(s) first.`
            );
            err.statusCode = 409;
            throw err;
        }

        this.db.transaction(() => {
            this.db.prepare(`DELETE FROM sys_column WHERE _id = ?`).run(colRow._id);
            this.db.prepare(`ALTER TABLE "${tableName}" DROP COLUMN "${columnName}"`).run();
        })();

        this.rebootstrap();
        console.log(`[sutramEngine] ✓ Column "${columnName}" dropped from "${tableName}"`);
    }

    // ─────────────────────────────────────────────────────────
    // ADD JOIN
    // join: { join_type, join_key, child_table, fk_col,
    //         target_col, as_name, junction_table?, select_cols? }

    addJoin(tableName, join) {
        const tableRow = this._getTable(tableName);
        this.db.transaction(() => this._insertJoin(tableRow._id, join))();
        this.rebootstrap();
        console.log(`[sutramEngine] ✓ Join "${join.join_key}" added to "${tableName}"`);
    }

    // ─────────────────────────────────────────────────────────
    // REMOVE JOIN

    removeJoin(tableName, joinKey) {
        const tableRow = this._getTable(tableName);
        const joinRow = this.db.prepare(
            `SELECT * FROM sys_join WHERE table_id = ? AND join_key = ?`
        ).get(tableRow._id, joinKey);

        if (!joinRow) throw new Error(`[sutramEngine] Join "${joinKey}" not found in "${tableName}"`);

        this.db.prepare(`DELETE FROM sys_join WHERE _id = ?`).run(joinRow._id);
        this.rebootstrap();
        console.log(`[sutramEngine] ✓ Join "${joinKey}" removed from "${tableName}"`);
    }

    // ─────────────────────────────────────────────────────────
    // REFERENCING FK CONSTRAINTS CHECK (sys_column + SQLite PRAGMA)

    getReferencingConstraints(tableName, columnName = null) {
        const seen = new Set();
        const refs = [];

        // 1. Metadata check via sys_column
        try {
            const sysRefs = this.db.prepare(`
                SELECT t.table_name, c.column_name, COALESCE(c.ref_col, '_id') as ref_col
                FROM sys_column c
                JOIN sys_table t ON t._id = c.table_id
                WHERE c.ref_table = ? AND c.active = 1 AND t.active = 1 AND t.table_name != ?
            `).all(tableName, tableName);

            for (const r of sysRefs) {
                if (columnName && r.ref_col !== columnName) continue;
                const key = `${r.table_name}.${r.column_name}->${r.ref_col}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    refs.push({ table_name: r.table_name, column_name: r.column_name, ref_col: r.ref_col || '_id' });
                }
            }
        } catch {}

        // 2. Physical SQLite DDL check via PRAGMA foreign_key_list across all physical tables
        try {
            const allPhysical = this.db.prepare(`
                SELECT name FROM sqlite_master
                WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'sys_%' AND name != ?
            `).all(tableName);

            for (const row of allPhysical) {
                try {
                    const fkList = this.db.prepare(`PRAGMA foreign_key_list("${row.name}")`).all();
                    for (const fk of fkList) {
                        if (fk.table !== tableName) continue;
                        const targetCol = fk.to || '_id';
                        if (columnName && targetCol !== columnName) continue;
                        const key = `${row.name}.${fk.from}->${targetCol}`;
                        if (!seen.has(key)) {
                            seen.add(key);
                            refs.push({ table_name: row.name, column_name: fk.from, ref_col: targetCol });
                        }
                    }
                } catch {}
            }
        } catch {}

        return refs;
    }

    // ─────────────────────────────────────────────────────────
    // TABLE IMPACT CHECK (for Edit / Delete safety warnings)

    getTableImpact(tableName) {
        const tableRow = this._getTable(tableName);
        let rowCount = 0;
        try {
            rowCount = this.db.prepare(`SELECT COUNT(*) as c FROM "${tableName}"`).get()?.c || 0;
        } catch {}

        const referencingTables = this.getReferencingConstraints(tableName);

        return {
            table_name: tableName,
            label: tableRow.label || tableName,
            rowCount,
            referencingTables
        };
    }

    // ─────────────────────────────────────────────────────────
    // UPDATE TABLE (2-Tier Hybrid Strategy: Fast In-Place vs Atomic Shadow Rebuild)

    updateTable(tableName, def = {}) {
        const tableRow = this._getTable(tableName);
        if (tableRow.is_system) {
            throw new Error(`[sutramEngine] Cannot edit system table "${tableName}"`);
        }

        const { label, description, columns } = def;
        const existingCols = this.db.prepare(
            `SELECT * FROM sys_column WHERE table_id = ? AND active = 1 ORDER BY sort_order ASC`
        ).all(tableRow._id);

        const existingMap = new Map(existingCols.map(c => [c.column_name, c]));

        // If only table label/description changed (no columns array provided)
        if (!Array.isArray(columns) || columns.length === 0) {
            const needTx = !this.db.inTransaction;
            try {
                if (needTx) this.db.prepare('BEGIN').run();
                this.db.prepare(`
                    UPDATE sys_table
                    SET label = ?, description = ?, updated_at = datetime('now', 'localtime')
                    WHERE _id = ?
                `).run(label ?? tableRow.label, description !== undefined ? description : tableRow.description, tableRow._id);
                if (needTx) this.db.prepare('COMMIT').run();
            } catch (err) {
                if (needTx && this.db.inTransaction) this.db.prepare('ROLLBACK').run();
                throw err;
            }
            this.rebootstrap();
            return { strategy: 'metadata-only', table_name: tableName, columnsCount: existingCols.length };
        }

        // Preserve mandatory _id and hl system columns
        const incoming = columns.map((c, idx) => ({
            ...c,
            column_name: c.is_pk ? '_id' : String(c.column_name || c.name || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_'),
            original_name: c.original_name ? String(c.original_name).trim() : null,
            col_type: this._normalizeColType(c),
            sort_order: c.sort_order ?? idx
        })).filter(c => c.column_name && (c.is_pk ? c.column_name === '_id' : c.column_name !== '_id' && c.column_name !== 'id'));

        if (!incoming.some(c => c.column_name === '_id')) {
            const origPk = existingMap.get('_id') || existingMap.get('id');
            incoming.unshift({
                column_name: '_id',
                original_name: origPk ? origPk.column_name : null,
                label: origPk?.label || 'ID',
                col_type: 'number',
                sql_type: 'INTEGER',
                is_pk: 1,
                is_required: 0,
                sort_order: 0
            });
        }
        if (!incoming.some(c => c.column_name === 'hl')) {
            const origHl = existingMap.get('hl');
            incoming.push({
                column_name: 'hl',
                original_name: origHl ? 'hl' : null,
                label: origHl?.label || 'Highlight Flag',
                col_type: 'number',
                sql_type: 'TINYINT',
                is_pk: 0,
                is_required: 0,
                default_value: '0',
                sort_order: incoming.length
            });
        }

        // Validate duplicate names
        const seenNames = new Set();
        for (const c of incoming) {
            if (seenNames.has(c.column_name)) {
                throw new Error(`[sutramEngine] Duplicate column name "${c.column_name}"`);
            }
            seenNames.add(c.column_name);
        }

        // Inspect physical SQLite columns & indexes
        const pragmaCols = this.db.prepare(`PRAGMA table_info("${tableName}")`).all();
        const physicalNames = new Set(pragmaCols.map(p => p.name));
        const pragmaIndexes = this.db.prepare(`PRAGMA index_list("${tableName}")`).all();
        const indexedCols = new Set();
        for (const idx of pragmaIndexes) {
            const info = this.db.prepare(`PRAGMA index_info("${idx.name}")`).all();
            for (const ic of info) indexedCols.add(ic.name);
        }

        // Categorize changes
        const keptOriginalNames = new Set();
        const addedCols = [];
        const renamedCols = [];
        let needsRebuild = false;

        const isNumericAffinity = (t) => ['number', 'boolean'].includes(String(t || '').toLowerCase());

        for (const col of incoming) {
            const origKey = col.original_name && existingMap.has(col.original_name)
                ? col.original_name
                : (existingMap.has(col.column_name) ? col.column_name : null);

            if (!origKey) {
                addedCols.push(col);
                // SQLite ADD COLUMN cannot add NOT NULL without default, UNIQUE, or non-constant expression default
                if (
                    col.is_unique ||
                    col.default_type === 'CURRENT_TIMESTAMP' ||
                    (col.is_required && (col.default_value === undefined || col.default_value === null || String(col.default_value).trim() === ''))
                ) {
                    needsRebuild = true;
                }
            } else {
                keptOriginalNames.add(origKey);
                const prev = existingMap.get(origKey);
                if (origKey !== col.column_name) {
                    renamedCols.push({ from: origKey, to: col.column_name });
                }
                // Check structural changes requiring Tier 2 Shadow Rebuild
                const prevReq = prev.is_required ? 1 : 0;
                const nextReq = col.is_required ? 1 : 0;
                const prevDef = prev.default_value ?? null;
                const nextDef = (col.default_value !== undefined && col.default_value !== null && String(col.default_value).trim() !== '')
                    ? String(col.default_value) : null;
                const prevRef = `${prev.ref_table || ''}.${prev.ref_col || ''}`;
                const nextRef = `${col.ref_table || ''}.${col.ref_col || ''}`;

                if (
                    prevReq !== nextReq ||
                    prevDef !== nextDef ||
                    prevRef !== nextRef ||
                    col.is_unique ||
                    isNumericAffinity(prev.col_type) !== isNumericAffinity(col.col_type)
                ) {
                    needsRebuild = true;
                }
            }
        }

        const removedCols = existingCols.filter(c =>
            c.column_name !== '_id' &&
            c.column_name !== 'hl' &&
            !keptOriginalNames.has(c.column_name)
        );

        for (const rc of removedCols) {
            const colRefs = this.getReferencingConstraints(tableName, rc.column_name);
            if (colRefs.length > 0) {
                const err = new Error(
                    `Cannot remove column "${tableName}.${rc.column_name}": it is referenced by ${colRefs.map(r => `"${r.table_name}.${r.column_name}"`).join(', ')}. Delete or update the referencing table(s) first.`
                );
                err.statusCode = 409;
                throw err;
            }
            if (indexedCols.has(rc.column_name) || rc.ref_table) {
                needsRebuild = true;
            }
        }

        let strategy = 'in-place';

        if (!needsRebuild) {
            // ── TIER 1: Fast In-Place Alteration ──────────────────
            const needTx = !this.db.inTransaction;
            try {
                if (needTx) this.db.prepare('BEGIN IMMEDIATE').run();

                this.db.prepare(`
                    UPDATE sys_table
                    SET label = ?, description = ?, updated_at = datetime('now', 'localtime')
                    WHERE _id = ?
                `).run(label ?? tableRow.label, description !== undefined ? description : tableRow.description, tableRow._id);

                for (const ren of renamedCols) {
                    if (physicalNames.has(ren.from)) {
                        this.db.prepare(`ALTER TABLE "${tableName}" RENAME COLUMN "${ren.from}" TO "${ren.to}"`).run();
                        physicalNames.delete(ren.from);
                        physicalNames.add(ren.to);
                    }
                    // Update any incoming FKs referencing the renamed column
                    this.db.prepare(`
                        UPDATE sys_column SET ref_col = ? WHERE ref_table = ? AND ref_col = ?
                    `).run(ren.to, tableName, ren.from);
                }

                for (const rc of removedCols) {
                    if (physicalNames.has(rc.column_name)) {
                        this.db.prepare(`ALTER TABLE "${tableName}" DROP COLUMN "${rc.column_name}"`).run();
                        physicalNames.delete(rc.column_name);
                    }
                }

                for (const ac of addedCols) {
                    if (!physicalNames.has(ac.column_name)) {
                        this.db.prepare(this._buildAlterAddColumn(tableName, ac)).run();
                        physicalNames.add(ac.column_name);
                    }
                }

                // Refresh sys_column cleanly
                this.db.prepare(`DELETE FROM sys_column WHERE table_id = ?`).run(tableRow._id);
                for (let i = 0; i < incoming.length; i++) {
                    this._insertColumn(tableRow._id, incoming[i], i);
                }

                // Create requested indexes on new columns
                for (const col of incoming) {
                    if (col.has_index && col.column_name !== '_id') {
                        const idxName = `idx_${tableName}_${col.column_name}`;
                        this.db.prepare(`CREATE INDEX IF NOT EXISTS "${idxName}" ON "${tableName}"("${col.column_name}")`).run();
                    }
                }

                if (needTx) this.db.prepare('COMMIT').run();
            } catch (err) {
                if (needTx && this.db.inTransaction) this.db.prepare('ROLLBACK').run();
                throw err;
            }
        } else {
            // ── TIER 2: Atomic Shadow-Table Rebuild ───────────────
            strategy = 'rebuild';
            const shadowName = `__sutram_rebuild_${tableName}_${Date.now()}`;
            const oldCount = this.db.prepare(`SELECT COUNT(*) as c FROM "${tableName}"`).get()?.c || 0;

            this.db.pragma('foreign_keys = OFF');
            const needTx = !this.db.inTransaction;
            try {
                if (needTx) this.db.prepare('BEGIN IMMEDIATE').run();

                // 1. Create shadow table with updated schema
                this.db.prepare(this._buildCreateSQL(shadowName, incoming)).run();

                // 2. Map & copy all existing rows with safe COALESCE / updated-default fallback
                const destCols = [];
                const selectExprs = [];
                const toDefaultExpr = (col) => {
                    if (col.default_type === 'CURRENT_TIMESTAMP') {
                        return `datetime('now', 'localtime')`;
                    }
                    if (isNumericAffinity(col.col_type)) {
                        return (col.default_value !== undefined && col.default_value !== null && String(col.default_value).trim() !== '' && !isNaN(Number(col.default_value)))
                            ? String(Number(col.default_value))
                            : '0';
                    }
                    return `'${String(col.default_value ?? '').replace(/'/g, "''")}'`;
                };

                for (const col of incoming) {
                    const srcName = col.original_name && physicalNames.has(col.original_name)
                        ? col.original_name
                        : (physicalNames.has(col.column_name) ? col.column_name : null);

                    const origMeta = srcName ? existingMap.get(srcName) : null;
                    const prevDefNorm = origMeta?.default_value !== undefined && origMeta?.default_value !== null && String(origMeta.default_value).trim() !== ''
                        ? String(origMeta.default_value) : null;
                    const nextDefNorm = col.default_value !== undefined && col.default_value !== null && String(col.default_value).trim() !== ''
                        ? String(col.default_value) : null;
                    const hasExplicitNewDefault = (nextDefNorm !== null || col.default_type === 'CURRENT_TIMESTAMP') && nextDefNorm !== prevDefNorm;

                    if (srcName) {
                        destCols.push(`"${col.column_name}"`);
                        if ((col.is_required && !col.is_pk) || (hasExplicitNewDefault && !col.is_pk)) {
                            const fallback = toDefaultExpr(col);
                            if (isNumericAffinity(col.col_type)) {
                                selectExprs.push(`COALESCE("${srcName}", ${fallback})`);
                            } else {
                                selectExprs.push(`CASE WHEN "${srcName}" IS NULL OR "${srcName}" = '' THEN ${fallback} ELSE "${srcName}" END`);
                            }
                        } else {
                            selectExprs.push(`"${srcName}"`);
                        }
                    } else if (!col.is_pk && (col.is_required || nextDefNorm !== null || col.default_type === 'CURRENT_TIMESTAMP')) {
                        // Brand-new column with NOT NULL or an explicit default value: populate all existing rows immediately
                        destCols.push(`"${col.column_name}"`);
                        selectExprs.push(toDefaultExpr(col));
                    }
                }

                if (physicalNames.has('created_at')) {
                    destCols.push(`"created_at"`);
                    selectExprs.push(`"created_at"`);
                }
                if (physicalNames.has('updated_at')) {
                    destCols.push(`"updated_at"`);
                    selectExprs.push(`"updated_at"`);
                }

                if (oldCount > 0 && destCols.length > 0) {
                    this.db.prepare(
                        `INSERT INTO "${shadowName}" (${destCols.join(', ')}) SELECT ${selectExprs.join(', ')} FROM "${tableName}"`
                    ).run();
                }

                // 3. Verify row count strictly matches (zero data loss check)
                const newCount = this.db.prepare(`SELECT COUNT(*) as c FROM "${shadowName}"`).get()?.c || 0;
                if (newCount !== oldCount) {
                    throw new Error(`[sutramEngine] Shadow rebuild row count mismatch (${newCount} !== ${oldCount}) — rolled back safely.`);
                }

                // 4. Swap tables
                this.db.prepare(`DROP TABLE "${tableName}"`).run();
                this.db.prepare(`ALTER TABLE "${shadowName}" RENAME TO "${tableName}"`).run();

                // 5. Recreate custom indexes
                for (const col of incoming) {
                    if (col.has_index && col.column_name !== '_id') {
                        const idxName = `idx_${tableName}_${col.column_name}`;
                        this.db.prepare(`CREATE INDEX IF NOT EXISTS "${idxName}" ON "${tableName}"("${col.column_name}")`).run();
                    }
                }

                // 6. Update sys_table & sys_column metadata
                this.db.prepare(`
                    UPDATE sys_table
                    SET label = ?, description = ?, updated_at = datetime('now', 'localtime')
                    WHERE _id = ?
                `).run(label ?? tableRow.label, description !== undefined ? description : tableRow.description, tableRow._id);

                for (const ren of renamedCols) {
                    this.db.prepare(`
                        UPDATE sys_column SET ref_col = ? WHERE ref_table = ? AND ref_col = ?
                    `).run(ren.to, tableName, ren.from);
                }

                this.db.prepare(`DELETE FROM sys_column WHERE table_id = ?`).run(tableRow._id);
                for (let i = 0; i < incoming.length; i++) {
                    this._insertColumn(tableRow._id, incoming[i], i);
                }

                // 7. Verify FK integrity on rebuilt table
                const fkViolations = this.db.prepare(`PRAGMA foreign_key_check("${tableName}")`).all();
                if (fkViolations.length > 0) {
                    throw new Error(`[sutramEngine] Foreign key check failed on "${tableName}" (${fkViolations.length} violation(s)) — rolled back safely.`);
                }

                if (needTx) this.db.prepare('COMMIT').run();
            } catch (err) {
                if (needTx && this.db.inTransaction) this.db.prepare('ROLLBACK').run();
                try { this.db.prepare(`DROP TABLE IF EXISTS "${shadowName}"`).run(); } catch {}
                throw err;
            } finally {
                this.db.pragma('foreign_keys = ON');
            }
        }

        this.rebootstrap();
        console.log(`[sutramEngine] ✓ Table "${tableName}" updated via ${strategy} (${incoming.length} columns)`);
        return {
            strategy,
            table_name: tableName,
            label: label ?? tableRow.label,
            columnsCount: incoming.length,
            addedColumns: addedCols.map(c => c.column_name),
            removedColumns: removedCols.map(c => c.column_name),
            renamedColumns: renamedCols
        };
    }

    // ─────────────────────────────────────────────────────────
    // DROP TABLE (Strictly enforces Foreign Key Integrity — DDL)

    dropTable(tableName) {
        const tableRow = this._getTable(tableName);
        if (tableRow.is_system) throw new Error(`[sutramEngine] Cannot drop system table "${tableName}"`);

        // STRICT DDL FK CHECK: Cannot delete a source/parent table while any child table references it
        const refs = this.getReferencingConstraints(tableName);
        if (refs.length > 0) {
            const refList = refs.map(r => `"${r.table_name}" (column: ${r.column_name})`).join(', ');
            const err = new Error(
                `Cannot delete table "${tableName}" because it is referenced by: ${refList}. Delete the referencing table(s) or remove their foreign key columns first.`
            );
            err.statusCode = 409;
            throw err;
        }

        const needTx = !this.db.inTransaction;
        try {
            if (needTx) this.db.prepare('BEGIN IMMEDIATE').run();
            // Clean up auxiliary sys_ metadata tables if present
            try { this.db.prepare(`DELETE FROM sys_user_rights WHERE table_name = ?`).run(tableName); } catch {}
            try { this.db.prepare(`DELETE FROM sys_column_security WHERE table_name = ?`).run(tableName); } catch {}
            try { this.db.prepare(`DELETE FROM sys_ui_table WHERE table_name = ?`).run(tableName); } catch {}
            try { this.db.prepare(`DELETE FROM sys_ui_column WHERE table_name = ?`).run(tableName); } catch {}
            this.db.prepare(`DELETE FROM sys_column WHERE table_id = ?`).run(tableRow._id);
            this.db.prepare(`DELETE FROM sys_join WHERE table_id = ?`).run(tableRow._id);
            this.db.prepare(`DELETE FROM sys_table WHERE _id = ?`).run(tableRow._id);
            this.db.prepare(`DROP TABLE IF EXISTS "${tableName}"`).run();
            if (needTx) this.db.prepare('COMMIT').run();
        } catch (err) {
            if (needTx && this.db.inTransaction) this.db.prepare('ROLLBACK').run();
            throw err;
        }

        this.rebootstrap();
        console.log(`[sutramEngine] ✓ Table "${tableName}" dropped`);
    }

    // ─────────────────────────────────────────────────────────
    // LIST

    getTables() {
        return this.db.prepare(
            `SELECT * FROM sys_table WHERE active = 1 ORDER BY _id ASC`
        ).all();
    }

    getTableDetail(tableName) {
        const tableRow = this._getTable(tableName);
        const columns = this.db.prepare(
            `SELECT * FROM sys_column WHERE table_id = ? AND active = 1 ORDER BY sort_order ASC`
        ).all(tableRow._id);
        const joins = this.db.prepare(
            `SELECT * FROM sys_join WHERE table_id = ? AND active = 1`
        ).all(tableRow._id);
        return { ...tableRow, columns, joins };
    }

    // ═════════════════════════════════════════════════════════
    // ── PRIVATE — IMPORT HELPERS ──────────────────────────────
    // ═════════════════════════════════════════════════════════

    _importTriggers(triggers) {
        let imported = 0;
        let skipped = 0;

        for (const def of triggers) {
            if (!def.trigger_name) {
                console.warn('[sutramEngine] importTriggers: skipping entry without trigger_name');
                continue;
            }

            const exists = this.db.prepare(
                `SELECT _id FROM sys_trigger WHERE trigger_name = ?`
            ).get(def.trigger_name);

            if (exists) { skipped++; continue; }

            this.db.transaction(() => {
                const res = this.db.prepare(`
                    INSERT INTO sys_trigger
                      (trigger_name, label, source_table, event,
                       condition_type, condition_col, condition_value, condition_sql)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                `).run(
                    def.trigger_name,
                    def.label ?? def.trigger_name,
                    def.source_table,
                    def.event.toUpperCase(),
                    def.condition_type ?? 'always',
                    def.condition_col ?? null,
                    def.condition_value ?? null,
                    def.condition_sql ?? null,
                );

                const triggerId = res.lastInsertRowid;

                for (let i = 0; i < (def.actions ?? []).length; i++) {
                    const a = def.actions[i];
                    this.db.prepare(`
                        INSERT INTO sys_trigger_action
                          (trigger_id, sort_order, action_type, target_table,
                           field_map, condition, raw_sql)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                    `).run(
                        triggerId,
                        a.sort_order ?? i,
                        a.action_type,
                        a.target_table ?? null,
                        a.field_map ? JSON.stringify(a.field_map) : '{}',
                        a.condition ?? null,
                        a.raw_sql ?? null,
                    );
                }
            })();

            imported++;
        }

        console.log(`[sutramEngine] importTriggers — imported: ${imported}, skipped: ${skipped}`);
    }

    _importReports(reports) {
        let imported = 0;
        let skipped = 0;

        for (const def of reports) {
            if (!def.report_name) {
                console.warn('[sutramEngine] importReports: skipping entry without report_name');
                continue;
            }

            const exists = this.db.prepare(
                `SELECT _id FROM sys_report WHERE report_name = ?`
            ).get(def.report_name);

            if (exists) { skipped++; continue; }

            this.db.prepare(`
                INSERT INTO sys_report (report_name, label, description, cte_sql, params)
                VALUES (?, ?, ?, ?, ?)
            `).run(
                def.report_name,
                def.label ?? def.report_name,
                def.description ?? null,
                def.cte_sql,
                JSON.stringify(def.params ?? []),
            );

            imported++;
        }

        console.log(`[sutramEngine] importReports — imported: ${imported}, skipped: ${skipped}`);
    }

    // ═════════════════════════════════════════════════════════
    // ── PRIVATE — PARSE (sutramCore format → array format) ────
    // ═════════════════════════════════════════════════════════

    // tableMeta columns object → sys_column insert-ready array
    _parseColumns(columns) {
        return Object.entries(columns).map(([column_name, def], i) => ({
            column_name,
            label: def.label ?? column_name,
            col_type: def.type ?? 'string',
            is_pk: column_name === '_id' ? 1 : 0,
            is_required: def.required ? 1 : 0,
            default_value: def.default !== undefined ? String(def.default) : null,
            ref_table: def.ref ? def.ref.split('.')[0] : null,
            ref_col: def.ref ? def.ref.split('.')[1] : null,
            ref_as: def.as ?? null,
            ref_select: def.select
                ? JSON.stringify(Array.isArray(def.select) ? def.select : [def.select])
                : null,
            sort_order: i,
        }));
    }

    // tableMeta joins object → sys_join insert-ready array
    _parseJoins(joins) {
        return Object.entries(joins).map(([join_key, def]) => ({
            join_key,
            join_type: def.hasMany ? 'hasMany' : 'manyToMany',
            child_table: def.table,
            fk_col: def.on,
            target_col: def.target,
            as_name: def.as ?? join_key,
            junction_table: def.junction ?? null,
            select_cols: Array.isArray(def.select)
                ? JSON.stringify(def.select)
                : '["*"]',
        }));
    }

    // ═════════════════════════════════════════════════════════
    // ── PRIVATE — EXPORT (sys_ rows → sutramCore format) ──────
    // ═════════════════════════════════════════════════════════

    _exportColumns(cols) {
        const result = {};

        for (const col of cols) {
            const def = { type: col.col_type };

            if (col.default_value !== null && col.default_value !== undefined) {
                def.default = this._parseDefault(col.col_type, col.default_value);
            }
            if (col.is_required) def.required = true;
            if (col.ref_table && col.ref_col) {
                def.ref = `${col.ref_table}.${col.ref_col}`;
                def.as = col.ref_as ?? col.ref_table;
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

            result[col.column_name] = def;
        }

        return result;
    }

    _exportJoins(joins) {
        const result = {};

        for (const join of joins) {
            const selectCols = join.select_cols ? JSON.parse(join.select_cols) : '*';

            if (join.join_type === 'hasMany') {
                result[join.join_key] = {
                    hasMany: true,
                    table: join.child_table,
                    on: join.fk_col,
                    target: join.target_col,
                    as: join.as_name,
                    select: selectCols,
                };
            } else if (join.join_type === 'manyToMany') {
                result[join.join_key] = {
                    manyToMany: true,
                    table: join.child_table,
                    junction: join.junction_table,
                    on: join.fk_col,
                    target: join.target_col,
                    as: join.as_name,
                    select: selectCols,
                };
            }
        }

        return result;
    }

    // ═════════════════════════════════════════════════════════
    // ── PRIVATE — CORE DDL ────────────────────────────────────
    // ═════════════════════════════════════════════════════════

    ensureHlColumns() {
        if (!this.db || typeof this.db.prepare !== 'function') return;
        try {
            const tables = this.db.prepare(`SELECT _id, table_name FROM sys_table WHERE is_system = 0 AND active = 1`).all();
            for (const t of tables) {
                const cols = this.db.prepare(`PRAGMA table_info("${t.table_name}")`).all();
                if (!cols.some(c => c.name === 'hl')) {
                    try {
                        this.db.prepare(`ALTER TABLE "${t.table_name}" ADD COLUMN "hl" INTEGER DEFAULT 0`).run();
                    } catch {}
                }
                const sysCol = this.db.prepare(`SELECT _id FROM sys_column WHERE table_id = ? AND column_name = 'hl'`).get(t._id);
                if (!sysCol) {
                    const maxOrder = this.db.prepare(`SELECT MAX(sort_order) as m FROM sys_column WHERE table_id = ?`).get(t._id)?.m ?? 99;
                    this.db.prepare(`
                        INSERT OR IGNORE INTO sys_column (table_id, column_name, label, col_type, is_required, default_value, is_pk, sort_order)
                        VALUES (?, 'hl', 'Highlight Flag', 'number', 0, '0', 0, ?)
                    `).run(t._id, maxOrder + 1);
                }
            }
            // Ensure _id is never marked as is_required in sys_column so insert never demands it
            try {
                this.db.prepare(`UPDATE sys_column SET is_required = 0 WHERE column_name = '_id'`).run();
            } catch {}
        } catch {}
    }

    // Internal create — no rebootstrap (caller decides when)
    _createTableInternal(tableName, label, description, columns, joins) {
        // Enforce _id as the single compulsory auto-increment primary key
        const pkCol = (columns || []).find(c => c.is_pk || c.column_name === '_id');
        const customCols = (columns || []).filter(c => !c.is_pk && c.column_name !== '_id' && c.column_name !== 'id' && c.column_name !== 'hl');
        const allColumns = [
            {
                column_name: '_id',
                label: pkCol?.label || 'ID',
                col_type: 'number',
                sql_type: 'INTEGER',
                is_pk: 1,
                is_required: 0,
                sort_order: 0
            },
            ...customCols
        ];

        // Automatic compulsory Highlight flag (hl) for every table
        allColumns.push({
            column_name: 'hl',
            label: 'Highlight Flag',
            col_type: 'number',
            sql_type: 'TINYINT',
            is_pk: 0,
            is_required: 0,
            default_value: '0',
            sort_order: allColumns.length
        });

        this.db.transaction(() => {
            const tableRes = this.db.prepare(`
                INSERT INTO sys_table (table_name, label, description)
                VALUES (?, ?, ?)
            `).run(tableName, label ?? tableName, description ?? null);

            const tableId = tableRes.lastInsertRowid;

            for (let i = 0; i < allColumns.length; i++) {
                this._insertColumn(tableId, allColumns[i], allColumns[i].sort_order ?? i);
            }

            for (const join of (joins || [])) {
                this._insertJoin(tableId, join);
            }

            // build + run CREATE TABLE
            this.db.prepare(this._buildCreateSQL(tableName, allColumns)).run();

            // build + run custom INDEXES if requested
            for (const col of allColumns) {
                if (col.has_index && col.column_name !== '_id') {
                    const idxName = `idx_${tableName}_${col.column_name}`;
                    this.db.prepare(`CREATE INDEX IF NOT EXISTS "${idxName}" ON "${tableName}"("${col.column_name}")`).run();
                }
            }
        })();
    }

    _normalizeColType(col) {
        const sqlUpper = String(col.sql_type || '').toUpperCase();
        if (sqlUpper === 'DATE') return 'date';
        if (sqlUpper === 'DATETIME') return 'datetime';
        if (sqlUpper === 'PASSWORD') return 'password';
        if (sqlUpper === 'FK') return 'number';

        let normalizedType = String(col.col_type || 'string').toLowerCase();
        if (['number', 'string', 'boolean', 'json', 'date', 'datetime', 'password'].includes(normalizedType)) {
            return normalizedType;
        }
        if (['int', 'integer', 'bigint', 'decimal', 'numeric', 'float', 'fk'].includes(normalizedType)) {
            return 'number';
        }
        if (normalizedType === 'tinyint') return 'boolean';
        if (['pwd', 'secret', 'secret_hash'].includes(normalizedType)) return 'password';
        return 'string';
    }

    _insertColumn(tableId, col, sortOrder) {
        const refSelectVal = Array.isArray(col.ref_select)
            ? JSON.stringify(col.ref_select)
            : (col.ref_select ? String(col.ref_select) : null);

        const normalizedType = this._normalizeColType(col);

        this.db.prepare(`
            INSERT INTO sys_column
              (table_id, column_name, label, col_type, is_required, default_value,
               is_pk, ref_table, ref_col, ref_as, ref_select, sort_order)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            tableId,
            col.column_name,
            col.label ?? col.column_name,
            normalizedType,
            col.is_required ? 1 : 0,
            col.default_value !== undefined && col.default_value !== null ? String(col.default_value) : null,
            col.is_pk ? 1 : 0,
            col.ref_table ?? null,
            col.ref_col ?? null,
            col.ref_as ?? null,
            refSelectVal,
            sortOrder,
        );
    }

    _insertJoin(tableId, join) {
        if (!join.join_type || !join.join_key || !join.child_table) {
            throw new Error('[sutramEngine] join requires: join_type, join_key, child_table');
        }
        if (join.join_type === 'manyToMany' && !join.junction_table) {
            throw new Error('[sutramEngine] manyToMany join requires junction_table');
        }

        this.db.prepare(`
            INSERT INTO sys_join
              (table_id, join_type, join_key, child_table, junction_table,
               fk_col, target_col, as_name, select_cols)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            tableId,
            join.join_type,
            join.join_key,
            join.child_table,
            join.junction_table ?? null,
            join.fk_col,
            join.target_col,
            join.as_name ?? join.join_key,
            join.select_cols ?? '["*"]',
        );
    }

    _buildCreateSQL(tableName, columns) {
        const parts = [];

        for (const col of columns) {
            if (col.is_pk || col.column_name === '_id') {
                parts.push(`"_id" INTEGER PRIMARY KEY AUTOINCREMENT`);
                continue;
            }

            let colDef = `"${col.column_name}"`;

            if (col.sql_type) {
                const upperSql = String(col.sql_type).toUpperCase();
                if (upperSql === 'PASSWORD') {
                    colDef += ` VARCHAR(${col.length_precision || 255})`;
                } else if (upperSql === 'FK') {
                    colDef += ' INTEGER';
                } else if (col.length_precision && ['VARCHAR', 'CHAR', 'DECIMAL', 'NUMERIC', 'FLOAT'].includes(upperSql)) {
                    colDef += ` ${upperSql}(${col.length_precision})`;
                } else if (upperSql === 'ENUM' && col.length_precision) {
                    colDef += ` TEXT CHECK("${col.column_name}" IN (${col.length_precision}))`;
                } else {
                    colDef += ` ${upperSql}`;
                }
            } else {
                // 100% Backward compatibility for legacy callers without sql_type
                switch (col.col_type) {
                    case 'number': colDef += ' DECIMAL(10,2)'; break;
                    case 'boolean': colDef += ' TINYINT'; break;
                    case 'date': colDef += ' DATE'; break;
                    case 'datetime': colDef += ' DATETIME'; break;
                    case 'json': colDef += ' TEXT'; break;
                    case 'password': colDef += ` VARCHAR(${col.length_precision || 255})`; break;
                    default: colDef += ' TEXT';
                }
            }

            if (col.is_required) colDef += ' NOT NULL';
            if (col.is_unique) colDef += ' UNIQUE';

            if (col.default_type === 'CURRENT_TIMESTAMP') {
                colDef += ` DEFAULT (datetime('now', 'localtime'))`;
            } else if (col.default_type === 'NULL') {
                colDef += ` DEFAULT NULL`;
            } else if (col.default_value !== undefined && col.default_value !== null && String(col.default_value).trim() !== '') {
                const isNumeric = ['number', 'int', 'integer', 'decimal', 'boolean', 'tinyint'].includes(String(col.sql_type || col.col_type).toLowerCase());
                const dv = isNumeric ? col.default_value : `'${col.default_value}'`;
                colDef += ` DEFAULT ${dv}`;
            }

            if (col.ref_table && col.ref_col) {
                colDef += ` REFERENCES "${col.ref_table}"("${col.ref_col}") ON DELETE ${col.on_delete || 'RESTRICT'}`;
            }

            parts.push(colDef);
        }

        // always add timestamps
        parts.push(`"created_at" TEXT DEFAULT (datetime('now', 'localtime'))`);
        parts.push(`"updated_at" TEXT DEFAULT (datetime('now', 'localtime'))`);

        return `CREATE TABLE IF NOT EXISTS "${tableName}" (\n  ${parts.join(',\n  ')}\n)`;
    }

    _buildAlterAddColumn(tableName, col) {
        let def = `ALTER TABLE "${tableName}" ADD COLUMN "${col.column_name}"`;

        if (col.sql_type) {
            const upperSql = String(col.sql_type).toUpperCase();
            if (upperSql === 'PASSWORD') {
                def += ` VARCHAR(${col.length_precision || 255})`;
            } else if (upperSql === 'FK') {
                def += ' INTEGER';
            } else if (col.length_precision && ['VARCHAR', 'CHAR', 'DECIMAL', 'NUMERIC', 'FLOAT'].includes(upperSql)) {
                def += ` ${upperSql}(${col.length_precision})`;
            } else {
                def += ` ${upperSql}`;
            }
        } else {
            // 100% Backward compatibility for legacy callers without sql_type
            switch (col.col_type) {
                case 'number': def += ' DECIMAL(10,2)'; break;
                case 'boolean': def += ' TINYINT'; break;
                case 'date': def += ' DATE'; break;
                case 'datetime': def += ' DATETIME'; break;
                case 'json': def += ' TEXT'; break;
                case 'password': def += ` VARCHAR(${col.length_precision || 255})`; break;
                default: def += ' TEXT';
            }
        }

        if (col.default_value !== undefined && col.default_value !== null && String(col.default_value).trim() !== '') {
            const isNumeric = ['number', 'int', 'integer', 'decimal', 'boolean', 'tinyint'].includes(String(col.sql_type || col.col_type).toLowerCase());
            const dv = isNumeric ? col.default_value : `'${col.default_value}'`;
            def += ` DEFAULT ${dv}`;
        }

        if (col.ref_table && col.ref_col) {
            def += ` REFERENCES "${col.ref_table}"("${col.ref_col}") ON DELETE ${col.on_delete || 'RESTRICT'}`;
        }

        return def;
    }

    _getTable(tableName) {
        const row = this.db.prepare(
            `SELECT * FROM sys_table WHERE table_name = ? AND active = 1`
        ).get(tableName);
        if (!row) throw new Error(`[sutramEngine] Table "${tableName}" not found in sys_table`);
        return row;
    }

    _parseDefault(type, raw) {
        if (raw === null || raw === undefined) return undefined;
        if (type === 'number') return Number(raw);
        if (type === 'boolean') return raw === 'true' || raw === '1' ? 1 : 0;
        if (type === 'json') { try { return JSON.parse(raw); } catch { return null; } }
        return raw;
    }
}

module.exports = SchemaManager;
