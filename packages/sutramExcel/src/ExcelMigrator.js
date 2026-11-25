// src/ExcelMigrator.js
// ─────────────────────────────────────────────────────────────
// Delegates sutramexcel migrations cleanly to sutramEngine.
// Zero direct DB operations or SQL dialect code allowed here.
// ─────────────────────────────────────────────────────────────

'use strict';

const migrations = require('./migrations/excel.migrations');

class ExcelMigrator {

    constructor(engine) {
        if (!engine || typeof engine.migrateSystemModule !== 'function') {
            throw new Error('[sutramexcel] ExcelMigrator requires a valid SutramEngine instance');
        }
        this.engine = engine;
    }

    async run() {
        await this.engine.migrateSystemModule('xls_version', migrations);
    }
}

module.exports = ExcelMigrator;
