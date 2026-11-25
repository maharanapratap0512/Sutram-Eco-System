// src/ReminderManager.js
// ─────────────────────────────────────────────────────────────
// SutramEngine Inbuilt Reminder & Smart Watchdog System
//
// • Zero-Domain Hardcoding: 100% database-agnostic universal engine.
// • Evaluates both Normal Alarms & Smart Data-Driven Watchdog Rules.
// • Datatype-Adaptive Condition Operators (number, date, string, boolean).
// • Missed Run Guarantee (startup catch-up if computer was off).
// • Permanent Always-on-Top Alerts with Automatic DB Resolution.
// ─────────────────────────────────────────────────────────────

'use strict';

class ReminderManager {

    constructor(engine) {
        this.engine = engine;
        this.core = engine.core || null;
        this.db = engine.db?.db || engine.db || null;
        this._cache = [];
        this._isEvaluating = false;
    }

    _q(id) {
        return this.core?.quoteId ? this.core.quoteId(id) : `"${String(id).replace(/"/g, '""')}"`;
    }

    _nowStr(offsetMinutes = 0) {
        const d = new Date(Date.now() + offsetMinutes * 60000);
        const pad = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }

    _dateStr(offsetDays = 0) {
        const d = new Date(Date.now() + offsetDays * 86400000);
        const pad = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }

    async _query(sql, params = []) {
        const core = this.engine.core || this.core;
        if (core?.query) return await core.query(sql, params);
        const db = this._getDb();
        if (db?.prepare) return db.prepare(sql).all(...(Array.isArray(params) ? params : [params]));
        return [];
    }

    async _queryOne(sql, params = []) {
        const core = this.engine.core || this.core;
        if (core?.queryOne) return await core.queryOne(sql, params);
        const db = this._getDb();
        if (db?.prepare) return db.prepare(sql).get(...(Array.isArray(params) ? params : [params])) ?? null;
        return null;
    }

    async _run(sql, params = []) {
        const core = this.engine.core || this.core;
        if (core?.run) return await core.run(sql, params);
        const db = this._getDb();
        if (db?.prepare) {
            const r = db.prepare(sql).run(...(Array.isArray(params) ? params : [params]));
            return { insertId: r.lastInsertRowid, lastInsertRowid: r.lastInsertRowid, changes: r.changes, affectedRows: r.changes };
        }
        return { changes: 0 };
    }

    // ─────────────────────────────────────────────────────────
    // BOOTSTRAP — Load active rules into cache
    // ─────────────────────────────────────────────────────────

    async load() {
        this._cache = [];
        try {
            const core = this.engine.core || this.core;
            const hasTbl = core?.hasTable
                ? await core.hasTable('sys_reminder_rule')
                : Boolean(this._getDb()?.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='sys_reminder_rule'`).get());

            if (!hasTbl) return;

            const rules = await this._query(`SELECT * FROM sys_reminder_rule WHERE active = 1 ORDER BY _id ASC`);
            this._cache = rules || [];
            console.log(`[sutramEngine] ✓ ${this._cache.length} reminder rule(s) loaded from sys_`);
        } catch (err) {
            console.warn('[sutramEngine] Warning loading reminder rules:', err.message);
        }
    }

    // ─────────────────────────────────────────────────────────
    // RULE MANAGEMENT (CRUD)
    // ─────────────────────────────────────────────────────────

    async getRules(filter = {}) {
        const core = this.engine.core || this.core;
        if (core?.hasTable) {
            const exists = await core.hasTable('sys_reminder_rule');
            if (!exists) return [];
        }

        let sql = `SELECT * FROM sys_reminder_rule WHERE 1=1`;
        const params = [];

        if (filter.active !== undefined) {
            sql += ` AND active = ?`;
            params.push(filter.active ? 1 : 0);
        }
        if (filter.reminder_type) {
            sql += ` AND reminder_type = ?`;
            params.push(filter.reminder_type);
        }
        if (filter.target_table) {
            sql += ` AND target_table = ?`;
            params.push(filter.target_table);
        }

        sql += ` ORDER BY _id DESC`;
        return await this._query(sql, params);
    }

    async getRuleById(id) {
        return await this._queryOne(`SELECT * FROM sys_reminder_rule WHERE _id = ?`, [id]);
    }

    async createRule(ruleDef) {
        if (!ruleDef.rule_name || !String(ruleDef.rule_name).trim()) {
            throw new Error('Rule name is required');
        }
        if (!ruleDef.reminder_type || !['normal', 'smart_watchdog'].includes(ruleDef.reminder_type)) {
            throw new Error('reminder_type must be either "normal" or "smart_watchdog"');
        }

        if (ruleDef.reminder_type === 'smart_watchdog') {
            if (!ruleDef.target_table) throw new Error('target_table is required for smart_watchdog reminders');
            if (!ruleDef.target_column) throw new Error('target_column is required for smart_watchdog reminders');
            if (!ruleDef.operator) throw new Error('operator is required for smart_watchdog reminders');
        } else {
            if (!ruleDef.target_datetime) throw new Error('target_datetime is required for normal reminders');
        }

        const info = await this._run(`
            INSERT INTO sys_reminder_rule (
                rule_name, reminder_type, severity, is_permanent,
                target_datetime, notes, target_table, target_column, col_type,
                operator, operand_value, condition_json, schedule_time,
                frequency, catch_up_if_missed, message_template, sound_chime,
                active, created_by
            ) VALUES (
                ?, ?, ?, ?,
                ?, ?, ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?
            )
        `, [
            String(ruleDef.rule_name).trim(),
            ruleDef.reminder_type,
            ruleDef.severity || 'warning',
            ruleDef.is_permanent ? 1 : 0,
            ruleDef.target_datetime || null,
            ruleDef.notes || null,
            ruleDef.target_table || null,
            ruleDef.target_column || null,
            ruleDef.col_type || 'string',
            ruleDef.operator || '=',
            ruleDef.operand_value !== undefined && ruleDef.operand_value !== null ? String(ruleDef.operand_value) : null,
            ruleDef.condition_json ? (typeof ruleDef.condition_json === 'string' ? ruleDef.condition_json : JSON.stringify(ruleDef.condition_json)) : null,
            ruleDef.schedule_time || null,
            ruleDef.frequency || 'daily_once',
            ruleDef.catch_up_if_missed !== 0 ? 1 : 0,
            ruleDef.message_template || ruleDef.rule_name,
            ruleDef.sound_chime || 'default',
            ruleDef.active !== 0 ? 1 : 0,
            ruleDef.created_by || 'system'
        ]);

        await this.load();
        return info.insertId ?? info.lastInsertRowid;
    }

    async updateRule(id, updates) {
        const existing = await this.getRuleById(id);
        if (!existing) throw new Error(`Reminder rule with ID ${id} not found`);

        const merged = { ...existing, ...updates };

        await this._run(`
            UPDATE sys_reminder_rule SET
                rule_name = ?, reminder_type = ?, severity = ?, is_permanent = ?,
                target_datetime = ?, notes = ?, target_table = ?, target_column = ?, col_type = ?,
                operator = ?, operand_value = ?, condition_json = ?, schedule_time = ?,
                frequency = ?, catch_up_if_missed = ?, message_template = ?, sound_chime = ?,
                active = ?, updated_at = ?
            WHERE _id = ?
        `, [
            merged.rule_name,
            merged.reminder_type,
            merged.severity,
            merged.is_permanent ? 1 : 0,
            merged.target_datetime,
            merged.notes,
            merged.target_table,
            merged.target_column,
            merged.col_type,
            merged.operator,
            merged.operand_value !== undefined && merged.operand_value !== null ? String(merged.operand_value) : null,
            merged.condition_json ? (typeof merged.condition_json === 'string' ? merged.condition_json : JSON.stringify(merged.condition_json)) : null,
            merged.schedule_time,
            merged.frequency,
            merged.catch_up_if_missed ? 1 : 0,
            merged.message_template,
            merged.sound_chime,
            merged.active ? 1 : 0,
            this._nowStr(),
            id
        ]);

        await this.load();
        return true;
    }

    async deleteRule(id) {
        await this._run(`DELETE FROM sys_reminder_log WHERE rule_id = ?`, [id]);
        const res = await this._run(`DELETE FROM sys_reminder_rule WHERE _id = ?`, [id]);
        await this.load();
        return (res.changes ?? res.affectedRows ?? 0) > 0;
    }

    // ─────────────────────────────────────────────────────────
    // DYNAMIC CONDITION BUILDER (ANSI Dialect-Neutral SQL)
    // ─────────────────────────────────────────────────────────

    buildConditionSql(rule) {
        const col = String(rule.target_column || '').replace(/[^a-zA-Z0-9_]/g, '');
        if (!col) throw new Error('Invalid column name in rule');
        const qCol = this._q(col);

        const op = String(rule.operator || '=').toLowerCase();
        const val = rule.operand_value;
        const colType = String(rule.col_type || 'string').toLowerCase();

        let whereClause = '';
        const params = [];

        // 1. Number Operators
        if (colType === 'number' || ['<', '<=', '>', '>=', 'between'].includes(op)) {
            const num = Number(val);
            const castExpr = `CAST(${qCol} AS DECIMAL(18,4))`;
            if (op === '<') {
                whereClause = `${castExpr} < ?`;
                params.push(num);
            } else if (op === '<=') {
                whereClause = `${castExpr} <= ?`;
                params.push(num);
            } else if (op === '>') {
                whereClause = `${castExpr} > ?`;
                params.push(num);
            } else if (op === '>=') {
                whereClause = `${castExpr} >= ?`;
                params.push(num);
            } else if (op === '=' || op === '==') {
                whereClause = `${castExpr} = ?`;
                params.push(num);
            } else if (op === '!=' || op === '<>') {
                whereClause = `${castExpr} != ?`;
                params.push(num);
            } else if (op === 'between') {
                const [min, max] = String(val).split(',').map(s => Number(s.trim()));
                whereClause = `${castExpr} BETWEEN ? AND ?`;
                params.push(min || 0, max || 0);
            }
        }
        // 2. Date Operators (computed via JS dates so zero dialect syntax divergence)
        else if (colType === 'date' || colType === 'datetime' || ['before_days', 'after_days', 'is_today', 'is_overdue'].includes(op)) {
            const days = parseInt(val, 10) || 0;
            const todayStr = this._dateStr(0);
            if (op === 'before_days') {
                const futureStr = this._dateStr(days);
                whereClause = `DATE(${qCol}) <= ? AND DATE(${qCol}) >= ?`;
                params.push(futureStr, todayStr);
            } else if (op === 'after_days') {
                const pastStr = this._dateStr(-days);
                whereClause = `DATE(${qCol}) >= ? AND DATE(${qCol}) <= ?`;
                params.push(pastStr, todayStr);
            } else if (op === 'is_today') {
                whereClause = `DATE(${qCol}) = ?`;
                params.push(todayStr);
            } else if (op === 'is_overdue') {
                whereClause = `DATE(${qCol}) < ?`;
                params.push(todayStr);
            } else if (op === '<') {
                whereClause = `DATE(${qCol}) < DATE(?)`;
                params.push(String(val));
            } else if (op === '>') {
                whereClause = `DATE(${qCol}) > DATE(?)`;
                params.push(String(val));
            } else if (op === '=' || op === 'equals') {
                whereClause = `DATE(${qCol}) = DATE(?)`;
                params.push(String(val));
            }
        }
        // 3. String & Status Operators
        else if (colType === 'string' || colType === 'text') {
            if (op === '=' || op === 'equals') {
                whereClause = `${qCol} = ?`;
                params.push(String(val));
            } else if (op === '!=' || op === 'not_equals') {
                whereClause = `${qCol} != ?`;
                params.push(String(val));
            } else if (op === 'contains') {
                whereClause = `${qCol} LIKE ?`;
                params.push(`%${String(val)}%`);
            } else if (op === 'is_empty') {
                whereClause = `(${qCol} IS NULL OR TRIM(${qCol}) = '')`;
            } else if (op === 'is_not_empty') {
                whereClause = `(${qCol} IS NOT NULL AND TRIM(${qCol}) != '')`;
            } else if (op === 'in_list') {
                const items = String(val).split(',').map(s => s.trim()).filter(Boolean);
                if (items.length > 0) {
                    whereClause = `${qCol} IN (${items.map(() => '?').join(',')})`;
                    params.push(...items);
                } else {
                    whereClause = `1=0`;
                }
            }
        }
        // 4. Boolean Operators
        else if (colType === 'boolean') {
            const isTrue = val === true || val === 'true' || val === 1 || val === '1' || op === 'is_true';
            if (isTrue) {
                whereClause = `(${qCol} = 1 OR ${qCol} = '1' OR ${qCol} = 'true')`;
            } else {
                whereClause = `(${qCol} = 0 OR ${qCol} = '0' OR ${qCol} = 'false' OR ${qCol} IS NULL)`;
            }
        }

        // Fallback safety
        if (!whereClause) {
            whereClause = `${qCol} = ?`;
            params.push(String(val));
        }

        return { whereClause, params };
    }

    // ─────────────────────────────────────────────────────────
    // TEMPLATE TOKEN REPLACEMENT
    // ─────────────────────────────────────────────────────────

    formatMessage(template, sampleRow = {}, count = 0, rule = {}) {
        let msg = String(template || rule.rule_name || 'Reminder Alert');
        msg = msg.replace(/\[count\]/gi, String(count));
        msg = msg.replace(/\[table\]/gi, rule.target_table || '');
        msg = msg.replace(/\[column\]/gi, rule.target_column || '');
        msg = msg.replace(/\[threshold\]/gi, rule.operand_value || '');

        if (sampleRow && typeof sampleRow === 'object') {
            for (const key of Object.keys(sampleRow)) {
                const regex = new RegExp(`\\[${key}\\]`, 'gi');
                msg = msg.replace(regex, String(sampleRow[key] ?? ''));
            }
        }
        return msg;
    }

    // ─────────────────────────────────────────────────────────
    // RULE EVALUATION ENGINE
    // ─────────────────────────────────────────────────────────

    async evaluateRule(rule, options = {}) {
        // A. Normal Time/Date Alarm Evaluation
        if (rule.reminder_type === 'normal') {
            if (!rule.target_datetime) return { triggered: false, count: 0, matches: [] };
            const targetTime = new Date(rule.target_datetime).getTime();
            const now = Date.now();
            const isDue = now >= targetTime;

            return {
                rule_id: rule._id,
                rule_name: rule.rule_name,
                reminder_type: 'normal',
                severity: rule.severity || 'info',
                is_permanent: false,
                triggered: isDue,
                count: isDue ? 1 : 0,
                sampleRecords: isDue ? [{ target_datetime: rule.target_datetime, notes: rule.notes }] : [],
                message: rule.notes ? `${rule.rule_name}: ${rule.notes}` : rule.rule_name,
                action_table: null
            };
        }

        // B. Smart Data Watchdog Evaluation
        const table = String(rule.target_table || '').replace(/[^a-zA-Z0-9_]/g, '');
        if (!table) return { triggered: false, count: 0, matches: [] };
        const qTbl = this._q(table);

        const { whereClause, params } = this.buildConditionSql(rule);

        try {
            const countRow = await this._queryOne(`SELECT COUNT(*) as total_count FROM ${qTbl} WHERE ${whereClause}`, params);
            const totalCount = Number(countRow ? countRow.total_count : 0);

            if (totalCount === 0) {
                return {
                    rule_id: rule._id,
                    rule_name: rule.rule_name,
                    reminder_type: 'smart_watchdog',
                    severity: rule.severity,
                    is_permanent: !!rule.is_permanent,
                    triggered: false,
                    count: 0,
                    sampleRecords: [],
                    message: '',
                    action_table: table
                };
            }

            const sampleRows = await this._query(`SELECT * FROM ${qTbl} WHERE ${whereClause} LIMIT 5`, params);
            const sample = sampleRows[0] || {};
            const formattedMsg = this.formatMessage(rule.message_template, sample, totalCount, rule);

            return {
                rule_id: rule._id,
                rule_name: rule.rule_name,
                reminder_type: 'smart_watchdog',
                severity: rule.severity,
                is_permanent: !!rule.is_permanent,
                triggered: true,
                count: totalCount,
                sampleRecords: sampleRows,
                message: formattedMsg,
                action_table: table
            };
        } catch (err) {
            console.error(`[sutramEngine] Error evaluating reminder rule "${rule.rule_name}":`, err.message);
            return {
                rule_id: rule._id,
                rule_name: rule.rule_name,
                reminder_type: 'smart_watchdog',
                error: err.message,
                triggered: false,
                count: 0,
                sampleRecords: []
            };
        }
    }

    // ─────────────────────────────────────────────────────────
    // EVALUATE ALL ACTIVE RULES & DISPATCH
    // ─────────────────────────────────────────────────────────

    async evaluateAll(options = {}) {
        if (this._isEvaluating) return { status: 'already_evaluating', activeAlerts: [], permanentAlerts: [], missedAlerts: [] };
        this._isEvaluating = true;

        try {
            const core = this.engine.core || this.core;
            if (core?.hasTable) {
                const hasRuleTable = await core.hasTable('sys_reminder_rule');
                if (!hasRuleTable) {
                    return { success: true, activeAlerts: [], permanentAlerts: [], missedAlerts: [], resolvedCount: 0, evaluatedRulesCount: 0, timestamp: new Date().toISOString() };
                }
            }

            const rules = await this.getRules({ active: true });
            const now = new Date();
            const todayStr = this._dateStr(0);
            const currentHourMinute = now.toTimeString().slice(0, 5);
            const nowStr = this._nowStr();

            const activeAlerts = [];
            const permanentAlerts = [];
            const missedAlerts = [];
            let resolvedCount = 0;

            for (const rule of rules) {
                const evalResult = await this.evaluateRule(rule, options);

                const existingLog = await this._queryOne(`
                    SELECT * FROM sys_reminder_log
                    WHERE rule_id = ? AND status = 'active'
                    ORDER BY _id DESC LIMIT 1
                `, [rule._id]);

                if (rule.is_permanent && existingLog && (!evalResult.triggered || evalResult.count === 0)) {
                    await this._run(`
                        UPDATE sys_reminder_log
                        SET status = 'auto_resolved',
                            is_permanent_active = 0,
                            resolution_note = 'Data condition cleared in database',
                            updated_at = ?
                        WHERE _id = ?
                    `, [nowStr, existingLog._id]);
                    resolvedCount++;
                    continue;
                }

                if (!evalResult.triggered) continue;

                let shouldNotify = true;
                let isMissed = false;

                const todayLog = await this._queryOne(`
                    SELECT * FROM sys_reminder_log
                    WHERE rule_id = ? AND DATE(triggered_at) = ?
                    ORDER BY _id DESC LIMIT 1
                `, [rule._id, todayStr]);

                if (rule.schedule_time) {
                    const scheduledHHMM = rule.schedule_time.slice(0, 5);
                    const isPastScheduleTime = currentHourMinute >= scheduledHHMM;

                    if (!todayLog) {
                        if (isPastScheduleTime) {
                            if (rule.catch_up_if_missed) {
                                isMissed = true;
                                shouldNotify = true;
                            }
                        } else {
                            shouldNotify = false;
                        }
                    } else {
                        shouldNotify = false;
                    }
                } else if (rule.frequency === 'daily_once' && todayLog) {
                    shouldNotify = false;
                } else if (rule.frequency === 'once') {
                    const anyPastLog = await this._queryOne(`SELECT _id FROM sys_reminder_log WHERE rule_id = ? LIMIT 1`, [rule._id]);
                    if (anyPastLog) shouldNotify = false;
                }

                if (existingLog && existingLog.status === 'snoozed' && existingLog.snoozed_until) {
                    const snoozeUntil = new Date(existingLog.snoozed_until).getTime();
                    if (Date.now() < snoozeUntil) {
                        shouldNotify = false;
                    }
                }

                let currentLogId = existingLog ? existingLog._id : null;
                if (!existingLog) {
                    const ins = await this._run(`
                        INSERT INTO sys_reminder_log (
                            rule_id, rule_name, severity, message, target_table, target_column,
                            matching_count, sample_records_json, status, is_permanent_active
                        )
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
                    `, [
                        rule._id,
                        rule.rule_name,
                        rule.severity || 'warning',
                        evalResult.message || rule.message_template || rule.notes || '',
                        rule.target_table || null,
                        rule.target_column || null,
                        evalResult.count,
                        JSON.stringify(evalResult.sampleRecords || []),
                        rule.is_permanent ? 1 : 0
                    ]);
                    currentLogId = ins.insertId ?? ins.lastInsertRowid;
                } else {
                    await this._run(`
                        UPDATE sys_reminder_log
                        SET matching_count = ?,
                            sample_records_json = ?,
                            message = ?,
                            severity = ?,
                            updated_at = ?
                        WHERE _id = ?
                    `, [
                        evalResult.count,
                        JSON.stringify(evalResult.sampleRecords || []),
                        evalResult.message || rule.message_template || '',
                        rule.severity || 'warning',
                        nowStr,
                        existingLog._id
                    ]);
                }

                if (rule.is_permanent) {
                    permanentAlerts.push({
                        ...evalResult,
                        log_id: currentLogId,
                        is_permanent: true
                    });
                }

                if (shouldNotify) {
                    const payload = {
                        ...evalResult,
                        log_id: currentLogId,
                        is_missed: isMissed,
                        triggered_at: new Date().toISOString()
                    };

                    activeAlerts.push(payload);
                    if (isMissed) missedAlerts.push(payload);
                }
            }

            return {
                success: true,
                activeAlerts,
                permanentAlerts,
                missedAlerts,
                resolvedCount,
                evaluatedRulesCount: rules.length,
                timestamp: new Date().toISOString()
            };
        } finally {
            this._isEvaluating = false;
        }
    }

    // ─────────────────────────────────────────────────────────
    // SNOOZE & DISMISS ACTIONS
    // ─────────────────────────────────────────────────────────

    async snooze(logId, minutes = 15) {
        const mins = parseInt(minutes, 10) || 15;
        const nowStr = this._nowStr();
        const snoozeUntilStr = this._nowStr(mins);
        await this._run(`
            UPDATE sys_reminder_log
            SET status = 'snoozed',
                snoozed_until = ?,
                updated_at = ?
            WHERE _id = ?
        `, [snoozeUntilStr, nowStr, logId]);
        return true;
    }

    async dismiss(logId, user = 'admin', overrideReason = '') {
        const log = await this._queryOne(`
            SELECT l.*, r.is_permanent, r.rule_name
            FROM sys_reminder_log l
            JOIN sys_reminder_rule r ON r._id = l.rule_id
            WHERE l._id = ?
        `, [logId]);

        if (!log) throw new Error(`Reminder log ${logId} not found`);

        if (log.is_permanent && (!overrideReason || !String(overrideReason).trim())) {
            throw new Error(`Permanent alert "${log.rule_name}" cannot be dismissed until data condition is resolved in database. Admin override reason required.`);
        }

        const nowStr = this._nowStr();
        await this._run(`
            UPDATE sys_reminder_log
            SET status = 'dismissed',
                dismissed_at = ?,
                dismissed_by = ?,
                resolution_note = ?,
                is_permanent_active = 0,
                updated_at = ?
            WHERE _id = ?
        `, [nowStr, user, overrideReason || 'User dismissed', nowStr, logId]);

        return true;
    }

    async testRule(ruleDef) {
        const evalResult = await this.evaluateRule(ruleDef, { dryRun: true });
        return {
            success: true,
            rule_name: ruleDef.rule_name,
            count: evalResult.count,
            sampleRecords: evalResult.sampleRecords,
            previewMessage: evalResult.message,
            sqlDetails: ruleDef.reminder_type === 'smart_watchdog' ? this.buildConditionSql(ruleDef) : null
        };
    }

    _getDb() {
        return this.engine.db?.db || this.engine.db || this.db;
    }
}

module.exports = ReminderManager;

