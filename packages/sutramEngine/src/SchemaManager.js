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

    constructor(db, rebootstrap, engine = null) {
        this.engine = engine;
        this.core = engine?.core || null;
        this.db = db || this.core?.db || null;
        this.rebootstrap = rebootstrap; // callback → Engine.rebootstrap()
        // Only run sync SQLite hl check immediately if constructed standalone with legacy db
        if (!this.core && this.db && typeof this.db.prepare === 'function') {
            this.ensureHlColumns();
        }
    }

    _getCore() {
        return this.engine?.core || this.core;
    }

    _q(id) {
        const core = this._getCore();
        return core?.quoteId ? core.quoteId(id) : `"${String(id).replace(/"/g, '""')}"`;
    }

    _nowStr() {
        const d = new Date();
        const pad = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }

    async _query(sql, params = []) {
        const core = this._getCore();
        if (core?.query) return await core.query(sql, params);
        if (this.db?.prepare) return this.db.prepare(sql).all(...(Array.isArray(params) ? params : [params]));
        return [];
    }

    async _queryOne(sql, params = []) {
        const core = this._getCore();
        if (core?.queryOne) return await core.queryOne(sql, params);
        if (this.db?.prepare) return this.db.prepare(sql).get(...(Array.isArray(params) ? params : [params])) ?? null;
        return null;
    }

    async _run(sql, params = []) {
        const core = this._getCore();
        if (core?.run) return await core.run(sql, params);
        if (this.db?.prepare) {
            const r = this.db.prepare(sql).run(...(Array.isArray(params) ? params : [params]));
            return { insertId: r.lastInsertRowid, lastInsertRowid: r.lastInsertRowid, changes: r.changes, affectedRows: r.changes };
        }
        return { changes: 0 };
    }

    async _upsert(tableName, conflictCols, data) {
        const core = this._getCore();
        if (core?.upsert) return await core.upsert(tableName, conflictCols, data);
        throw new Error('[sutramEngine] Core upsert() required');
    }

    // ═════════════════════════════════════════════════════════
    // ── IMPORT ALL ────────────────────────────────────────────
    // ═════════════════════════════════════════════════════════

    async importAll({ schema, triggers = [], reports = [] } = {}) {
        if (schema) await this.importSchema(schema, '_batch');
        if (triggers?.length) await this._importTriggers(triggers);
        if (reports?.length) await this._importReports(reports);
        await this.rebootstrap();
        console.log('[sutramEngine] ✓ importAll complete');
    }

    // ═════════════════════════════════════════════════════════
    // ── IMPORT SCHEMA ─────────────────────────────────────────
    // ═════════════════════════════════════════════════════════

    async importSchema(tableMeta) {
        if (!tableMeta || typeof tableMeta !== 'object') {
            throw new Error('[sutramEngine] importSchema: tableMeta must be a plain object');
        }

        let imported = 0;
        let skipped = 0;

        for (const [tableName, def] of Object.entries(tableMeta)) {
            if (tableName.startsWith('sys_')) continue;

            const exists = await this._queryOne(
                `SELECT _id FROM sys_table WHERE table_name = ?`,
                [tableName]
            );

            if (exists) {
                skipped++;
                continue;
            }

            const columns = this._parseColumns(def.columns ?? {});
            const joins = this._parseJoins(def.joins ?? {});

            await this._createTableInternal(tableName, null, null, columns, joins);
            imported++;
        }

        console.log(`[sutramEngine] importSchema — imported: ${imported}, skipped: ${skipped}`);

        if (arguments[1] !== '_batch') await this.rebootstrap();
    }

    async importTriggers(triggers) {
        if (!Array.isArray(triggers)) {
            throw new Error('[sutramEngine] importTriggers: expects an array');
        }
        await this._importTriggers(triggers);
        await this.rebootstrap();
    }

    async importReports(reports) {
        if (!Array.isArray(reports)) {
            throw new Error('[sutramEngine] importReports: expects an array');
        }
        await this._importReports(reports);
        await this.rebootstrap();
    }

    async exportAll() {
        return {
            schema: await this.exportSchema(),
            triggers: await this.exportTriggers(),
            reports: await this.exportReports(),
        };
    }

    async exportSchema() {
        const tables = await this._query(
            `SELECT * FROM sys_table WHERE active = 1 AND is_system = 0 ORDER BY _id ASC`
        );

        const result = {};

        for (const table of tables) {
            const cols = await this._query(
                `SELECT * FROM sys_column WHERE table_id = ? AND active = 1 ORDER BY sort_order ASC`,
                [table._id]
            );

            const joins = await this._query(
                `SELECT * FROM sys_join WHERE table_id = ? AND active = 1`,
                [table._id]
            );

            result[table.table_name] = {
                columns: this._exportColumns(cols),
                joins: this._exportJoins(joins),
            };
        }

        return result;
    }

    async exportTriggers() {
        const triggers = await this._query(
            `SELECT * FROM sys_trigger ORDER BY _id ASC`
        );

        const out = [];
        for (const t of triggers) {
            const actions = await this._query(
                `SELECT * FROM sys_trigger_action WHERE trigger_id = ? ORDER BY sort_order ASC`,
                [t._id]
            );

            const def = {
                trigger_name: t.trigger_name,
                label: t.label,
                source_table: t.source_table,
                event: t.event,
                active: t.active === 1,
            };

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

            out.push(def);
        }
        return out;
    }

    async exportReports() {
        const rows = await this._query(`SELECT * FROM sys_report ORDER BY _id ASC`);
        return rows.map(r => ({
            report_name: r.report_name,
            label: r.label,
            description: r.description,
            cte_sql: r.cte_sql,
            params: r.params ? JSON.parse(r.params) : [],
            active: r.active === 1,
        }));
    }

    // ═════════════════════════════════════════════════════════
    // ── ENSURE SYSTEM TABLE (Module Migrations via Engine) ────
    // ═════════════════════════════════════════════════════════

    async ensureSystemTable(def) {
        const {
            table_name,
            label = null,
            description = null,
            columns = [],
            uniqueKeys = [],
            timestamps = true,
            registerInSchema = true,
        } = def;

        if (!table_name) throw new Error('[sutramEngine] ensureSystemTable: table_name required');
        const core = this._getCore();
        if (!core || typeof core.createTable !== 'function') {
            throw new Error('[sutramEngine] Core createTable() required for ensureSystemTable');
        }

        await core.createTable({ table_name, columns, uniqueKeys, timestamps });

        if (!registerInSchema) return;

        // Register cleanly in sys_table (is_system = 1) + sys_column so Core ORM / Engine CRUD works on it
        let tableRow = await this._queryOne(`SELECT _id FROM sys_table WHERE table_name = ?`, [table_name]);
        if (!tableRow) {
            const ins = await this._run(
                `INSERT INTO sys_table (table_name, label, description, is_system, active) VALUES (?, ?, ?, 1, 1)`,
                [table_name, label ?? table_name, description ?? null]
            );
            tableRow = { _id: ins.insertId ?? ins.lastInsertRowid };
        }

        for (let i = 0; i < columns.length; i++) {
            const col = columns[i];
            const existingCol = await this._queryOne(
                `SELECT _id FROM sys_column WHERE table_id = ? AND column_name = ?`,
                [tableRow._id, col.column_name]
            );
            if (!existingCol) {
                await this._insertColumn(tableRow._id, col, col.sort_order ?? i);
            }
        }
    }

    // ═════════════════════════════════════════════════════════
    // ── CREATE TABLE ──────────────────────────────────────────
    // ═════════════════════════════════════════════════════════

    async createTable(def) {
        const { table_name, label, description, columns = [], joins = [] } = def;

        if (!table_name) throw new Error('[sutramEngine] createTable: table_name required');
        if (columns.length === 0) throw new Error('[sutramEngine] createTable: at least one column required');
        if (table_name.startsWith('sys_') || table_name.startsWith('xls_')) {
            throw new Error(`[sutramEngine] Cannot use "sys_" or "xls_" prefix — reserved for engine`);
        }

        await this._createTableInternal(table_name, label, description, columns, joins);
        await this.rebootstrap();
        console.log(`[sutramEngine] ✓ Table "${table_name}" created`);
        return { created: true, table_name };
    }

    // ─────────────────────────────────────────────────────────
    // ADD COLUMN

    async addColumn(tableName, col) {
        if (!tableName || !col?.column_name) {
            throw new Error('[sutramEngine] addColumn: tableName and col.column_name required');
        }

        const tableRow = await this._getTable(tableName);
        const maxOrder = (await this._queryOne(
            `SELECT MAX(sort_order) as m FROM sys_column WHERE table_id = ?`,
            [tableRow._id]
        ))?.m ?? -1;

        await this._insertColumn(tableRow._id, col, maxOrder + 1);
        await this._getCore().addColumn(tableName, col);

        await this.rebootstrap();
        console.log(`[sutramEngine] ✓ Column "${col.column_name}" added to "${tableName}"`);
    }

    // ─────────────────────────────────────────────────────────
    // DROP COLUMN

    async dropColumn(tableName, columnName) {
        const tableRow = await this._getTable(tableName);
        const colRow = await this._queryOne(
            `SELECT * FROM sys_column WHERE table_id = ? AND column_name = ?`,
            [tableRow._id, columnName]
        );

        if (!colRow) throw new Error(`[sutramEngine] Column "${columnName}" not found in "${tableName}"`);
        if (colRow.is_pk) throw new Error(`[sutramEngine] Cannot drop primary key column`);

        const refs = await this.getReferencingConstraints(tableName, columnName);
        if (refs.length > 0) {
            const err = new Error(
                `Cannot drop column "${tableName}.${columnName}": referenced by ${refs.map(r => `"${r.table_name}.${r.column_name}"`).join(', ')}. Remove referencing foreign key(s) first.`
            );
            err.statusCode = 409;
            throw err;
        }

        await this._run(`DELETE FROM sys_column WHERE _id = ?`, [colRow._id]);
        await this._getCore().dropColumn(tableName, columnName);

        await this.rebootstrap();
        console.log(`[sutramEngine] ✓ Column "${columnName}" dropped from "${tableName}"`);
    }

    // ─────────────────────────────────────────────────────────
    // ADD JOIN

    async addJoin(tableName, join) {
        const tableRow = await this._getTable(tableName);
        await this._insertJoin(tableRow._id, join);
        await this.rebootstrap();
        console.log(`[sutramEngine] ✓ Join "${join.join_key}" added to "${tableName}"`);
    }

    // ─────────────────────────────────────────────────────────
    // REMOVE JOIN

    async removeJoin(tableName, joinKey) {
        const tableRow = await this._getTable(tableName);
        const joinRow = await this._queryOne(
            `SELECT * FROM sys_join WHERE table_id = ? AND join_key = ?`,
            [tableRow._id, joinKey]
        );

        if (!joinRow) throw new Error(`[sutramEngine] Join "${joinKey}" not found in "${tableName}"`);

        await this._run(`DELETE FROM sys_join WHERE _id = ?`, [joinRow._id]);
        await this.rebootstrap();
        console.log(`[sutramEngine] ✓ Join "${joinKey}" removed from "${tableName}"`);
    }

    // ─────────────────────────────────────────────────────────
    // REFERENCING FK CONSTRAINTS CHECK (sys_column + Core FK introspection)

    async getReferencingConstraints(tableName, columnName = null) {
        const seen = new Set();
        const refs = [];

        // 1. Metadata check via sys_column
        try {
            const sysRefs = await this._query(`
                SELECT t.table_name, c.column_name, COALESCE(c.ref_col, '_id') as ref_col
                FROM sys_column c
                JOIN sys_table t ON t._id = c.table_id
                WHERE c.ref_table = ? AND c.active = 1 AND t.active = 1 AND t.table_name != ?
            `, [tableName, tableName]);

            for (const r of sysRefs) {
                if (columnName && r.ref_col !== columnName) continue;
                const key = `${r.table_name}.${r.column_name}->${r.ref_col}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    refs.push({ table_name: r.table_name, column_name: r.column_name, ref_col: r.ref_col || '_id' });
                }
            }
        } catch {}

        // 2. Physical FK introspection via Core
        try {
            const core = this._getCore();
            if (core?.getForeignKeysTo) {
                const physFks = await core.getForeignKeysTo(tableName);
                for (const fk of physFks) {
                    const targetCol = fk.ref_col || '_id';
                    if (columnName && targetCol !== columnName) continue;
                    const key = `${fk.table_name}.${fk.column_name}->${targetCol}`;
                    if (!seen.has(key)) {
                        seen.add(key);
                        refs.push({ table_name: fk.table_name, column_name: fk.column_name, ref_col: targetCol });
                    }
                }
            }
        } catch {}

        return refs;
    }

    // ─────────────────────────────────────────────────────────
    // TABLE IMPACT CHECK (for Edit / Delete safety warnings)

    async getTableImpact(tableName) {
        const tableRow = await this._getTable(tableName);
        let rowCount = 0;
        try {
            rowCount = Number((await this._queryOne(`SELECT COUNT(*) as c FROM ${this._q(tableName)}`))?.c || 0);
        } catch {}

        const referencingTables = await this.getReferencingConstraints(tableName);

        return {
            table_name: tableName,
            label: tableRow.label || tableName,
            rowCount,
            referencingTables
        };
    }

    // ─────────────────────────────────────────────────────────
    // UPDATE TABLE (Delegates physical DDL mutation to Core)

    async updateTable(tableName, def = {}) {
        const tableRow = await this._getTable(tableName);
        if (tableRow.is_system) {
            throw new Error(`[sutramEngine] Cannot edit system table "${tableName}"`);
        }

        const { label, description, columns } = def;
        const existingCols = await this._query(
            `SELECT * FROM sys_column WHERE table_id = ? AND active = 1 ORDER BY sort_order ASC`,
            [tableRow._id]
        );

        const existingMap = new Map(existingCols.map(c => [c.column_name, c]));

        // If only table label/description changed
        if (!Array.isArray(columns) || columns.length === 0) {
            await this._run(`
                UPDATE sys_table
                SET label = ?, description = ?, updated_at = ?
                WHERE _id = ?
            `, [label ?? tableRow.label, description !== undefined ? description : tableRow.description, this._nowStr(), tableRow._id]);
            await this.rebootstrap();
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

        const seenNames = new Set();
        for (const c of incoming) {
            if (seenNames.has(c.column_name)) {
                throw new Error(`[sutramEngine] Duplicate column name "${c.column_name}"`);
            }
            seenNames.add(c.column_name);
        }

        const core = this._getCore();
        const inspected = await core.inspectTable(tableName);
        const physicalNames = new Set((inspected.columns || []).map(p => p.name));
        const indexedCols = new Set();
        for (const idx of (inspected.indexes || [])) {
            for (const cName of (idx.columns || [])) indexedCols.add(cName);
        }

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
            const colRefs = await this.getReferencingConstraints(tableName, rc.column_name);
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

        const alterRes = await core.alterTable(tableName, {
            incoming,
            addedCols,
            removedCols,
            renamedCols,
            existingMap,
            needsRebuild,
            physicalNames
        });

        await this._run(`
            UPDATE sys_table
            SET label = ?, description = ?, updated_at = ?
            WHERE _id = ?
        `, [label ?? tableRow.label, description !== undefined ? description : tableRow.description, this._nowStr(), tableRow._id]);

        for (const ren of renamedCols) {
            await this._run(`
                UPDATE sys_column SET ref_col = ? WHERE ref_table = ? AND ref_col = ?
            `, [ren.to, tableName, ren.from]);
        }

        await this._run(`DELETE FROM sys_column WHERE table_id = ?`, [tableRow._id]);
        for (let i = 0; i < incoming.length; i++) {
            await this._insertColumn(tableRow._id, incoming[i], i);
        }

        await this.rebootstrap();
        console.log(`[sutramEngine] ✓ Table "${tableName}" updated via ${alterRes.strategy} (${incoming.length} columns)`);
        return {
            strategy: alterRes.strategy,
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

    async dropTable(tableName) {
        const tableRow = await this._getTable(tableName);
        if (tableRow.is_system) throw new Error(`[sutramEngine] Cannot drop system table "${tableName}"`);

        const refs = await this.getReferencingConstraints(tableName);
        if (refs.length > 0) {
            const refList = refs.map(r => `"${r.table_name}" (column: ${r.column_name})`).join(', ');
            const err = new Error(
                `Cannot delete table "${tableName}" because it is referenced by: ${refList}. Delete the referencing table(s) or remove their foreign key columns first.`
            );
            err.statusCode = 409;
            throw err;
        }

        try { await this._run(`DELETE FROM sys_user_rights WHERE table_name = ?`, [tableName]); } catch {}
        try { await this._run(`DELETE FROM sys_column_security WHERE table_name = ?`, [tableName]); } catch {}
        await this._run(`DELETE FROM sys_column WHERE table_id = ?`, [tableRow._id]);
        await this._run(`DELETE FROM sys_join WHERE table_id = ?`, [tableRow._id]);
        await this._run(`DELETE FROM sys_table WHERE _id = ?`, [tableRow._id]);
        await this._getCore().dropTable(tableName);

        await this.rebootstrap();
        console.log(`[sutramEngine] ✓ Table "${tableName}" dropped`);
    }

    // ─────────────────────────────────────────────────────────
    // LIST

    async getTables() {
        return await this._query(`SELECT * FROM sys_table WHERE active = 1 ORDER BY _id ASC`);
    }

    async getTableDetail(tableName) {
        const tableRow = await this._getTable(tableName);
        const columns = await this._query(
            `SELECT * FROM sys_column WHERE table_id = ? AND active = 1 ORDER BY sort_order ASC`,
            [tableRow._id]
        );
        const joins = await this._query(
            `SELECT * FROM sys_join WHERE table_id = ? AND active = 1`,
            [tableRow._id]
        );
        return { ...tableRow, columns, joins };
    }

    // ═════════════════════════════════════════════════════════
    // ── PRIVATE — IMPORT HELPERS ──────────────────────────────
    // ═════════════════════════════════════════════════════════

    async _importTriggers(triggers) {
        let imported = 0;
        let skipped = 0;

        for (const def of triggers) {
            if (!def.trigger_name) {
                console.warn('[sutramEngine] importTriggers: skipping entry without trigger_name');
                continue;
            }

            const exists = await this._queryOne(
                `SELECT _id FROM sys_trigger WHERE trigger_name = ?`,
                [def.trigger_name]
            );

            if (exists) { skipped++; continue; }

            const res = await this._run(`
                INSERT INTO sys_trigger
                  (trigger_name, label, source_table, event,
                   condition_type, condition_col, condition_value, condition_sql)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                def.trigger_name,
                def.label ?? def.trigger_name,
                def.source_table,
                def.event.toUpperCase(),
                def.condition_type ?? 'always',
                def.condition_col ?? null,
                def.condition_value ?? null,
                def.condition_sql ?? null,
            ]);

            const triggerId = res.insertId ?? res.lastInsertRowid;

            for (let i = 0; i < (def.actions ?? []).length; i++) {
                const a = def.actions[i];
                await this._run(`
                    INSERT INTO sys_trigger_action
                      (trigger_id, sort_order, action_type, target_table,
                       field_map, ${this._q('condition')}, raw_sql)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                `, [
                    triggerId,
                    a.sort_order ?? i,
                    a.action_type,
                    a.target_table ?? null,
                    a.field_map ? JSON.stringify(a.field_map) : '{}',
                    a.condition ?? null,
                    a.raw_sql ?? null,
                ]);
            }

            imported++;
        }

        console.log(`[sutramEngine] importTriggers — imported: ${imported}, skipped: ${skipped}`);
    }

    async _importReports(reports) {
        let imported = 0;
        let skipped = 0;

        for (const def of reports) {
            if (!def.report_name) {
                console.warn('[sutramEngine] importReports: skipping entry without report_name');
                continue;
            }

            const exists = await this._queryOne(
                `SELECT _id FROM sys_report WHERE report_name = ?`,
                [def.report_name]
            );

            if (exists) { skipped++; continue; }

            await this._run(`
                INSERT INTO sys_report (report_name, label, description, cte_sql, params)
                VALUES (?, ?, ?, ?, ?)
            `, [
                def.report_name,
                def.label ?? def.report_name,
                def.description ?? null,
                def.cte_sql,
                JSON.stringify(def.params ?? []),
            ]);

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

    async ensureHlColumns() {
        const core = this._getCore();
        if (!core) return;
        try {
            const tables = await this._query(`SELECT _id, table_name FROM sys_table WHERE is_system = 0 AND active = 1`);
            for (const t of tables) {
                const info = await core.inspectTable(t.table_name);
                if (!info.columns.some(c => c.name === 'hl')) {
                    try {
                        await core.addColumn(t.table_name, {
                            column_name: 'hl',
                            col_type: 'number',
                            sql_type: 'TINYINT',
                            default_value: '0'
                        });
                    } catch {}
                }
                const sysCol = await this._queryOne(
                    `SELECT _id FROM sys_column WHERE table_id = ? AND column_name = 'hl'`,
                    [t._id]
                );
                if (!sysCol) {
                    const maxOrder = (await this._queryOne(
                        `SELECT MAX(sort_order) as m FROM sys_column WHERE table_id = ?`,
                        [t._id]
                    ))?.m ?? 99;
                    await this._upsert('sys_column', ['table_id', 'column_name'], {
                        table_id: t._id,
                        column_name: 'hl',
                        label: 'Highlight Flag',
                        col_type: 'number',
                        is_required: 0,
                        default_value: '0',
                        is_pk: 0,
                        sort_order: maxOrder + 1
                    });
                }
            }
            try {
                await this._run(`UPDATE sys_column SET is_required = 0 WHERE column_name = '_id'`);
            } catch {}
        } catch {}
    }

    // Internal create — no rebootstrap (caller decides when)
    async _createTableInternal(tableName, label, description, columns, joins) {
        const core = this._getCore();
        if (!core) throw new Error('[sutramEngine] Core instance required to create tables');

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

        const tableRes = await this._run(`
            INSERT INTO sys_table (table_name, label, description)
            VALUES (?, ?, ?)
        `, [tableName, label ?? tableName, description ?? null]);

        const tableId = tableRes.insertId ?? tableRes.lastInsertRowid;

        for (let i = 0; i < allColumns.length; i++) {
            await this._insertColumn(tableId, allColumns[i], allColumns[i].sort_order ?? i);
        }

        for (const join of (joins || [])) {
            await this._insertJoin(tableId, join);
        }

        // Delegate physical table + index DDL purely to Core
        await core.createTable({ table_name: tableName, columns: allColumns });
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

    async _insertColumn(tableId, col, sortOrder) {
        const refSelectVal = Array.isArray(col.ref_select)
            ? JSON.stringify(col.ref_select)
            : (col.ref_select ? String(col.ref_select) : null);

        const normalizedType = this._normalizeColType(col);

        await this._run(`
            INSERT INTO sys_column
              (table_id, column_name, label, col_type, is_required, default_value,
               is_pk, ref_table, ref_col, ref_as, ref_select, sort_order)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
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
        ]);
    }

    async _insertJoin(tableId, join) {
        if (!join.join_type || !join.join_key || !join.child_table) {
            throw new Error('[sutramEngine] join requires: join_type, join_key, child_table');
        }
        if (join.join_type === 'manyToMany' && !join.junction_table) {
            throw new Error('[sutramEngine] manyToMany join requires junction_table');
        }

        await this._run(`
            INSERT INTO sys_join
              (table_id, join_type, join_key, child_table, junction_table,
               fk_col, target_col, as_name, select_cols)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            tableId,
            join.join_type,
            join.join_key,
            join.child_table,
            join.junction_table ?? null,
            join.fk_col,
            join.target_col,
            join.as_name ?? join.join_key,
            join.select_cols ?? '["*"]',
        ]);
    }

    _buildCreateSQL(tableName, columns) {
        const core = this._getCore();
        if (core?.buildCreateTableSQL) {
            return core.buildCreateTableSQL({ table_name: tableName, columns });
        }
        return '';
    }

    async _getTable(tableName) {
        const row = await this._queryOne(
            `SELECT * FROM sys_table WHERE table_name = ? AND active = 1`,
            [tableName]
        );
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
