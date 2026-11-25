// src/ReportManager.js
// ─────────────────────────────────────────────────────────────
// Manages named CTE reports stored in sys_report.
// Reports are SQL queries (CTEs, aggregations, joins) with
// optional named parameters.
//
// Usage:
//   engine.report.create({
//     report_name: 'monthly_sales',
//     cte_sql: `SELECT strftime('%Y-%m', date) as month, SUM(amount) as total
//               FROM orders WHERE date >= :from AND date <= :to`,
//     params: [
//       { name: 'from', type: 'string', default: '2024-01-01' },
//       { name: 'to',   type: 'string', default: '2024-12-31' },
//     ]
//   });
//
//   engine.report.run('monthly_sales', { from: '2024-06-01', to: '2024-06-30' });
// ─────────────────────────────────────────────────────────────

'use strict';

const ProcedureHandle = require('./ProcedureHandle');

class ReportManager {

    constructor(engineOrCore) {
        this.engine = (engineOrCore && engineOrCore.core) ? engineOrCore : null;
        this.core = this.engine ? this.engine.core : (typeof engineOrCore?.query === 'function' ? engineOrCore : null);
        this.db = this.core?.db || (!this.core ? engineOrCore : null);
        this._cache = {}; // { report_name: { ...report, params: [...] } }
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
    // LOAD FROM sys_ TABLES — managed mode
    // ─────────────────────────────────────────────────────────

    async load() {
        this._cache = {};
        this._procedureCache = {};  // clear on reload

        try {
            const reports = await this._query(
                `SELECT * FROM sys_report WHERE active = 1`
            );

            for (const report of reports) {
                this._cache[report.report_name] = {
                    ...report,
                    report_type:    report.report_type    ?? 'cte',
                    procedure_name: report.procedure_name ?? null,
                    params:         report.params ? JSON.parse(report.params) : [],
                };
            }

            console.log(`[sutramEngine] ✓ ${reports.length} report(s) loaded from sys_`);
        } catch (err) {
            console.warn('[sutramEngine] ReportManager load notice:', err.message);
        }
    }

    // ─────────────────────────────────────────────────────────
    // PROCEDURE() — table() jaisi pattern
    // Returns cached ProcedureHandle for a report/procedure name
    // ─────────────────────────────────────────────────────────

    procedure(name) {
        if (!this._procedureCache) this._procedureCache = {};

        if (!this._procedureCache[name]) {
            const def = this._cache[name];
            if (!def) throw new Error(
                `[sutramEngine] Procedure/Report "${name}" not found.\n` +
                `Available: ${Object.keys(this._cache).join(', ') || '(none)'}`
            );
            // runner fn — calls this.run() which handles cte/procedure
            this._procedureCache[name] = new ProcedureHandle(
                name, def, (n, params) => this.run(n, params)
            );
        }

        return this._procedureCache[name];
    }

    // ─────────────────────────────────────────────────────────
    // LOAD FROM ARRAY — direct mode
    // Accepts same format as reports.js
    // ─────────────────────────────────────────────────────────

    loadFromArray(reports = []) {
        this._cache = {};
        this._procedureCache = {};  // clear on reload

        for (const report of reports) {
            if (!report.report_name) continue;
            if (report.active === false) continue;

            const type = report.report_type ?? 'cte';

            // cte requires cte_sql, procedure requires procedure_name
            if (type === 'cte'       && !report.cte_sql)       continue;
            if (type === 'procedure' && !report.procedure_name) continue;

            this._cache[report.report_name] = {
                ...report,
                report_type:    type,
                procedure_name: report.procedure_name ?? null,
                params:         report.params ?? [],
            };
        }

        console.log(`[sutramEngine] ✓ ${Object.keys(this._cache).length} report(s) loaded from array`);
    }

    // ─────────────────────────────────────────────────────────
    // CREATE REPORT
    // def: {
    //   report_name, label?, description?,
    //   cte_sql,
    //   params?: [ { name, type, default? } ]
    // }
    // ─────────────────────────────────────────────────────────

    async create(def) {
        if (!def.report_name) throw new Error('[sutramEngine] report_name required');

        const type = def.report_type ?? 'cte';

        if (type === 'cte' && !def.cte_sql) {
            throw new Error('[sutramEngine] cte_sql required for type "cte"');
        }
        if (type === 'procedure' && !def.procedure_name) {
            throw new Error('[sutramEngine] procedure_name required for type "procedure"');
        }

        const params = JSON.stringify(def.params ?? []);

        await this._run(`
            INSERT INTO sys_report
              (report_name, label, description, report_type, cte_sql, procedure_name, params)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [
            def.report_name,
            def.label          ?? def.report_name,
            def.description    ?? null,
            type,
            def.cte_sql        ?? null,
            def.procedure_name ?? null,
            params,
        ]);

        await this.load();
        console.log(`[sutramEngine] ✓ Report "${def.report_name}" created (type: ${type})`);
    }

    // ─────────────────────────────────────────────────────────
    // UPDATE REPORT (replace SQL or params)
    // ─────────────────────────────────────────────────────────

    async update(reportName, updates) {
        const report = await this._getReport(reportName);

        const fields = [];
        const values = [];

        if (updates.cte_sql)     { fields.push('cte_sql = ?');     values.push(updates.cte_sql); }
        if (updates.label)       { fields.push('label = ?');       values.push(updates.label); }
        if (updates.description) { fields.push('description = ?'); values.push(updates.description); }
        if (updates.params)      { fields.push('params = ?');      values.push(JSON.stringify(updates.params)); }
        fields.push('updated_at = ?');
        values.push(new Date().toISOString().slice(0, 19).replace('T', ' '));

        if (fields.length === 1) return;

        await this._run(
            `UPDATE sys_report SET ${fields.join(', ')} WHERE _id = ?`,
            [...values, report._id]
        );

        await this.load();
        console.log(`[sutramEngine] ✓ Report "${reportName}" updated`);
    }

    // ─────────────────────────────────────────────────────────
    // DELETE REPORT
    // ─────────────────────────────────────────────────────────

    async delete(reportName) {
        const report = await this._getReport(reportName);
        await this._run(`DELETE FROM sys_report WHERE _id = ?`, [report._id]);
        await this.load();
        console.log(`[sutramEngine] ✓ Report "${reportName}" deleted`);
    }

    // ─────────────────────────────────────────────────────────
    // RUN REPORT
    // ─────────────────────────────────────────────────────────

    async run(reportName, params = {}) {
        const report = this._cache[reportName];
        if (!report) throw new Error(`[sutramEngine] Report "${reportName}" not found`);

        const finalParams = {};
        for (const p of report.params) {
            finalParams[p.name] = params[p.name] !== undefined
                ? params[p.name]
                : (p.default ?? null);
        }

        for (const p of report.params) {
            if (p.required && finalParams[p.name] === null) {
                throw new Error(`[sutramEngine] Report "${reportName}" missing required param: ${p.name}`);
            }
        }

        try {
            if (report.report_type === 'procedure') {
                return await this._runProcedure(report, finalParams);
            } else {
                return await this._runCTE(report, finalParams);
            }
        } catch (err) {
            throw new Error(`[sutramEngine] Report "${reportName}" failed: ${err.message}`);
        }
    }

    async _runCTE(report, finalParams) {
        // Convert :name params cleanly to ? array so SQLite and MySQL both execute identically
        const boundParams = [];
        const sql = String(report.cte_sql).replace(/:([a-zA-Z0-9_]+)/g, (_, name) => {
            boundParams.push(finalParams[name] ?? null);
            return '?';
        });
        return await this._query(sql, boundParams);
    }

    async _runProcedure(report, finalParams) {
        if (this.core?.report && typeof this.core.report.run === 'function') {
            return await this.core.report.run(report.report_name, finalParams);
        }
        const qMarks = Object.keys(finalParams).map(() => '?').join(', ');
        if (this.core?.dialect === 'mysql') {
            return await this._query(`CALL \`${report.procedure_name}\`(${qMarks})`, Object.values(finalParams));
        }
        throw new Error(
            `[sutramEngine] Stored procedure "${report.procedure_name}" is not supported on ${this.core?.dialect || 'sqlite'}.`
        );
    }

    // ─────────────────────────────────────────────────────────
    // LIST REPORTS
    // ─────────────────────────────────────────────────────────

    async getReports() {
        const rows = await this._query(
            `SELECT _id, report_name, label, description, params, active FROM sys_report ORDER BY _id ASC`
        );
        return rows.map(r => ({ ...r, params: JSON.parse(r.params ?? '[]') }));
    }

    // ─────────────────────────────────────────────────────────
    // PRIVATE
    // ─────────────────────────────────────────────────────────

    async _getReport(reportName) {
        const row = await this._queryOne(
            `SELECT * FROM sys_report WHERE report_name = ?`,
            [reportName]
        );
        if (!row) throw new Error(`[sutramEngine] Report "${reportName}" not found in sys_report`);
        return row;
    }
}

module.exports = ReportManager;
