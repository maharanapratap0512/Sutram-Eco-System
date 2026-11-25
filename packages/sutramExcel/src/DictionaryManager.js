// src/DictionaryManager.js
// Operates strictly through sutramEngine — zero direct DB or SQL dialect calls.
'use strict';

class DictionaryManager {

    constructor(engine) {
        this.engine = engine;
    }

    _nowStr() {
        const d = new Date();
        const pad = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }

    // ── LOOKUP — used by RefMatcher ───────────────────────────
    async find(type, name) {
        if (!name || !this.engine) return null;
        const clean = this._clean(name);
        try {
            return await this.engine.getOne('xls_dictionary', { type, name: clean, active: 1 }, { full: false }) ?? null;
        } catch {
            return null;
        }
    }

    // ── ADD — save correction ─────────────────────────────────
    async add({ type, name, ref_id, ref_id2 = null, extra_note = null }) {
        if (!type || !name) throw new Error('[sutramexcel] type and name required');
        if (!this.engine) return null;
        const clean = this._clean(name);

        const existing = await this.engine.getOne('xls_dictionary', { type, name: clean }, { full: false });

        if (existing) {
            await this.engine.updateById('xls_dictionary', {
                ref_id: String(ref_id ?? ''),
                ref_id2: ref_id2 ? String(ref_id2) : null,
                extra_note,
                active: 1,
                updated_at: this._nowStr()
            }, existing._id, false);
            console.log(`[sutramexcel] Dictionary updated: ${type} "${name}"`);
            return existing._id;
        }

        const newId = await this.engine.insert('xls_dictionary', {
            type,
            name: clean,
            ref_id: String(ref_id ?? ''),
            ref_id2: ref_id2 ? String(ref_id2) : null,
            extra_note,
            active: 1
        }, false);
        console.log(`[sutramexcel] Dictionary added: ${type} "${name}" → ${ref_id}`);
        return newId;
    }

    // ── LIST ──────────────────────────────────────────────────
    async list(type = null) {
        if (!this.engine) return [];
        try {
            const where = type ? { type, active: 1 } : { active: 1 };
            return await this.engine.getAll('xls_dictionary', where, { full: false, orderBy: 'type ASC, name ASC' });
        } catch {
            return [];
        }
    }

    // ── UPDATE ────────────────────────────────────────────────
    async update(id, { ref_id, ref_id2, extra_note, active }) {
        if (!this.engine) return;
        const updates = {};

        if (ref_id     !== undefined) updates.ref_id = String(ref_id ?? '');
        if (ref_id2    !== undefined) updates.ref_id2 = ref_id2 ? String(ref_id2) : null;
        if (extra_note !== undefined) updates.extra_note = extra_note;
        if (active     !== undefined) updates.active = active ? 1 : 0;

        if (Object.keys(updates).length === 0) return;
        updates.updated_at = this._nowStr();

        await this.engine.updateById('xls_dictionary', updates, id, false);
    }

    // ── DELETE (soft) ─────────────────────────────────────────
    async delete(id) {
        if (!this.engine) return;
        await this.engine.updateById('xls_dictionary', {
            active: 0,
            updated_at: this._nowStr()
        }, id, false);
    }

    // ── HARD DELETE ───────────────────────────────────────────
    async hardDelete(id) {
        if (!this.engine) return;
        await this.engine.deleteById('xls_dictionary', id);
    }

    // ── HELPER ───────────────────────────────────────────────
    _clean(str) {
        return (str || '')
            .toString()
            .trim()
            .normalize('NFC')
            .replace(/\u200B/g, '')
            .replace(/\u00A0/g, ' ')
            .replace(/\s+/g, ' ')
            .toLowerCase();
    }
}

module.exports = DictionaryManager;
