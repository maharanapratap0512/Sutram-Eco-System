'use strict';

const crypto = require('crypto');

const SCRYPT_PREFIX = 'scrypt$';
const SCRYPT_KEYLEN = 64;
const DEFAULT_OWNER_COL = 'user_id';

class AuthManager {
    constructor(engine) {
        this.engine = engine;
    }

    // ─────────────────────────────────────────────────────────
    // CRYPTO & MISC HELPERS (Reusable Single Source of Truth)
    // ─────────────────────────────────────────────────────────

    static normalizePassword(raw) {
        return raw === undefined || raw === null ? '' : String(raw).trim();
    }

    static hashPassword(rawPassword = '') {
        const clean = AuthManager.normalizePassword(rawPassword);
        const salt = crypto.randomBytes(16).toString('hex');
        const derived = crypto.scryptSync(clean, salt, SCRYPT_KEYLEN).toString('hex');
        return `${SCRYPT_PREFIX}${salt}$${derived}`;
    }

    static verifyPassword(candidate = '', stored = '') {
        const cleanCand = AuthManager.normalizePassword(candidate);
        const storedStr = stored === undefined || stored === null ? '' : String(stored);

        if (storedStr.startsWith(SCRYPT_PREFIX)) {
            const parts = storedStr.split('$');
            if (parts.length !== 3) return { valid: false, needsRehash: false };
            const [, salt, hashHex] = parts;
            try {
                const derived = crypto.scryptSync(cleanCand, salt, SCRYPT_KEYLEN);
                const expected = Buffer.from(hashHex, 'hex');
                if (derived.length !== expected.length) return { valid: false, needsRehash: false };
                return { valid: crypto.timingSafeEqual(derived, expected), needsRehash: false };
            } catch {
                return { valid: false, needsRehash: false };
            }
        }

        // Seamless upgrade path for legacy plaintext passwords
        const valid = cleanCand === storedStr.trim();
        return { valid, needsRehash: valid };
    }

    static parseMisc(raw) {
        if (!raw) return {};
        if (typeof raw === 'object' && !Array.isArray(raw)) return { ...raw };
        try {
            const parsed = JSON.parse(String(raw));
            return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
        } catch {
            return {};
        }
    }

    static stringifyMisc(obj) {
        return JSON.stringify(obj && typeof obj === 'object' ? obj : {});
    }

    static isSensitiveColumn(colName, colDef = null) {
        const n = String(colName || '').toLowerCase();
        const t = String(colDef?.type || colDef?.col_type || '').toLowerCase();
        if (t === 'password') return true;
        if (n === 'user_id' || n.endsWith('_id') || n === '_id') return false;
        return n === 'password' || n.includes('password') || n === 'pwd' || n.includes('pwd') ||
               n === 'secret_hash' || n === 'secret' || n === 'pin';
    }

    static maskRowSensitiveFields(row, schemaCols = {}, unmaskedCols = new Set()) {
        if (!row || typeof row !== 'object') return row;
        const copy = { ...row };
        for (const [colName, colDef] of Object.entries(schemaCols || {})) {
            if (AuthManager.isSensitiveColumn(colName, colDef) && !unmaskedCols.has(colName)) {
                const v = copy[colName];
                if (v !== null && v !== undefined && String(v) !== '') {
                    copy[colName] = '••••••••';
                }
            }
        }
        return copy;
    }

    _nowStr() {
        const d = new Date();
        const pad = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }

    _hasOrmTable(tableName) {
        return Boolean(this.engine?._schema?.[tableName]);
    }

    _sanitizeUser(u) {
        if (!u) return null;
        const misc = AuthManager.parseMisc(u.misc_settings);
        const canOcrVal = misc.can_ocr !== undefined ? misc.can_ocr : u.can_ocr;
        const isBlank = misc.is_blank_password !== undefined
            ? Boolean(misc.is_blank_password)
            : (String(u.password || '') === '' || AuthManager.verifyPassword('', u.password).valid);

        return {
            _id: Number(u._id),
            username: u.username,
            display_name: u.display_name || u.username,
            role: u.role === 'admin' ? 'admin' : 'author',
            active: u.active !== undefined ? Number(u.active) : 1,
            can_ocr: canOcrVal !== 0 && canOcrVal !== false ? 1 : 0,
            is_blank_password: isBlank,
            misc_settings: misc,
            created_at: u.created_at,
            updated_at: u.updated_at
        };
    }

    _normalizeRight(r) {
        const misc = AuthManager.parseMisc(r?.misc_settings);
        return {
            _id: r?._id,
            user_id: r?.user_id !== undefined ? Number(r.user_id) : undefined,
            table_name: r?.table_name,
            can_view: r?.can_view !== 0 && r?.can_view !== false ? 1 : 0,
            can_edit: r?.can_edit !== 0 && r?.can_edit !== false ? 1 : 0,
            can_delete: r?.can_delete !== 0 && r?.can_delete !== false ? 1 : 0,
            can_unmask: r?.can_unmask === 1 || r?.can_unmask === true ? 1 : 0,
            data_scope: misc.data_scope === 'own' ? 'own' : 'all',
            owner_col: misc.owner_col || DEFAULT_OWNER_COL,
            misc_settings: misc
        };
    }

    // ─────────────────────────────────────────────────────────
    // USER & BOOTSTRAP MANAGEMENT (Via Engine / Core ORM)
    // ─────────────────────────────────────────────────────────

    async ensureDefaultAdmin() {
        try {
            const count = this._hasOrmTable('sys_user')
                ? await this.engine.count('sys_user')
                : Number((await this.engine.queryOne(`SELECT COUNT(*) as c FROM sys_user`))?.c || 0);

            if (count === 0) {
                const hashed = AuthManager.hashPassword('admin');
                const misc = AuthManager.stringifyMisc({ can_ocr: 1, is_blank_password: false });
                if (this._hasOrmTable('sys_user')) {
                    await this.engine.insert('sys_user', {
                        username: 'admin',
                        password: hashed,
                        display_name: 'Project Administrator',
                        role: 'admin',
                        active: 1,
                        can_ocr: 1,
                        misc_settings: misc
                    }, false);
                } else {
                    await this.engine.run(
                        `INSERT INTO sys_user (username, password, display_name, role, active, can_ocr, misc_settings) VALUES (?, ?, ?, 'admin', 1, 1, ?)`,
                        ['admin', hashed, 'Project Administrator', misc]
                    );
                }
            }
        } catch (err) {
            console.warn('[sutramEngine:auth] ensureDefaultAdmin warning:', err.message);
        }
    }

    async listUsers() {
        await this.ensureDefaultAdmin();
        const rows = this._hasOrmTable('sys_user')
            ? await this.engine.getAll('sys_user', {}, { full: false, orderBy: '_id ASC' })
            : await this.engine.query(`SELECT * FROM sys_user ORDER BY _id ASC`);
        return (rows || []).map(u => this._sanitizeUser(u));
    }

    async getUserByIdOrUsername(idOrUsername) {
        if (idOrUsername === undefined || idOrUsername === null || idOrUsername === '') return null;
        const raw = String(idOrUsername).trim();
        let row = null;

        if (this._hasOrmTable('sys_user')) {
            if (/^\d+$/.test(raw)) {
                row = await this.engine.getOne('sys_user', { _id: Number(raw), active: 1 }, { full: false });
            }
            if (!row) {
                row = await this.engine.getOne('sys_user', { username: raw, active: 1 }, { full: false });
            }
        } else {
            row = await this.engine.queryOne(
                `SELECT * FROM sys_user WHERE (username = ? OR _id = ?) AND active = 1`,
                [raw, raw]
            );
        }
        return this._sanitizeUser(row);
    }

    async _getRawUser(where) {
        if (this._hasOrmTable('sys_user')) {
            return await this.engine.getOne('sys_user', where, { full: false });
        }
        const entries = Object.entries(where);
        const clause = entries.map(([k]) => `${this.engine.core.quoteId(k)} = ?`).join(' AND ');
        return await this.engine.queryOne(`SELECT * FROM sys_user WHERE ${clause}`, entries.map(([, v]) => v));
    }

    async createUser({ username, password = '', display_name, role = 'author', active = 1, can_ocr = 1, misc_settings = {} } = {}) {
        const cleanUser = String(username || '').trim();
        if (!cleanUser) {
            throw new Error('Username is required');
        }

        const existing = await this._getRawUser({ username: cleanUser });
        if (existing) {
            throw new Error(`Username "${cleanUser}" already exists in this project`);
        }

        const cleanPass = AuthManager.normalizePassword(password);
        const hashed = AuthManager.hashPassword(cleanPass);
        const cleanRole = role === 'admin' ? 'admin' : 'author';
        const cleanOcr = (can_ocr === 0 || can_ocr === false) ? 0 : 1;
        const miscObj = {
            ...AuthManager.parseMisc(misc_settings),
            can_ocr: cleanOcr,
            is_blank_password: cleanPass === ''
        };

        let newId;
        const record = {
            username: cleanUser,
            password: hashed,
            display_name: display_name ? String(display_name).trim() : cleanUser,
            role: cleanRole,
            active: active ? 1 : 0,
            can_ocr: cleanOcr,
            misc_settings: AuthManager.stringifyMisc(miscObj)
        };

        if (this._hasOrmTable('sys_user')) {
            newId = await this.engine.insert('sys_user', record, false);
        } else {
            const res = await this.engine.run(
                `INSERT INTO sys_user (username, password, display_name, role, active, can_ocr, misc_settings) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [record.username, record.password, record.display_name, record.role, record.active, record.can_ocr, record.misc_settings]
            );
            newId = res.insertId ?? res.lastInsertRowid;
        }

        const created = await this._getRawUser({ _id: Number(newId) });
        return this._sanitizeUser(created);
    }

    async updateUser(id, updates = {}) {
        const uid = Number(id);
        const existing = await this._getRawUser({ _id: uid });
        if (!existing) {
            const err = new Error('User not found in this project');
            err.statusCode = 404;
            throw err;
        }

        const updatedUser = updates.username ? String(updates.username).trim() : existing.username;
        const updatedRole = updates.role ? (updates.role === 'admin' ? 'admin' : 'author') : existing.role;
        const updatedAct = updates.active !== undefined ? (updates.active ? 1 : 0) : existing.active;
        const updatedDisp = updates.display_name !== undefined ? String(updates.display_name).trim() : existing.display_name;

        if (existing.role === 'admin' && (updatedRole !== 'admin' || updatedAct === 0)) {
            const admins = this._hasOrmTable('sys_user')
                ? await this.engine.count('sys_user', { role: 'admin', active: 1 })
                : Number((await this.engine.queryOne(`SELECT COUNT(*) as c FROM sys_user WHERE role = 'admin' AND active = 1`))?.c || 0);
            if (admins <= 1) {
                throw new Error('Cannot revoke admin privileges from the sole active administrator in this project');
            }
        }

        const existingMisc = AuthManager.parseMisc(existing.misc_settings);
        const incomingMisc = AuthManager.parseMisc(updates.misc_settings);
        const updatedOcr = updates.can_ocr !== undefined
            ? ((updates.can_ocr === 0 || updates.can_ocr === false) ? 0 : 1)
            : (existingMisc.can_ocr ?? existing.can_ocr ?? 1);

        const nextMisc = {
            ...existingMisc,
            ...incomingMisc,
            can_ocr: updatedOcr
        };

        let nextPassword = existing.password;
        if (Object.prototype.hasOwnProperty.call(updates, 'password') && updates.password !== undefined && updates.password !== null) {
            const cleanPass = AuthManager.normalizePassword(updates.password);
            nextPassword = AuthManager.hashPassword(cleanPass);
            nextMisc.is_blank_password = cleanPass === '';
        }

        const payload = {
            username: updatedUser,
            password: nextPassword,
            display_name: updatedDisp,
            role: updatedRole,
            active: updatedAct,
            can_ocr: updatedOcr,
            misc_settings: AuthManager.stringifyMisc(nextMisc),
            updated_at: this._nowStr()
        };

        if (this._hasOrmTable('sys_user')) {
            await this.engine.updateById('sys_user', payload, uid, false);
        } else {
            await this.engine.run(
                `UPDATE sys_user SET username = ?, password = ?, display_name = ?, role = ?, active = ?, can_ocr = ?, misc_settings = ?, updated_at = ? WHERE _id = ?`,
                [payload.username, payload.password, payload.display_name, payload.role, payload.active, payload.can_ocr, payload.misc_settings, payload.updated_at, uid]
            );
        }

        const refreshed = await this._getRawUser({ _id: uid });
        return this._sanitizeUser(refreshed);
    }

    async deleteUser(id) {
        const uid = Number(id);
        const existing = await this._getRawUser({ _id: uid });
        if (!existing) {
            const err = new Error('User not found in this project');
            err.statusCode = 404;
            throw err;
        }

        if (existing.role === 'admin') {
            const admins = this._hasOrmTable('sys_user')
                ? await this.engine.count('sys_user', { role: 'admin', active: 1 })
                : Number((await this.engine.queryOne(`SELECT COUNT(*) as c FROM sys_user WHERE role = 'admin' AND active = 1`))?.c || 0);
            if (admins <= 1) {
                throw new Error('Cannot delete the sole administrator of this project');
            }
        }

        const needTx = !this.engine.inTransaction;
        try {
            if (needTx) await this.engine.begin();
            if (this._hasOrmTable('sys_user_rights')) {
                await this.engine.delete('sys_user_rights', { user_id: uid });
            } else {
                await this.engine.run(`DELETE FROM sys_user_rights WHERE user_id = ?`, [uid]);
            }
            if (this._hasOrmTable('sys_user')) {
                await this.engine.deleteById('sys_user', uid);
            } else {
                await this.engine.run(`DELETE FROM sys_user WHERE _id = ?`, [uid]);
            }
            if (needTx) await this.engine.commit();
        } catch (err) {
            if (needTx && this.engine.inTransaction) await this.engine.rollback();
            throw err;
        }

        return this._sanitizeUser(existing);
    }

    // ─────────────────────────────────────────────────────────
    // TABLE RIGHTS & OWNERSHIP COLUMN MANAGEMENT
    // ─────────────────────────────────────────────────────────

    async getUserRights(userId) {
        const uid = Number(userId);
        const rows = this._hasOrmTable('sys_user_rights')
            ? await this.engine.getAll('sys_user_rights', { user_id: uid }, { full: false })
            : await this.engine.query(`SELECT * FROM sys_user_rights WHERE user_id = ?`, [uid]);
        return (rows || []).map(r => this._normalizeRight(r));
    }

    async ensureOwnerColumn(tableName, ownerCol = DEFAULT_OWNER_COL) {
        if (!tableName || tableName.startsWith('sys_') || tableName.startsWith('xls_') || tableName.startsWith('sqlite_')) {
            return false;
        }
        if (this.engine?._schema?.[tableName]?.columns?.[ownerCol]) {
            return true;
        }
        try {
            const detail = await this.engine.inspectTable(tableName);
            if ((detail?.columns || []).some(c => c.name === ownerCol)) {
                return true;
            }
        } catch {}

        try {
            await this.engine.schema.addColumn(tableName, {
                column_name: ownerCol,
                label: 'Owner User ID',
                col_type: 'number',
                sql_type: 'INTEGER',
                is_required: 0
            });
            return true;
        } catch (err) {
            console.warn(`[sutramEngine:auth] ensureOwnerColumn(${tableName}.${ownerCol}) warning:`, err.message);
            return false;
        }
    }

    async setUserRights(userId, rights = []) {
        const uid = Number(userId);
        const list = Array.isArray(rights) ? rights : [];

        // Perform any DDL outside active transaction
        for (const r of list) {
            if (r?.table_name && r?.data_scope === 'own') {
                await this.ensureOwnerColumn(r.table_name, r.owner_col || DEFAULT_OWNER_COL);
            }
        }

        const now = this._nowStr();
        const needTx = !this.engine.inTransaction;
        try {
            if (needTx) await this.engine.begin();
            for (const r of list) {
                if (!r?.table_name) continue;
                const misc = {
                    ...AuthManager.parseMisc(r.misc_settings),
                    data_scope: r.data_scope === 'own' ? 'own' : 'all',
                    owner_col: r.owner_col || DEFAULT_OWNER_COL
                };
                await this.engine.upsert('sys_user_rights', ['user_id', 'table_name'], {
                    user_id: uid,
                    table_name: r.table_name,
                    can_view: r.can_view ? 1 : 0,
                    can_edit: r.can_edit ? 1 : 0,
                    can_delete: r.can_delete ? 1 : 0,
                    can_unmask: r.can_unmask ? 1 : 0,
                    misc_settings: AuthManager.stringifyMisc(misc),
                    updated_at: now
                });
            }
            if (needTx) await this.engine.commit();
        } catch (err) {
            if (needTx && this.engine.inTransaction) await this.engine.rollback();
            throw err;
        }

        return await this.getUserRights(uid);
    }

    // ─────────────────────────────────────────────────────────
    // LOGIN & COLUMN UNMASK VERIFICATION (Blank Password Safe)
    // ─────────────────────────────────────────────────────────

    async verifyLogin(username, password = '') {
        const cleanUser = String(username || '').trim();
        if (!cleanUser) return null;

        await this.ensureDefaultAdmin();

        let rawUser = null;
        if (this._hasOrmTable('sys_user')) {
            rawUser = await this.engine.getOne('sys_user', { username: cleanUser, active: 1 }, { full: false });
            if (!rawUser && /^\d+$/.test(cleanUser)) {
                rawUser = await this.engine.getOne('sys_user', { _id: Number(cleanUser), active: 1 }, { full: false });
            }
        } else {
            rawUser = await this.engine.queryOne(
                `SELECT * FROM sys_user WHERE (username = ? OR _id = ?) AND active = 1`,
                [cleanUser, cleanUser]
            );
        }

        if (!rawUser) return null;

        const cleanPass = AuthManager.normalizePassword(password);
        const check = AuthManager.verifyPassword(cleanPass, rawUser.password);
        if (!check.valid) return null;

        // Upgrade legacy plaintext password transparently to salted scrypt hash
        if (check.needsRehash) {
            try {
                const upgradedHash = AuthManager.hashPassword(cleanPass);
                const misc = {
                    ...AuthManager.parseMisc(rawUser.misc_settings),
                    is_blank_password: cleanPass === ''
                };
                if (this._hasOrmTable('sys_user')) {
                    await this.engine.updateById('sys_user', {
                        password: upgradedHash,
                        misc_settings: AuthManager.stringifyMisc(misc),
                        updated_at: this._nowStr()
                    }, Number(rawUser._id), false);
                } else {
                    await this.engine.run(
                        `UPDATE sys_user SET password = ?, misc_settings = ?, updated_at = ? WHERE _id = ?`,
                        [upgradedHash, AuthManager.stringifyMisc(misc), this._nowStr(), Number(rawUser._id)]
                    );
                }
                rawUser.password = upgradedHash;
                rawUser.misc_settings = AuthManager.stringifyMisc(misc);
            } catch {}
        }

        const user = this._sanitizeUser(rawUser);
        const rights = await this.getUserRights(user._id);
        return { user, rights };
    }

    async verifyUnmask({ userId, table, column, secret = '' } = {}) {
        const cleanSecret = AuthManager.normalizePassword(secret);

        if (table && column) {
            let colSec = null;
            try {
                colSec = this._hasOrmTable('sys_column_security')
                    ? await this.engine.getOne('sys_column_security', { table_name: table, column_name: column }, { full: false })
                    : await this.engine.queryOne(`SELECT * FROM sys_column_security WHERE table_name = ? AND column_name = ?`, [table, column]);
            } catch {}

            if (colSec && colSec.secret_hash && String(colSec.secret_hash).trim().length > 0) {
                const pinCheck = AuthManager.verifyPassword(cleanSecret, colSec.secret_hash);
                if (pinCheck.valid) {
                    if (pinCheck.needsRehash && colSec._id) {
                        try {
                            await this.engine.upsert('sys_column_security', ['table_name', 'column_name'], {
                                table_name: table,
                                column_name: column,
                                secret_hash: AuthManager.hashPassword(cleanSecret),
                                updated_at: this._nowStr()
                            });
                        } catch {}
                    }
                    return { authorized: true, method: 'column_pin' };
                }
                return { authorized: false, error: 'गलत पिन (विशेष कॉलम पिन अमान्य है)' };
            }
        }

        // Check active admins (handles hashed & blank passwords cleanly)
        const adminRows = this._hasOrmTable('sys_user')
            ? await this.engine.getAll('sys_user', { role: 'admin', active: 1 }, { full: false })
            : await this.engine.query(`SELECT * FROM sys_user WHERE role = 'admin' AND active = 1`);

        for (const adm of (adminRows || [])) {
            if (AuthManager.verifyPassword(cleanSecret, adm.password).valid) {
                return { authorized: true, method: 'admin_password' };
            }
        }

        if (userId) {
            const rawTarget = /^\d+$/.test(String(userId))
                ? await this._getRawUser({ _id: Number(userId), active: 1 })
                : await this._getRawUser({ username: String(userId).trim(), active: 1 });
            if (rawTarget && AuthManager.verifyPassword(cleanSecret, rawTarget.password).valid) {
                return { authorized: true, method: 'user_password' };
            }
        }

        return { authorized: false, error: 'गलत पासवर्ड (Invalid Admin Password)' };
    }

    async setColumnSecurity({ table, column, secret }) {
        if (!table || !column) throw new Error('Table and column required');
        const cleanSecret = AuthManager.normalizePassword(secret);
        if (!cleanSecret) {
            if (this._hasOrmTable('sys_column_security')) {
                await this.engine.delete('sys_column_security', { table_name: table, column_name: column });
            } else {
                await this.engine.run(`DELETE FROM sys_column_security WHERE table_name = ? AND column_name = ?`, [table, column]);
            }
            return { removed: true, message: 'Column security PIN removed (admin password will be used)' };
        }

        await this.engine.upsert('sys_column_security', ['table_name', 'column_name'], {
            table_name: table,
            column_name: column,
            secret_hash: AuthManager.hashPassword(cleanSecret),
            updated_at: this._nowStr()
        });
        return { removed: false, message: 'Column security PIN saved successfully' };
    }

    // ─────────────────────────────────────────────────────────
    // AUTHORIZATION & ROW-LEVEL OWNERSHIP HELPERS
    // ─────────────────────────────────────────────────────────

    getEffectiveRights(user, tableName, cachedRights = []) {
        if (!user) {
            return { can_view: false, can_edit: false, can_delete: false, can_unmask: false, data_scope: 'own', owner_col: DEFAULT_OWNER_COL };
        }
        if (user.role === 'admin') {
            return { can_view: true, can_edit: true, can_delete: true, can_unmask: true, data_scope: 'all', owner_col: DEFAULT_OWNER_COL };
        }
        const match = (cachedRights || []).find(r => r.table_name === tableName);
        if (!match) {
            return { can_view: true, can_edit: true, can_delete: true, can_unmask: false, data_scope: 'all', owner_col: DEFAULT_OWNER_COL };
        }
        return {
            can_view: match.can_view !== 0 && match.can_view !== false,
            can_edit: match.can_edit !== 0 && match.can_edit !== false,
            can_delete: match.can_delete !== 0 && match.can_delete !== false,
            can_unmask: match.can_unmask === 1 || match.can_unmask === true,
            data_scope: match.data_scope === 'own' ? 'own' : 'all',
            owner_col: match.owner_col || DEFAULT_OWNER_COL
        };
    }

    getOwnershipFilter(user, tableName, cachedRights = []) {
        if (!user || user.role === 'admin') return null;
        const eff = this.getEffectiveRights(user, tableName, cachedRights);
        if (eff.data_scope !== 'own') return null;
        const tbl = this.engine?._schema?.[tableName];
        const col = eff.owner_col || DEFAULT_OWNER_COL;
        if (!tbl?.columns?.[col]) return { column: col, value: Number(user._id), missingColumn: true };
        return { column: col, value: Number(user._id), missingColumn: false };
    }

    applyOwnershipWhere(where, ownershipFilter) {
        if (!ownershipFilter) return where;
        const qCol = this.engine?.core?.quoteId ? this.engine.core.quoteId(ownershipFilter.column) : `"${ownershipFilter.column}"`;
        const ownerVal = ownershipFilter.missingColumn ? -1 : ownershipFilter.value;

        if (!where) {
            return ownershipFilter.missingColumn
                ? { __sql: '1 = 0', __params: [] }
                : { [ownershipFilter.column]: ownerVal };
        }
        if (typeof where === 'string') {
            const sqlPart = ownershipFilter.missingColumn ? '1 = 0' : `${qCol} = ?`;
            return {
                __sql: where.trim() ? `(${where}) AND (${sqlPart})` : sqlPart,
                __params: ownershipFilter.missingColumn ? [] : [ownerVal]
            };
        }
        if (where.__sql) {
            const sqlPart = ownershipFilter.missingColumn ? '1 = 0' : `${qCol} = ?`;
            return {
                __sql: `(${where.__sql}) AND (${sqlPart})`,
                __params: [...(where.__params || []), ...(ownershipFilter.missingColumn ? [] : [ownerVal])]
            };
        }
        if (ownershipFilter.missingColumn) {
            return { __sql: '1 = 0', __params: [] };
        }
        return { ...where, [ownershipFilter.column]: ownerVal };
    }

    injectOwnerForWrite(tableName, row = {}, user = null) {
        if (!user || !row || typeof row !== 'object') return row;
        const tblCols = this.engine?._schema?.[tableName]?.columns;
        if (!tblCols || !tblCols[DEFAULT_OWNER_COL]) return row;

        // Admins may explicitly assign user_id or inherit their own ID if omitted;
        // Authors always own rows they insert unless already specified when permitted.
        if (user.role !== 'admin' || row[DEFAULT_OWNER_COL] === undefined || row[DEFAULT_OWNER_COL] === null || row[DEFAULT_OWNER_COL] === '') {
            return { ...row, [DEFAULT_OWNER_COL]: Number(user._id) };
        }
        return row;
    }

    maskRow(tableName, row, unmaskedCols = new Set()) {
        const schemaCols = this.engine?._schema?.[tableName]?.columns || {};
        return AuthManager.maskRowSensitiveFields(row, schemaCols, unmaskedCols);
    }

    maskRows(tableName, rows = [], unmaskedCols = new Set()) {
        const schemaCols = this.engine?._schema?.[tableName]?.columns || {};
        return (rows || []).map(r => AuthManager.maskRowSensitiveFields(r, schemaCols, unmaskedCols));
    }
}

module.exports = AuthManager;
