// src/migrations/sys.migrations.js
// ─────────────────────────────────────────────────────────────
// Engine's own migration list — stored in sys_meta.engine_version
// NOT in user_version pragma (that belongs to sutramCore / user migrations)
//
// Rules:
//   - Each version = array of SQL strings
//   - Never edit past versions — add new array at end
//   - Drop + recreate in SAME version array
// ─────────────────────────────────────────────────────────────

module.exports = [

    // ── version 1 — all sys_ tables ───────────────────────────
    [
        // sys_meta — engine version tracking
        `CREATE TABLE IF NOT EXISTS sys_meta (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )`,

        `INSERT OR IGNORE INTO sys_meta (key, value) VALUES ('engine_version', '0')`,

        // sys_table — table registry
        `CREATE TABLE IF NOT EXISTS sys_table (
            _id          INTEGER PRIMARY KEY AUTOINCREMENT,
            table_name   TEXT NOT NULL UNIQUE,
            label        TEXT,
            description  TEXT,
            is_system    INTEGER DEFAULT 0,
            active       INTEGER DEFAULT 1,
            created_at   TEXT DEFAULT (datetime('now', 'localtime')),
            updated_at   TEXT DEFAULT (datetime('now', 'localtime'))
        )`,

        // sys_column — column definitions per table
        `CREATE TABLE IF NOT EXISTS sys_column (
            _id            INTEGER PRIMARY KEY AUTOINCREMENT,
            table_id       INTEGER NOT NULL REFERENCES sys_table(_id) ON DELETE CASCADE,
            column_name    TEXT NOT NULL,
            label          TEXT,
            col_type       TEXT NOT NULL CHECK(col_type IN ('number','string','boolean','json','date','datetime','password')),
            is_required    INTEGER DEFAULT 0,
            default_value  TEXT,
            is_pk          INTEGER DEFAULT 0,
            ref_table      TEXT,
            ref_col        TEXT,
            ref_as         TEXT,
            ref_select     TEXT,
            sort_order     INTEGER DEFAULT 0,
            active         INTEGER DEFAULT 1,
            created_at     TEXT DEFAULT (datetime('now', 'localtime')),
            UNIQUE(table_id, column_name)
        )`,

        // sys_join — hasMany and manyToMany relations
        `CREATE TABLE IF NOT EXISTS sys_join (
            _id            INTEGER PRIMARY KEY AUTOINCREMENT,
            table_id       INTEGER NOT NULL REFERENCES sys_table(_id) ON DELETE CASCADE,
            join_type      TEXT NOT NULL CHECK(join_type IN ('hasMany','manyToMany')),
            join_key       TEXT NOT NULL,
            child_table    TEXT NOT NULL,
            junction_table TEXT,
            fk_col         TEXT NOT NULL,
            target_col     TEXT NOT NULL,
            as_name        TEXT NOT NULL,
            select_cols    TEXT NOT NULL DEFAULT '["*"]',
            active         INTEGER DEFAULT 1,
            created_at     TEXT DEFAULT (datetime('now', 'localtime')),
            UNIQUE(table_id, join_key)
        )`,

        // sys_trigger — trigger definitions
        `CREATE TABLE IF NOT EXISTS sys_trigger (
            _id              INTEGER PRIMARY KEY AUTOINCREMENT,
            trigger_name     TEXT NOT NULL UNIQUE,
            label            TEXT,
            source_table     TEXT NOT NULL,
            event            TEXT NOT NULL CHECK(event IN ('INSERT','UPDATE','DELETE')),
            condition_type   TEXT DEFAULT 'always'
                             CHECK(condition_type IN ('always','when_col_equals','raw_sql')),
            condition_col    TEXT,
            condition_value  TEXT,
            condition_sql    TEXT,
            active           INTEGER DEFAULT 1,
            created_at       TEXT DEFAULT (datetime('now', 'localtime')),
            updated_at       TEXT DEFAULT (datetime('now', 'localtime'))
        )`,

        // sys_trigger_action — actions per trigger (ordered)
        `CREATE TABLE IF NOT EXISTS sys_trigger_action (
            _id          INTEGER PRIMARY KEY AUTOINCREMENT,
            trigger_id   INTEGER NOT NULL REFERENCES sys_trigger(_id) ON DELETE CASCADE,
            sort_order   INTEGER DEFAULT 0,
            action_type  TEXT NOT NULL CHECK(action_type IN ('insert_row','update_row','delete_row','raw_sql')),
            target_table TEXT,
            field_map    TEXT DEFAULT '{}',
            condition    TEXT,
            raw_sql      TEXT,
            active       INTEGER DEFAULT 1
        )`,

        // sys_report — named CTE reports + stored procedure support
        `CREATE TABLE IF NOT EXISTS sys_report (
            _id             INTEGER PRIMARY KEY AUTOINCREMENT,
            report_name     TEXT NOT NULL UNIQUE,
            label           TEXT,
            description     TEXT,
            report_type     TEXT NOT NULL DEFAULT 'cte'
                            CHECK(report_type IN ('cte','procedure')),
            cte_sql         TEXT,
            procedure_name  TEXT,
            params          TEXT DEFAULT '[]',
            active          INTEGER DEFAULT 1,
            created_at      TEXT DEFAULT (datetime('now', 'localtime')),
            updated_at      TEXT DEFAULT (datetime('now', 'localtime'))
        )`,

        // sys_table_ui — frontend display config per table
        `CREATE TABLE IF NOT EXISTS sys_table_ui (
            _id          INTEGER PRIMARY KEY AUTOINCREMENT,
            table_id     INTEGER NOT NULL UNIQUE REFERENCES sys_table(_id) ON DELETE CASCADE,
            display_name TEXT,
            icon         TEXT,
            sort_order   INTEGER DEFAULT 0,
            visible      INTEGER DEFAULT 1,
            can_add      INTEGER DEFAULT 1,
            can_edit     INTEGER DEFAULT 1,
            can_delete   INTEGER DEFAULT 1,
            updated_at   TEXT DEFAULT (datetime('now', 'localtime'))
        )`,

        // sys_column_ui — frontend display config per column
        `CREATE TABLE IF NOT EXISTS sys_column_ui (
            _id             INTEGER PRIMARY KEY AUTOINCREMENT,
            column_id       INTEGER NOT NULL UNIQUE REFERENCES sys_column(_id) ON DELETE CASCADE,
            table_id        INTEGER NOT NULL REFERENCES sys_table(_id) ON DELETE CASCADE,
            label           TEXT,
            field_type      TEXT DEFAULT 'text',
            display_format  TEXT,
            visible_list    INTEGER DEFAULT 1,
            visible_form    INTEGER DEFAULT 1,
            searchable      INTEGER DEFAULT 0,
            sortable        INTEGER DEFAULT 0,
            required_ui     INTEGER DEFAULT 0,
            sort_order      INTEGER DEFAULT 0,
            updated_at      TEXT DEFAULT (datetime('now', 'localtime'))
        )`,

    ],

    // ── version 2 — sys_user for user management and authentication ──
    [
        `CREATE TABLE IF NOT EXISTS sys_user (
            _id          INTEGER PRIMARY KEY AUTOINCREMENT,
            username     TEXT NOT NULL UNIQUE,
            password     TEXT NOT NULL,
            display_name TEXT,
            role         TEXT NOT NULL DEFAULT 'author' CHECK(role IN ('admin', 'author')),
            active       INTEGER DEFAULT 1,
            created_at   TEXT DEFAULT (datetime('now', 'localtime')),
            updated_at   TEXT DEFAULT (datetime('now', 'localtime'))
        )`,

        `INSERT OR IGNORE INTO sys_user (username, password, display_name, role)
         VALUES ('admin', 'sutram', 'System Administrator', 'admin')`
    ],

    // ── version 3 — sys_user_rights and sys_column_security ──
    [
        `CREATE TABLE IF NOT EXISTS sys_user_rights (
            _id          INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id      INTEGER NOT NULL,
            table_name   TEXT NOT NULL,
            can_view     INTEGER DEFAULT 1,
            can_edit     INTEGER DEFAULT 1,
            can_delete   INTEGER DEFAULT 1,
            can_unmask   INTEGER DEFAULT 0,
            created_at   TEXT DEFAULT (datetime('now', 'localtime')),
            updated_at   TEXT DEFAULT (datetime('now', 'localtime')),
            UNIQUE(user_id, table_name)
        )`,

        `CREATE TABLE IF NOT EXISTS sys_column_security (
            _id          INTEGER PRIMARY KEY AUTOINCREMENT,
            table_name   TEXT NOT NULL,
            column_name  TEXT NOT NULL,
            secret_hash  TEXT NOT NULL,
            created_at   TEXT DEFAULT (datetime('now', 'localtime')),
            updated_at   TEXT DEFAULT (datetime('now', 'localtime')),
            UNIQUE(table_name, column_name)
        )`
    ],

    // ── version 4 — register sys_user in sys_table & sys_column ──
    [
        `INSERT INTO sys_table (table_name, label, description, is_system, active)
         SELECT 'sys_user', 'Users (उपयोगकर्ता)', 'System Users and Credentials', 1, 1
         WHERE NOT EXISTS (SELECT 1 FROM sys_table WHERE table_name = 'sys_user')`,

        `INSERT INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, '_id', 'ID', 'number', 0, 1, NULL, 0, 1
         FROM sys_table t WHERE t.table_name = 'sys_user'
         AND NOT EXISTS (SELECT 1 FROM sys_column c WHERE c.table_id = t._id AND c.column_name = '_id')`,

        `INSERT INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, 'username', 'Username', 'string', 1, 0, NULL, 1, 1
         FROM sys_table t WHERE t.table_name = 'sys_user'
         AND NOT EXISTS (SELECT 1 FROM sys_column c WHERE c.table_id = t._id AND c.column_name = 'username')`,

        `INSERT INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, 'password', 'Password', 'string', 1, 0, NULL, 2, 1
         FROM sys_table t WHERE t.table_name = 'sys_user'
         AND NOT EXISTS (SELECT 1 FROM sys_column c WHERE c.table_id = t._id AND c.column_name = 'password')`,

        `INSERT INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, 'display_name', 'Display Name', 'string', 0, 0, NULL, 3, 1
         FROM sys_table t WHERE t.table_name = 'sys_user'
         AND NOT EXISTS (SELECT 1 FROM sys_column c WHERE c.table_id = t._id AND c.column_name = 'display_name')`,

        `INSERT INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, 'role', 'Role', 'string', 1, 0, 'author', 4, 1
         FROM sys_table t WHERE t.table_name = 'sys_user'
         AND NOT EXISTS (SELECT 1 FROM sys_column c WHERE c.table_id = t._id AND c.column_name = 'role')`,

        `INSERT INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, 'active', 'Active', 'boolean', 0, 0, '1', 5, 1
         FROM sys_table t WHERE t.table_name = 'sys_user'
         AND NOT EXISTS (SELECT 1 FROM sys_column c WHERE c.table_id = t._id AND c.column_name = 'active')`,

        `INSERT INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, 'created_at', 'Created At', 'string', 0, 0, NULL, 6, 1
         FROM sys_table t WHERE t.table_name = 'sys_user'
         AND NOT EXISTS (SELECT 1 FROM sys_column c WHERE c.table_id = t._id AND c.column_name = 'created_at')`,

        `INSERT INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, 'updated_at', 'Updated At', 'string', 0, 0, NULL, 7, 1
         FROM sys_table t WHERE t.table_name = 'sys_user'
         AND NOT EXISTS (SELECT 1 FROM sys_column c WHERE c.table_id = t._id AND c.column_name = 'updated_at')`
    ],

    // ── version 5 — sys_reminder_rule & sys_reminder_log ──────────
    [
        `CREATE TABLE IF NOT EXISTS sys_reminder_rule (
            _id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            rule_name            TEXT NOT NULL,
            reminder_type        TEXT NOT NULL CHECK(reminder_type IN ('normal', 'smart_watchdog')),
            severity             TEXT DEFAULT 'warning' CHECK(severity IN ('info', 'warning', 'critical')),
            is_permanent         INTEGER DEFAULT 0,
            target_datetime      TEXT,
            notes                TEXT,
            target_table         TEXT,
            target_column        TEXT,
            col_type             TEXT,
            operator             TEXT,
            operand_value        TEXT,
            condition_json       TEXT,
            schedule_time        TEXT,
            frequency            TEXT DEFAULT 'daily_once' CHECK(frequency IN ('once', 'daily_once', 'on_mutation', 'hourly', 'realtime')),
            catch_up_if_missed   INTEGER DEFAULT 1,
            message_template     TEXT NOT NULL,
            sound_chime          TEXT DEFAULT 'default',
            active               INTEGER DEFAULT 1,
            created_by           TEXT,
            created_at           TEXT DEFAULT (datetime('now', 'localtime')),
            updated_at           TEXT DEFAULT (datetime('now', 'localtime'))
        )`,

        `CREATE TABLE IF NOT EXISTS sys_reminder_log (
            _id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            rule_id              INTEGER NOT NULL REFERENCES sys_reminder_rule(_id) ON DELETE CASCADE,
            triggered_at         TEXT DEFAULT (datetime('now', 'localtime')),
            matching_count       INTEGER DEFAULT 0,
            sample_records_json  TEXT,
            status               TEXT DEFAULT 'active' CHECK(status IN ('active', 'snoozed', 'dismissed', 'auto_resolved')),
            snoozed_until        TEXT,
            dismissed_at         TEXT,
            dismissed_by         TEXT,
            resolution_note      TEXT,
            is_permanent_active  INTEGER DEFAULT 0,
            created_at           TEXT DEFAULT (datetime('now', 'localtime')),
            updated_at           TEXT DEFAULT (datetime('now', 'localtime'))
        )`,

        `INSERT INTO sys_table (table_name, label, description, is_system, active)
         SELECT 'sys_reminder_rule', 'Reminder Rules (स्मार्ट अनुस्मारक नियम)', 'Automated watchdog and reminder rules', 1, 1
         WHERE NOT EXISTS (SELECT 1 FROM sys_table WHERE table_name = 'sys_reminder_rule')`,

        `INSERT INTO sys_table (table_name, label, description, is_system, active)
         SELECT 'sys_reminder_log', 'Reminder History (अनुस्मारक इतिहास)', 'Firing history and notification logs', 1, 1
         WHERE NOT EXISTS (SELECT 1 FROM sys_table WHERE table_name = 'sys_reminder_log')`
    ],

    // ── version 6 — register sys_reminder_rule & sys_reminder_log columns in sys_column ──
    [
        // Columns for sys_reminder_rule
        `INSERT INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, '_id', 'ID', 'number', 0, 1, NULL, 0, 1
         FROM sys_table t WHERE t.table_name = 'sys_reminder_rule'
         AND NOT EXISTS (SELECT 1 FROM sys_column c WHERE c.table_id = t._id AND c.column_name = '_id')`,

        `INSERT INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, 'rule_name', 'Rule Name (नियम नाम)', 'string', 1, 0, NULL, 1, 1
         FROM sys_table t WHERE t.table_name = 'sys_reminder_rule'
         AND NOT EXISTS (SELECT 1 FROM sys_column c WHERE c.table_id = t._id AND c.column_name = 'rule_name')`,

        `INSERT INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, 'reminder_type', 'Type (प्रकार)', 'string', 1, 0, 'normal', 2, 1
         FROM sys_table t WHERE t.table_name = 'sys_reminder_rule'
         AND NOT EXISTS (SELECT 1 FROM sys_column c WHERE c.table_id = t._id AND c.column_name = 'reminder_type')`,

        `INSERT INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, 'severity', 'Severity (गंभीरता)', 'string', 0, 0, 'warning', 3, 1
         FROM sys_table t WHERE t.table_name = 'sys_reminder_rule'
         AND NOT EXISTS (SELECT 1 FROM sys_column c WHERE c.table_id = t._id AND c.column_name = 'severity')`,

        `INSERT INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, 'is_permanent', 'Permanent Alert (स्थायी)', 'boolean', 0, 0, '0', 4, 1
         FROM sys_table t WHERE t.table_name = 'sys_reminder_rule'
         AND NOT EXISTS (SELECT 1 FROM sys_column c WHERE c.table_id = t._id AND c.column_name = 'is_permanent')`,

        `INSERT INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, 'target_table', 'Target Table (तालिका)', 'string', 0, 0, NULL, 5, 1
         FROM sys_table t WHERE t.table_name = 'sys_reminder_rule'
         AND NOT EXISTS (SELECT 1 FROM sys_column c WHERE c.table_id = t._id AND c.column_name = 'target_table')`,

        `INSERT INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, 'target_column', 'Target Column (कॉलम)', 'string', 0, 0, NULL, 6, 1
         FROM sys_table t WHERE t.table_name = 'sys_reminder_rule'
         AND NOT EXISTS (SELECT 1 FROM sys_column c WHERE c.table_id = t._id AND c.column_name = 'target_column')`,

        `INSERT INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, 'col_type', 'Data Type', 'string', 0, 0, 'number', 7, 1
         FROM sys_table t WHERE t.table_name = 'sys_reminder_rule'
         AND NOT EXISTS (SELECT 1 FROM sys_column c WHERE c.table_id = t._id AND c.column_name = 'col_type')`,

        `INSERT INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, 'operator', 'Operator (शर्त)', 'string', 0, 0, '<', 8, 1
         FROM sys_table t WHERE t.table_name = 'sys_reminder_rule'
         AND NOT EXISTS (SELECT 1 FROM sys_column c WHERE c.table_id = t._id AND c.column_name = 'operator')`,

        `INSERT INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, 'operand_value', 'Threshold Value (मान)', 'string', 0, 0, NULL, 9, 1
         FROM sys_table t WHERE t.table_name = 'sys_reminder_rule'
         AND NOT EXISTS (SELECT 1 FROM sys_column c WHERE c.table_id = t._id AND c.column_name = 'operand_value')`,

        `INSERT INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, 'schedule_time', 'Schedule Time (समय e.g. 03:00)', 'string', 0, 0, NULL, 10, 1
         FROM sys_table t WHERE t.table_name = 'sys_reminder_rule'
         AND NOT EXISTS (SELECT 1 FROM sys_column c WHERE c.table_id = t._id AND c.column_name = 'schedule_time')`,

        `INSERT INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, 'frequency', 'Frequency (आवृत्ति)', 'string', 0, 0, 'daily_once', 11, 1
         FROM sys_table t WHERE t.table_name = 'sys_reminder_rule'
         AND NOT EXISTS (SELECT 1 FROM sys_column c WHERE c.table_id = t._id AND c.column_name = 'frequency')`,

        `INSERT INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, 'catch_up_if_missed', 'Catch Up If Missed', 'boolean', 0, 0, '1', 12, 1
         FROM sys_table t WHERE t.table_name = 'sys_reminder_rule'
         AND NOT EXISTS (SELECT 1 FROM sys_column c WHERE c.table_id = t._id AND c.column_name = 'catch_up_if_missed')`,

        `INSERT INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, 'message_template', 'Message (संदेश)', 'string', 1, 0, NULL, 13, 1
         FROM sys_table t WHERE t.table_name = 'sys_reminder_rule'
         AND NOT EXISTS (SELECT 1 FROM sys_column c WHERE c.table_id = t._id AND c.column_name = 'message_template')`,

        `INSERT INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, 'notes', 'Notes (विवरण)', 'string', 0, 0, NULL, 14, 1
         FROM sys_table t WHERE t.table_name = 'sys_reminder_rule'
         AND NOT EXISTS (SELECT 1 FROM sys_column c WHERE c.table_id = t._id AND c.column_name = 'notes')`,

        `INSERT INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, 'active', 'Active (सक्रिय)', 'boolean', 0, 0, '1', 15, 1
         FROM sys_table t WHERE t.table_name = 'sys_reminder_rule'
         AND NOT EXISTS (SELECT 1 FROM sys_column c WHERE c.table_id = t._id AND c.column_name = 'active')`,

        `INSERT INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, 'created_at', 'Created At', 'string', 0, 0, NULL, 16, 1
         FROM sys_table t WHERE t.table_name = 'sys_reminder_rule'
         AND NOT EXISTS (SELECT 1 FROM sys_column c WHERE c.table_id = t._id AND c.column_name = 'created_at')`,

        `INSERT INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, 'updated_at', 'Updated At', 'string', 0, 0, NULL, 17, 1
         FROM sys_table t WHERE t.table_name = 'sys_reminder_rule'
         AND NOT EXISTS (SELECT 1 FROM sys_column c WHERE c.table_id = t._id AND c.column_name = 'updated_at')`,

        // Columns for sys_reminder_log
        `INSERT INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, '_id', 'ID', 'number', 0, 1, NULL, 0, 1
         FROM sys_table t WHERE t.table_name = 'sys_reminder_log'
         AND NOT EXISTS (SELECT 1 FROM sys_column c WHERE c.table_id = t._id AND c.column_name = '_id')`,

        `INSERT INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, 'rule_id', 'Rule ID', 'number', 1, 0, NULL, 1, 1
         FROM sys_table t WHERE t.table_name = 'sys_reminder_log'
         AND NOT EXISTS (SELECT 1 FROM sys_column c WHERE c.table_id = t._id AND c.column_name = 'rule_id')`,

        `INSERT INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, 'triggered_at', 'Triggered At', 'string', 0, 0, NULL, 2, 1
         FROM sys_table t WHERE t.table_name = 'sys_reminder_log'
         AND NOT EXISTS (SELECT 1 FROM sys_column c WHERE c.table_id = t._id AND c.column_name = 'triggered_at')`,

        `INSERT INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, 'matching_count', 'Matches Count', 'number', 0, 0, '0', 3, 1
         FROM sys_table t WHERE t.table_name = 'sys_reminder_log'
         AND NOT EXISTS (SELECT 1 FROM sys_column c WHERE c.table_id = t._id AND c.column_name = 'matching_count')`,

        `INSERT INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, 'status', 'Status', 'string', 0, 0, 'active', 4, 1
         FROM sys_table t WHERE t.table_name = 'sys_reminder_log'
         AND NOT EXISTS (SELECT 1 FROM sys_column c WHERE c.table_id = t._id AND c.column_name = 'status')`,

        `INSERT INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, 'snoozed_until', 'Snoozed Until', 'string', 0, 0, NULL, 5, 1
         FROM sys_table t WHERE t.table_name = 'sys_reminder_log'
         AND NOT EXISTS (SELECT 1 FROM sys_column c WHERE c.table_id = t._id AND c.column_name = 'snoozed_until')`,

        `INSERT INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, 'dismissed_at', 'Dismissed At', 'string', 0, 0, NULL, 6, 1
         FROM sys_table t WHERE t.table_name = 'sys_reminder_log'
         AND NOT EXISTS (SELECT 1 FROM sys_column c WHERE c.table_id = t._id AND c.column_name = 'dismissed_at')`,

        `INSERT INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, 'dismissed_by', 'Dismissed By', 'string', 0, 0, NULL, 7, 1
         FROM sys_table t WHERE t.table_name = 'sys_reminder_log'
         AND NOT EXISTS (SELECT 1 FROM sys_column c WHERE c.table_id = t._id AND c.column_name = 'dismissed_by')`,

        `INSERT INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, 'resolution_note', 'Resolution Note', 'string', 0, 0, NULL, 8, 1
         FROM sys_table t WHERE t.table_name = 'sys_reminder_log'
         AND NOT EXISTS (SELECT 1 FROM sys_column c WHERE c.table_id = t._id AND c.column_name = 'resolution_note')`,

        `INSERT INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, 'is_permanent_active', 'Permanent Active', 'boolean', 0, 0, '0', 9, 1
         FROM sys_table t WHERE t.table_name = 'sys_reminder_log'
         AND NOT EXISTS (SELECT 1 FROM sys_column c WHERE c.table_id = t._id AND c.column_name = 'is_permanent_active')`,

        `INSERT INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, 'created_at', 'Created At', 'string', 0, 0, NULL, 10, 1
         FROM sys_table t WHERE t.table_name = 'sys_reminder_log'
         AND NOT EXISTS (SELECT 1 FROM sys_column c WHERE c.table_id = t._id AND c.column_name = 'created_at')`,

        `INSERT INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, 'updated_at', 'Updated At', 'string', 0, 0, NULL, 11, 1
         FROM sys_table t WHERE t.table_name = 'sys_reminder_log'
         AND NOT EXISTS (SELECT 1 FROM sys_column c WHERE c.table_id = t._id AND c.column_name = 'updated_at')`
    ],

    // ── version 7 — enrich sys_reminder_log with human-readable columns ──
    [
        `ALTER TABLE sys_reminder_log ADD COLUMN severity TEXT DEFAULT 'warning'`,
        `ALTER TABLE sys_reminder_log ADD COLUMN rule_name TEXT`,
        `ALTER TABLE sys_reminder_log ADD COLUMN message TEXT`,
        `ALTER TABLE sys_reminder_log ADD COLUMN target_table TEXT`,
        `ALTER TABLE sys_reminder_log ADD COLUMN target_column TEXT`,

        `UPDATE sys_table SET label = 'Incoming Reminders (आए हुए अनुस्मारक)', description = 'Incoming alerts and notification logs' WHERE table_name = 'sys_reminder_log'`,

        `INSERT INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, 'severity', 'Priority (प्राथमिकता)', 'string', 0, 0, 'warning', 1, 1
         FROM sys_table t WHERE t.table_name = 'sys_reminder_log'
         AND NOT EXISTS (SELECT 1 FROM sys_column c WHERE c.table_id = t._id AND c.column_name = 'severity')`,

        `INSERT INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, 'rule_name', 'Reminder (अनुस्मारक)', 'string', 0, 0, NULL, 2, 1
         FROM sys_table t WHERE t.table_name = 'sys_reminder_log'
         AND NOT EXISTS (SELECT 1 FROM sys_column c WHERE c.table_id = t._id AND c.column_name = 'rule_name')`,

        `INSERT INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, 'message', 'Alert Message (संदेश)', 'string', 0, 0, NULL, 3, 1
         FROM sys_table t WHERE t.table_name = 'sys_reminder_log'
         AND NOT EXISTS (SELECT 1 FROM sys_column c WHERE c.table_id = t._id AND c.column_name = 'message')`,

        `INSERT INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, 'target_table', 'Source Table (तालिका)', 'string', 0, 0, NULL, 4, 1
         FROM sys_table t WHERE t.table_name = 'sys_reminder_log'
         AND NOT EXISTS (SELECT 1 FROM sys_column c WHERE c.table_id = t._id AND c.column_name = 'target_table')`,

        `INSERT INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, 'target_column', 'Column (कॉलम)', 'string', 0, 0, NULL, 5, 1
         FROM sys_table t WHERE t.table_name = 'sys_reminder_log'
         AND NOT EXISTS (SELECT 1 FROM sys_column c WHERE c.table_id = t._id AND c.column_name = 'target_column')`,

        `UPDATE sys_reminder_log SET
            rule_name = (SELECT r.rule_name FROM sys_reminder_rule r WHERE r._id = sys_reminder_log.rule_id),
            severity = (SELECT r.severity FROM sys_reminder_rule r WHERE r._id = sys_reminder_log.rule_id),
            message = (SELECT r.message_template FROM sys_reminder_rule r WHERE r._id = sys_reminder_log.rule_id),
            target_table = (SELECT r.target_table FROM sys_reminder_rule r WHERE r._id = sys_reminder_log.rule_id),
            target_column = (SELECT r.target_column FROM sys_reminder_rule r WHERE r._id = sys_reminder_log.rule_id)
         WHERE rule_name IS NULL`
    ],

    // ─────────────────────────────────────────────────────────
    // Upgrade sys_column CHECK constraint to support date, datetime, password
    // ─────────────────────────────────────────────────────────
    [
        `CREATE TABLE IF NOT EXISTS __sys_column_new (
            _id            INTEGER PRIMARY KEY AUTOINCREMENT,
            table_id       INTEGER NOT NULL REFERENCES sys_table(_id) ON DELETE CASCADE,
            column_name    TEXT NOT NULL,
            label          TEXT,
            col_type       TEXT NOT NULL CHECK(col_type IN ('number','string','boolean','json','date','datetime','password')),
            is_required    INTEGER DEFAULT 0,
            default_value  TEXT,
            is_pk          INTEGER DEFAULT 0,
            ref_table      TEXT,
            ref_col        TEXT,
            ref_as         TEXT,
            ref_select     TEXT,
            sort_order     INTEGER DEFAULT 0,
            active         INTEGER DEFAULT 1,
            created_at     TEXT DEFAULT (datetime('now', 'localtime')),
            UNIQUE(table_id, column_name)
        )`,
        `INSERT INTO __sys_column_new
            (_id, table_id, column_name, label, col_type, is_required, default_value,
             is_pk, ref_table, ref_col, ref_as, ref_select, sort_order, active, created_at)
         SELECT
            _id, table_id, column_name, label, col_type, is_required, default_value,
            is_pk, ref_table, ref_col, ref_as, ref_select, sort_order, active, created_at
         FROM sys_column`,
        `DROP TABLE sys_column`,
        `ALTER TABLE __sys_column_new RENAME TO sys_column`
    ],

    // ── version 9 — can_ocr capability flag on sys_user ─────────
    [
        `ALTER TABLE sys_user ADD COLUMN can_ocr INTEGER DEFAULT 1`
    ]

];

