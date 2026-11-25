// src/ExcelImporter.js
// ─────────────────────────────────────────────────────────────
// Core import logic.
//   verify()    → resolve FKs, return correctionList
//   importRow() → validate + insert/update one row
//   applyAutoSet() → is_xl, dept_id etc.
// ─────────────────────────────────────────────────────────────

'use strict';

const RefMatcher = require('./RefMatcher');
const DateUtils  = require('./DateUtils');

class ExcelImporter {

    constructor(engine, dictionary) {
        this.engine     = engine;
        this.dictionary = dictionary;
    }

    // ─────────────────────────────────────────────────────────
    // VERIFY — resolve all FK refs, return correctionList
    // Called before import — frontend shows correction UI
    // ─────────────────────────────────────────────────────────

    async verify(rows, tableConfig) {
        const matcher = new RefMatcher(this.engine, this.dictionary);
        const { rows: resolved, correctionList } = await matcher.resolveAll(rows, tableConfig);
        return { rows: resolved, correctionList };
    }

    // ─────────────────────────────────────────────────────────
    // IMPORT ROW — validate + duplicate check + insert/update
    // Returns { status, data }
    //   status: 'inserted' | 'updated' | 'duplicate' | 'rejected'
    // ─────────────────────────────────────────────────────────

    async importRow(row, tableConfig, req = {}) {
        // If row has _id, it is an existing record — route to updateRow
        if (row._id) {
            return this.updateRow(row, tableConfig, req);
        }

        // 0. auto-resolve FK references
        row = await this._resolveReferences(row, tableConfig);

        if (row._unresolvedRef && row._unresolvedRef.length) {
            return {
                status: 'rejected',
                data: row,
                error: `Invalid foreign key: ${row._unresolvedRef.join(', ')}`
            };
        }

        // 1. apply date conversions
        row = this._parseDates(row, tableConfig);

        // 2. apply boolean conversions
        row = this._parseBooleans(row, tableConfig);

        // 3. apply json conversions
        row = this._parseJson(row, tableConfig);

        // 4. apply autoSet — is_xl, dept_id etc.
        row = this._applyAutoSet(row, tableConfig, req);

        // 5. validate required fields
        const missing = this._validateRequired(row, tableConfig);
        if (missing.length) {
            return {
                status: 'rejected',
                data:   row,
                error:  `Missing required: ${missing.join(', ')}`,
            };
        }

        // 6. duplicate check
        if (tableConfig.duplicateOn?.length) {
            const existing = await this._checkDuplicate(row, tableConfig);
            if (existing.length) {
                const fullDup = await this._checkFullDuplicate(existing, row, tableConfig);
                if (fullDup.isExact) {
                    return { status: 'duplicate', data: row };
                }
                if (tableConfig.canUpdate) {
                    return { status: 'update', data: row, duplicate: existing };
                }
                return { status: 'duplicate', data: row };
            }
        }

        // 7. autoIncrement — voucher_no, bunch_no
        row = await this._applyAutoIncrement(row, tableConfig);

        // 8. insert
        try {
            const tableName = tableConfig.table || tableConfig.tableName || tableConfig.table_name;
            const tbl = this.engine.table ? this.engine.table(tableName) : null;
            const pk = tbl?.pkName || '_id';
            if (row[pk] === null || row[pk] === undefined || row[pk] === '') {
                delete row[pk];
            }
            if (row._id === null || row._id === undefined || row._id === '') {
                delete row._id;
            }
            if (row.id === null || row.id === undefined || row.id === '') {
                delete row.id;
            }
            if (req?.projectUser && this.engine.auth) {
                row = this.engine.auth.injectOwnerForWrite(tableName, row, req.projectUser);
            }
            const result = await this.engine.insert(tableName, row);
            const insertedId = (result && typeof result === 'object') ? (result[pk] ?? result._id ?? result.id) : result;
            if (insertedId !== undefined && insertedId !== null && row[pk] === undefined) {
                row[pk] = insertedId;
            }
            return { status: 'inserted', data: row, newData: result };
        } catch (err) {
            return { status: 'rejected', data: row, error: err.message };
        }
    }

    // ─────────────────────────────────────────────────────────
    // UPDATE ROW
    // ─────────────────────────────────────────────────────────

    async updateRow(row, tableConfig, req = {}) {
        const tableName = tableConfig.table || tableConfig.tableName || tableConfig.table_name;
        const tbl = this.engine.table ? this.engine.table(tableName) : null;
        const pk = tbl?.pkName || '_id';
        let targetId = row[pk] ?? row._id ?? row.id;

        // Enforce row-level ownership BEFORE validation/FK leaks if PK is already supplied
        if (targetId !== undefined && targetId !== null && targetId !== '' && req?.projectUser && this.engine.auth) {
            const ownFilter = this.engine.auth.getOwnershipFilter(req.projectUser, tableName, req.projectRights || []);
            if (ownFilter) {
                const existingRow = await this.engine.getById(tableName, targetId);
                if (!existingRow || Number(existingRow[ownFilter.column]) !== ownFilter.value) {
                    return { status: 'rejected', statusCode: 403, data: row, error: 'Access Denied: You can only update your own records.' };
                }
            }
        }

        // 0. auto-resolve FK references
        row = await this._resolveReferences(row, tableConfig);

        if (row._unresolvedRef && row._unresolvedRef.length) {
            return {
                status: 'rejected',
                data: row,
                error: `Invalid foreign key: ${row._unresolvedRef.join(', ')}`
            };
        }

        row = this._parseDates(row, tableConfig);
        row = this._parseBooleans(row, tableConfig);
        row = this._parseJson(row, tableConfig);
        row = this._applyAutoSet(row, tableConfig, req);

        try {
            if ((targetId === undefined || targetId === null || targetId === '') && tableConfig.duplicateOn?.length) {
                const existing = await this._checkDuplicate(row, tableConfig);
                if (existing.length) {
                    targetId = existing[0][pk] ?? existing[0]._id ?? existing[0].id;
                    row[pk] = targetId;
                }
            }
            if (targetId === undefined || targetId === null || targetId === '') {
                return { status: 'rejected', data: row, error: `No primary key (${pk}) for update` };
            }
            // Strip unchanged masked placeholders for sensitive columns; prevent author spoofing user_id
            const schemaCols = this.engine?._schema?.[tableName]?.columns || {};
            for (const [cName, cDef] of Object.entries(schemaCols)) {
                const t = String(cDef?.type || cDef?.col_type || '').toLowerCase();
                if ((t === 'password' || /password|pwd|secret_hash|secret|pin/i.test(cName)) && row[cName] === '••••••••') {
                    delete row[cName];
                }
            }
            if (req?.projectUser && req.projectUser.role !== 'admin') {
                delete row.user_id;
            }
            if (req?.projectUser && this.engine.auth) {
                const ownFilter = this.engine.auth.getOwnershipFilter(req.projectUser, tableName, req.projectRights || []);
                if (ownFilter) {
                    const existingRow = await this.engine.getById(tableName, targetId);
                    if (!existingRow || Number(existingRow[ownFilter.column]) !== ownFilter.value) {
                        return { status: 'rejected', statusCode: 403, data: row, error: 'Access Denied: You can only update your own records.' };
                    }
                }
            }

            // 5. validate required fields after authorization check
            const missing = this._validateRequired(row, tableConfig);
            if (missing.length) {
                return {
                    status: 'rejected',
                    data:   row,
                    error:  `Missing required: ${missing.join(', ')}`,
                };
            }

            const result = await this.engine.updateById(tableName, row, targetId);
            return { status: 'updated', data: row, newData: result };
        } catch (err) {
            return { status: 'rejected', data: row, error: err.message };
        }
    }

    // ─────────────────────────────────────────────────────────
    // AUTO-RESOLVE FK REFERENCES
    // ─────────────────────────────────────────────────────────

    async _resolveReferences(row, tableConfig) {
        if (!this.matcher) {
            this.matcher = new RefMatcher(this.engine, this.dictionary);
        }
        await this.matcher._preloadRefs(tableConfig);

        for (const h of (tableConfig.headers || [])) {
            if (h.type === 'mix') {
                await this.matcher._resolveMix(row, h, [], {}, 0);
                continue;
            }

            if (h.ref_table || h.type === 'ref') {
                const refField = h.ref_field || h.col_name;
                const currentVal = row[refField];
                const displayVal = row[h.name] ?? row[h.ref_as] ?? row[h.col_name];

                // If currentVal is already a numeric ID, keep it
                const isNumericId = currentVal !== undefined && currentVal !== null && currentVal !== '' && !isNaN(currentVal) && Number(currentVal) > 0;

                if (isNumericId) {
                    row[refField] = Number(currentVal);
                    continue;
                }

                // If display string or raw text value exists, resolve it
                const valToResolve = (displayVal !== undefined && displayVal !== null && displayVal !== '') ? displayVal : currentVal;
                if (valToResolve !== undefined && valToResolve !== null && valToResolve !== '') {
                    if (!isNaN(valToResolve) && Number(valToResolve) > 0) {
                        row[refField] = Number(valToResolve);
                    } else {
                        const resolvedId = await this.matcher._resolveRef(valToResolve, h, [], {}, 0);
                        if (resolvedId !== null && resolvedId !== undefined) {
                            row[refField] = resolvedId;
                            if (h.col_name) row[h.col_name] = resolvedId;
                        } else {
                            row._unresolvedRef = row._unresolvedRef || [];
                            row._unresolvedRef.push(`${h.name} ("${valToResolve}") not found in ${h.ref_table}`);
                        }
                    }
                }
            }
        }
        return row;
    }

    // ─────────────────────────────────────────────────────────
    // AUTO SET — is_xl=1, dept_id=(req)=>req.deptId etc.
    //
    // autoSet config:
    //   { is_xl: 1 }                    → literal value
    //   { dept_id: (req) => req.deptId } → function, called with req
    //
    // missing req value → null → schema default used by engine
    // ─────────────────────────────────────────────────────────

    _applyAutoSet(row, tableConfig, req) {
        const autoSet = tableConfig.autoSet ?? {};
        for (const [col, val] of Object.entries(autoSet)) {
            if (typeof val === 'function') {
                // function — call with req, fallback to null
                try {
                    row[col] = val(req) ?? null;
                } catch {
                    row[col] = null;
                }
            } else {
                // literal value
                row[col] = val;
            }
        }
        return row;
    }

    // ─────────────────────────────────────────────────────────
    // AUTO INCREMENT — voucher_no, bunch_no
    // ─────────────────────────────────────────────────────────

    async _applyAutoIncrement(row, tableConfig) {
        const tblName = tableConfig.table || tableConfig.tableName || tableConfig.table_name;
        for (const col of (tableConfig.autoIncrement ?? [])) {
            if (!row[col]) {
                try {
                    const last = await this.engine.max(tblName, col);
                    row[col] = (Number(last) || 0) + 1;
                } catch {
                    row[col] = 1;
                }
            }
        }
        return row;
    }

    // ─────────────────────────────────────────────────────────
    // PARSE DATES
    // ─────────────────────────────────────────────────────────

    _parseDates(row, tableConfig) {
        // explicit date columns from config
        for (const col of (tableConfig.dateColumns ?? [])) {
            if (row[col] !== undefined && row[col] !== null) {
                row[col] = DateUtils.parseISO(row[col]);
            }
        }
        // header config type = 'date' or 'unix_date'
        for (const h of tableConfig.headers) {
            if (!h.type) continue;
            const val = row[h.col_name];
            if (val === undefined || val === null) continue;
            if (h.type === 'date') {
                row[h.col_name] = DateUtils.parseISO(val);
            } else if (h.type === 'unix_date') {
                row[h.col_name] = DateUtils.parseUnix(val);
            }
        }
        return row;
    }

    // ─────────────────────────────────────────────────────────
    // PARSE BOOLEANS
    // ─────────────────────────────────────────────────────────

    _parseBooleans(row, tableConfig) {
        for (const col of (tableConfig.booleanColumns ?? [])) {
            if (row[col] !== undefined) {
                row[col] = row[col] ? 1 : 0;
            }
        }
        // schema boolean cols
        for (const h of tableConfig.headers) {
            if (h.type === 'boolean' && row[h.col_name] !== undefined) {
                const v = row[h.col_name];
                row[h.col_name] = (v === true || v === 1 || v === '1' ||
                    String(v).toLowerCase() === 'yes' ||
                    String(v).toLowerCase() === 'true') ? 1 : 0;
            }
        }
        return row;
    }

    // ─────────────────────────────────────────────────────────
    // PARSE JSON
    // ─────────────────────────────────────────────────────────

    _parseJson(row, tableConfig) {
        for (const col of (tableConfig.jsonColumns ?? [])) {
            if (row[col] !== undefined) {
                if (typeof row[col] !== 'string') {
                    row[col] = JSON.stringify(row[col] ?? null);
                }
            }
        }
        return row;
    }

    // ─────────────────────────────────────────────────────────
    // VALIDATE REQUIRED
    // ─────────────────────────────────────────────────────────

    _validateRequired(row, tableConfig) {
        const missing = [];
        for (const h of tableConfig.headers) {
            // Primary key is auto-incremented by database on insert; never required in payload
            if (h.is_pk || h.pk || h.col_name === '_id' || h.name === '_id') continue;
            if (!h.not_null) continue;
            const val = h.ref_field ? row[h.ref_field] : row[h.col_name];
            if (val === null || val === undefined || val === '') {
                missing.push(h.name);
            }
        }
        return missing;
    }

    // ─────────────────────────────────────────────────────────
    // DUPLICATE CHECK
    // ─────────────────────────────────────────────────────────

    async _checkDuplicate(row, tableConfig) {
        const where = {};
        for (const col of tableConfig.duplicateOn) {
            if (row[col] !== undefined && row[col] !== null) {
                where[col] = row[col];
            }
        }
        if (!Object.keys(where).length) return [];
        try {
            const tblName = tableConfig.table || tableConfig.tableName || tableConfig.table_name;
            return await this.engine.getAll(tblName, where, { full: false });
        } catch {
            return [];
        }
    }

    // check if all fields are exactly same → true duplicate
    async _checkFullDuplicate(existing, row, tableConfig) {
        const checkCols = tableConfig.fullDuplicateOn?.length
            ? tableConfig.fullDuplicateOn
            : tableConfig.duplicateOn;

        for (const ex of existing) {
            let exact = true;
            for (const col of checkCols) {
                if (String(ex[col] ?? '') !== String(row[col] ?? '')) {
                    exact = false;
                    break;
                }
            }
            if (exact) return { isExact: true };
        }
        return { isExact: false };
    }
}

module.exports = ExcelImporter;
