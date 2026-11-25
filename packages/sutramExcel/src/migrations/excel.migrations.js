// src/migrations/excel.migrations.js
// ─────────────────────────────────────────────────────────────
// sutramexcel declarative migration definitions.
// Executed cleanly through sutramEngine.migrateSystemModule('xls_version', ...)
// 100% database-agnostic — zero direct SQL dialect code.
// ─────────────────────────────────────────────────────────────

'use strict';

module.exports = [

    // ── version 1 — xls_dictionary ──────────────────────────────
    [
        {
            action: 'ensureTable',
            table: {
                table_name: 'xls_dictionary',
                label: 'Excel Import Dictionary',
                description: 'Correction memory mapping Excel aliases to database reference IDs',
                timestamps: true,
                uniqueKeys: [['type', 'name']],
                columns: [
                    { column_name: '_id',        label: 'ID',         col_type: 'number',  sql_type: 'INTEGER', is_pk: 1, is_required: 0 },
                    { column_name: 'type',       label: 'Type',       col_type: 'string',  sql_type: 'VARCHAR', length_precision: '191', is_required: 1 },
                    { column_name: 'name',       label: 'Alias Name', col_type: 'string',  sql_type: 'VARCHAR', length_precision: '191', is_required: 1 },
                    { column_name: 'ref_id',     label: 'Ref ID',     col_type: 'string',  sql_type: 'VARCHAR', length_precision: '191', is_required: 0 },
                    { column_name: 'ref_id2',    label: 'Ref ID 2',   col_type: 'string',  sql_type: 'VARCHAR', length_precision: '191', is_required: 0 },
                    { column_name: 'extra_note', label: 'Notes',      col_type: 'string',  sql_type: 'TEXT',    is_required: 0 },
                    { column_name: 'active',     label: 'Active',     col_type: 'boolean', sql_type: 'TINYINT', is_required: 0, default_value: '1' }
                ]
            }
        }
    ],

];
