// src/TriggerManager.js
// ─────────────────────────────────────────────────────────────
// Manages sutramEngine triggers — stored in sys_trigger.
// Execution is in Node.js (not SQLite triggers) so complex
// field_map logic and multi-table operations are possible.
//
// Trigger flow:
//   Engine wraps insert/update/delete calls →
//   checks trigger cache for matching event →
//   runs actions in same transaction as original operation
// ─────────────────────────────────────────────────────────────

'use strict';

class TriggerManager {

    constructor(engineOrCore) {
        this.engine = (engineOrCore && engineOrCore.core) ? engineOrCore : null;
        this.core = this.engine ? this.engine.core : (typeof engineOrCore?.query === 'function' ? engineOrCore : null);
        this.db = this.core?.db || (!this.core ? engineOrCore : null);
        // cache: { 'products:INSERT': [{ ...trigger, actions: [...] }] }
        this._cache = {};
    }

    _q(id) {
        return this.core?.quoteId ? this.core.quoteId(id) : `"${String(id).replace(/"/g, '""')}"`;
    }

    async _query(sql, params = []) {
        if (this.core?.query) return await this.core.query(sql, params);
        if (this.db?.prepare) return this.db.prepare(sql).all(...(Array.isArray(params) ? params : [params]));
        return [];
    }

    async _queryOne(sql, params = []) {
        if (this.core?.queryOne) return await this.core.queryOne(sql, params);
        if (this.db?.prepare) return this.db.prepare(sql).get(...(Array.isArray(params) ? params : [params])) ?? null;
        return null;
    }

    async _run(sql, params = []) {
        if (this.core?.run) return await this.core.run(sql, params);
        if (this.db?.prepare) return this.db.prepare(sql).run(...(Array.isArray(params) ? params : [params]));
        return { changes: 0 };
    }

    // ─────────────────────────────────────────────────────────
    // BOOTSTRAP — load all triggers from sys_trigger into cache
    // Called by Engine.rebootstrap()
    // ─────────────────────────────────────────────────────────

    // load from sys_ tables — managed mode
    async load() {
        this._cache = {};

        try {
            const triggers = await this._query(
                `SELECT * FROM sys_trigger WHERE active = 1`
            );

            for (const trigger of triggers) {
                const actions = await this._query(
                    `SELECT * FROM sys_trigger_action
                     WHERE trigger_id = ? AND active = 1
                     ORDER BY sort_order ASC`,
                    [trigger._id]
                );

                const key = `${trigger.source_table}:${trigger.event}`;
                if (!this._cache[key]) this._cache[key] = [];
                this._cache[key].push({ ...trigger, actions });
            }

            const count = Object.values(this._cache).flat().length;
            console.log(`[sutramEngine] ✓ ${count} trigger(s) loaded from sys_`);
        } catch (err) {
            console.warn('[sutramEngine] TriggerManager load notice:', err.message);
        }
    }

    // load from array — direct mode
    // accepts same format as triggers.js
    loadFromArray(triggers = []) {
        this._cache = {};

        for (const trigger of triggers) {
            if (!trigger.trigger_name || !trigger.source_table || !trigger.event) continue;
            if (trigger.active === false) continue;

            const actions = (trigger.actions ?? []).map((a, i) => ({
                action_type:  a.action_type,
                sort_order:   a.sort_order ?? i,
                target_table: a.target_table ?? null,
                field_map:    a.field_map ? JSON.stringify(a.field_map) : '{}',
                condition:    a.condition ?? null,
                raw_sql:      a.raw_sql   ?? null,
                active:       1,
            }));

            const normalizedTrigger = {
                trigger_name:    trigger.trigger_name,
                source_table:    trigger.source_table,
                event:           trigger.event.toUpperCase(),
                condition_type:  trigger.condition_type  ?? 'always',
                condition_col:   trigger.condition_col   ?? null,
                condition_value: trigger.condition_value ?? null,
                condition_sql:   trigger.condition_sql   ?? null,
                active:          1,
                actions,
            };

            const key = `${trigger.source_table}:${trigger.event.toUpperCase()}`;
            if (!this._cache[key]) this._cache[key] = [];
            this._cache[key].push(normalizedTrigger);
        }

        const count = Object.values(this._cache).flat().length;
        console.log(`[sutramEngine] ✓ ${count} trigger(s) loaded from array`);
    }

    // ─────────────────────────────────────────────────────────
    // CREATE TRIGGER
    // def: {
    //   trigger_name, label?, source_table, event,
    //   condition_type?, condition_col?, condition_value?, condition_sql?,
    //   actions: [
    //     { sort_order?, action_type, target_table?,
    //       field_map?, condition?, raw_sql? }
    //   ]
    // }
    // ─────────────────────────────────────────────────────────

    async create(def) {
        if (!def.trigger_name) throw new Error('[sutramEngine] trigger_name required');
        if (!def.source_table) throw new Error('[sutramEngine] source_table required');
        if (!def.event)        throw new Error('[sutramEngine] event required (INSERT/UPDATE/DELETE)');
        if (!Array.isArray(def.actions) || def.actions.length === 0) {
            throw new Error('[sutramEngine] at least one action required');
        }

        const needTx = this.core ? !this.core.inTransaction : !this.db?.inTransaction;
        let triggerId;
        try {
            if (needTx && this.core?.begin) await this.core.begin();
            else if (needTx && this.db) this.db.prepare('BEGIN').run();

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
                def.condition_type  ?? 'always',
                def.condition_col   ?? null,
                def.condition_value ?? null,
                def.condition_sql   ?? null,
            ]);

            triggerId = res.insertId ?? res.lastInsertRowid;

            for (let i = 0; i < def.actions.length; i++) {
                const action = def.actions[i];
                await this._run(`
                    INSERT INTO sys_trigger_action
                      (trigger_id, sort_order, action_type, target_table,
                       field_map, ${this._q('condition')}, raw_sql)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                `, [
                    triggerId,
                    action.sort_order ?? i,
                    action.action_type,
                    action.target_table ?? null,
                    action.field_map ? JSON.stringify(action.field_map) : '{}',
                    action.condition  ?? null,
                    action.raw_sql    ?? null,
                ]);
            }

            if (needTx && this.core?.commit) await this.core.commit();
            else if (needTx && this.db) this.db.prepare('COMMIT').run();
        } catch (err) {
            if (needTx && this.core?.rollback) await this.core.rollback();
            else if (needTx && this.db?.inTransaction) this.db.prepare('ROLLBACK').run();
            throw err;
        }

        await this.load(); // refresh cache
        console.log(`[sutramEngine] ✓ Trigger "${def.trigger_name}" created`);
        return triggerId;
    }

    // ─────────────────────────────────────────────────────────
    // ENABLE / DISABLE
    // ─────────────────────────────────────────────────────────

    async enable(triggerId) {
        await this._run(`UPDATE sys_trigger SET active = 1 WHERE _id = ?`, [triggerId]);
        await this.load();
    }

    async disable(triggerId) {
        await this._run(`UPDATE sys_trigger SET active = 0 WHERE _id = ?`, [triggerId]);
        await this.load();
    }

    async delete(triggerId) {
        // CASCADE handles sys_trigger_action rows
        await this._run(`DELETE FROM sys_trigger WHERE _id = ?`, [triggerId]);
        await this.load();
    }

    async getTriggers() {
        return await this._query(`SELECT * FROM sys_trigger ORDER BY _id ASC`);
    }

    async getActions(triggerId) {
        return await this._query(
            `SELECT * FROM sys_trigger_action WHERE trigger_id = ? ORDER BY sort_order ASC`,
            [triggerId]
        );
    }

    // ─────────────────────────────────────────────────────────
    // EXECUTE — called by Engine after insert/update/delete
    // ─────────────────────────────────────────────────────────

    async execute(tableName, event, newRow, oldRow = null) {
        const key      = `${tableName}:${event}`;
        const triggers = this._cache[key];
        if (!triggers || triggers.length === 0) return;

        for (const trigger of triggers) {
            if (!(await this._checkCondition(trigger, newRow, oldRow))) continue;

            for (const action of trigger.actions) {
                await this._runAction(action, newRow, oldRow);
            }
        }
    }

    // ─────────────────────────────────────────────────────────
    // PRIVATE — condition check
    // ─────────────────────────────────────────────────────────

    async _checkCondition(trigger, newRow, oldRow) {
        switch (trigger.condition_type) {

            case 'always':
                return true;

            case 'when_col_equals': {
                const row = newRow ?? oldRow;
                if (!trigger.condition_col || !row) return false;
                return String(row[trigger.condition_col]) === String(trigger.condition_value);
            }

            case 'raw_sql':
                try {
                    const row = newRow ?? oldRow ?? {};
                    let expr = String(trigger.condition_sql || '1=0');
                    const params = [];
                    expr = expr.replace(/:([a-zA-Z0-9_]+)/g, (_, key) => {
                        params.push(row[key] ?? null);
                        return '?';
                    });
                    const sql = `SELECT CASE WHEN (${expr}) THEN 1 ELSE 0 END as result`;
                    const res = await this._queryOne(sql, params);
                    return Number(res?.result) === 1;
                } catch {
                    return false;
                }

            default:
                return true;
        }
    }

    // ─────────────────────────────────────────────────────────
    // PRIVATE — run single action
    // ─────────────────────────────────────────────────────────

    async _runAction(action, newRow, oldRow) {
        switch (action.action_type) {

            case 'insert_row': {
                const fieldMap = JSON.parse(action.field_map ?? '{}');
                const data     = this._resolveFieldMap(fieldMap, newRow, oldRow);
                if (Object.keys(data).length === 0) return;

                const keys   = Object.keys(data);
                const sql    = `INSERT INTO ${this._q(action.target_table)}
                                (${keys.map(k => this._q(k)).join(', ')})
                                VALUES (${keys.map(() => '?').join(', ')})`;
                await this._run(sql, Object.values(data));
                break;
            }

            case 'update_row': {
                const fieldMap  = JSON.parse(action.field_map ?? '{}');
                const resolved  = this._resolveFieldMap(fieldMap, newRow, oldRow);

                if (!action.condition) {
                    console.warn('[sutramEngine] update_row action missing condition — skipped');
                    return;
                }

                const updateKeys = Object.keys(resolved).filter(k => k !== '__where__');
                if (updateKeys.length === 0) return;

                const setCols = updateKeys.map(k => `${this._q(k)} = ?`).join(', ');
                const sql     = `UPDATE ${this._q(action.target_table)} SET ${setCols} WHERE ${action.condition}`;
                await this._run(sql, updateKeys.map(k => resolved[k]));
                break;
            }

            case 'delete_row': {
                if (!action.condition) {
                    console.warn('[sutramEngine] delete_row action missing condition — skipped');
                    return;
                }
                const sql = `DELETE FROM ${this._q(action.target_table)} WHERE ${action.condition}`;
                await this._run(sql);
                break;
            }

            case 'raw_sql': {
                if (!action.raw_sql) return;
                try {
                    await this._run(action.raw_sql);
                } catch (err) {
                    console.error(`[sutramEngine] raw_sql action failed: ${err.message}`);
                    throw err;
                }
                break;
            }

            default:
                console.warn(`[sutramEngine] Unknown action_type: ${action.action_type}`);
        }
    }

    // ─────────────────────────────────────────────────────────
    // PRIVATE — resolve field_map values
    //
    // field_map format:
    //   { "target_col": "new.source_col" }   → value from newRow
    //   { "target_col": "old.source_col" }   → value from oldRow
    //   { "target_col": "literal:hello" }    → literal string
    //   { "target_col": "literal:42" }       → literal value
    // ─────────────────────────────────────────────────────────

    _resolveFieldMap(fieldMap, newRow, oldRow) {
        const result = {};

        for (const [targetCol, source] of Object.entries(fieldMap)) {
            if (typeof source === 'string') {
                if (source.startsWith('new.')) {
                    const col = source.slice(4);
                    result[targetCol] = newRow?.[col] ?? null;

                } else if (source.startsWith('old.')) {
                    const col = source.slice(4);
                    result[targetCol] = oldRow?.[col] ?? null;

                } else if (source.startsWith('literal:')) {
                    result[targetCol] = source.slice(8);

                } else {
                    // assume it's a column name from newRow
                    result[targetCol] = newRow?.[source] ?? null;
                }
            } else {
                // direct literal value
                result[targetCol] = source;
            }
        }

        return result;
    }
}

module.exports = TriggerManager;
