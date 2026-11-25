// src/migrations/sys.migrations.mysql.js
// ─────────────────────────────────────────────────────────────
// MySQL-native migration list for Sutram internal sys_ tables.
// Stored in sys_meta.engine_version.
// ─────────────────────────────────────────────────────────────

'use strict';

module.exports = [

    // ── version 1 — core sys_ tables ───────────────────────────
    [
        // sys_meta — version tracking
        `CREATE TABLE IF NOT EXISTS sys_meta (
            \`key\`   VARCHAR(191) PRIMARY KEY,
            \`value\` TEXT NOT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

        `INSERT IGNORE INTO sys_meta (\`key\`, \`value\`) VALUES ('engine_version', '0')`,

        // sys_table — table registry
        `CREATE TABLE IF NOT EXISTS sys_table (
            _id          INT AUTO_INCREMENT PRIMARY KEY,
            table_name   VARCHAR(191) NOT NULL UNIQUE,
            label        VARCHAR(255),
            description  TEXT,
            is_system    TINYINT DEFAULT 0,
            active       TINYINT DEFAULT 1,
            created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

        // sys_column — column definitions per table
        `CREATE TABLE IF NOT EXISTS sys_column (
            _id            INT AUTO_INCREMENT PRIMARY KEY,
            table_id       INT NOT NULL,
            column_name    VARCHAR(191) NOT NULL,
            label          VARCHAR(255),
            col_type       VARCHAR(64) NOT NULL,
            is_required    TINYINT DEFAULT 0,
            default_value  TEXT,
            is_pk          TINYINT DEFAULT 0,
            ref_table      VARCHAR(191),
            ref_col        VARCHAR(191),
            ref_as         VARCHAR(191),
            ref_select     TEXT,
            sort_order     INT DEFAULT 0,
            active         TINYINT DEFAULT 1,
            created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uk_table_col (table_id, column_name),
            CONSTRAINT fk_sys_col_table FOREIGN KEY (table_id) REFERENCES sys_table(_id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

        // sys_join — hasMany and manyToMany relations
        `CREATE TABLE IF NOT EXISTS sys_join (
            _id            INT AUTO_INCREMENT PRIMARY KEY,
            table_id       INT NOT NULL,
            join_type      VARCHAR(64) NOT NULL,
            join_key       VARCHAR(191) NOT NULL,
            child_table    VARCHAR(191) NOT NULL,
            junction_table VARCHAR(191),
            fk_col         VARCHAR(191) NOT NULL,
            target_col     VARCHAR(191) NOT NULL,
            as_name        VARCHAR(191) NOT NULL,
            select_cols    TEXT,
            active         TINYINT DEFAULT 1,
            created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uk_table_join (table_id, join_key),
            CONSTRAINT fk_sys_join_table FOREIGN KEY (table_id) REFERENCES sys_table(_id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

        // sys_trigger — trigger definitions
        `CREATE TABLE IF NOT EXISTS sys_trigger (
            _id              INT AUTO_INCREMENT PRIMARY KEY,
            trigger_name     VARCHAR(191) NOT NULL UNIQUE,
            label            VARCHAR(255),
            source_table     VARCHAR(191) NOT NULL,
            event            VARCHAR(32) NOT NULL,
            condition_type   VARCHAR(64) DEFAULT 'always',
            condition_col    VARCHAR(191),
            condition_value  TEXT,
            condition_sql    TEXT,
            active           TINYINT DEFAULT 1,
            created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

        // sys_trigger_action — actions per trigger (ordered)
        `CREATE TABLE IF NOT EXISTS sys_trigger_action (
            _id          INT AUTO_INCREMENT PRIMARY KEY,
            trigger_id   INT NOT NULL,
            sort_order   INT DEFAULT 0,
            action_type  VARCHAR(64) NOT NULL,
            target_table VARCHAR(191),
            field_map    TEXT,
            \`condition\`  TEXT,
            raw_sql      TEXT,
            active       TINYINT DEFAULT 1,
            CONSTRAINT fk_sys_act_trigger FOREIGN KEY (trigger_id) REFERENCES sys_trigger(_id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

        // sys_report — named CTE reports + stored procedure support
        `CREATE TABLE IF NOT EXISTS sys_report (
            _id             INT AUTO_INCREMENT PRIMARY KEY,
            report_name     VARCHAR(191) NOT NULL UNIQUE,
            label           VARCHAR(255),
            description     TEXT,
            report_type     VARCHAR(64) NOT NULL DEFAULT 'cte',
            cte_sql         LONGTEXT,
            procedure_name  VARCHAR(191),
            params          TEXT,
            active          TINYINT DEFAULT 1,
            created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

        // sys_table_ui — frontend display config per table
        `CREATE TABLE IF NOT EXISTS sys_table_ui (
            _id          INT AUTO_INCREMENT PRIMARY KEY,
            table_id     INT NOT NULL UNIQUE,
            display_name VARCHAR(255),
            icon         VARCHAR(64),
            sort_order   INT DEFAULT 0,
            visible      TINYINT DEFAULT 1,
            can_add      TINYINT DEFAULT 1,
            can_edit     TINYINT DEFAULT 1,
            can_delete   TINYINT DEFAULT 1,
            updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            CONSTRAINT fk_sys_tui_table FOREIGN KEY (table_id) REFERENCES sys_table(_id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

        // sys_column_ui — frontend display config per column
        `CREATE TABLE IF NOT EXISTS sys_column_ui (
            _id             INT AUTO_INCREMENT PRIMARY KEY,
            column_id       INT NOT NULL UNIQUE,
            table_id        INT NOT NULL,
            label           VARCHAR(255),
            field_type      VARCHAR(64) DEFAULT 'text',
            display_format  VARCHAR(64),
            visible_list    TINYINT DEFAULT 1,
            visible_form    TINYINT DEFAULT 1,
            searchable      TINYINT DEFAULT 0,
            sortable        TINYINT DEFAULT 0,
            required_ui     TINYINT DEFAULT 0,
            sort_order      INT DEFAULT 0,
            updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            CONSTRAINT fk_sys_cui_col FOREIGN KEY (column_id) REFERENCES sys_column(_id) ON DELETE CASCADE,
            CONSTRAINT fk_sys_cui_table FOREIGN KEY (table_id) REFERENCES sys_table(_id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
    ],

    // ── version 2 — sys_user ──────────────────────────────────
    [
        `CREATE TABLE IF NOT EXISTS sys_user (
            _id          INT AUTO_INCREMENT PRIMARY KEY,
            username     VARCHAR(191) NOT NULL UNIQUE,
            password     VARCHAR(255) NOT NULL,
            display_name VARCHAR(255),
            role         VARCHAR(64) NOT NULL DEFAULT 'author',
            active       TINYINT DEFAULT 1,
            created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

        `INSERT IGNORE INTO sys_user (username, password, display_name, role)
         VALUES ('admin', 'sutram', 'System Administrator', 'admin')`
    ],

    // ── version 3 — sys_user_rights and sys_column_security ──
    [
        `CREATE TABLE IF NOT EXISTS sys_user_rights (
            _id          INT AUTO_INCREMENT PRIMARY KEY,
            user_id      INT NOT NULL,
            table_name   VARCHAR(191) NOT NULL,
            can_view     TINYINT DEFAULT 1,
            can_edit     TINYINT DEFAULT 1,
            can_delete   TINYINT DEFAULT 1,
            can_unmask   TINYINT DEFAULT 0,
            created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uk_user_table (user_id, table_name)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

        `CREATE TABLE IF NOT EXISTS sys_column_security (
            _id          INT AUTO_INCREMENT PRIMARY KEY,
            table_name   VARCHAR(191) NOT NULL,
            column_name  VARCHAR(191) NOT NULL,
            secret_hash  VARCHAR(255) NOT NULL,
            created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uk_table_column (table_name, column_name)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
    ],

    // ── version 4 — register sys_user in sys_table & sys_column ──
    [
        `INSERT IGNORE INTO sys_table (table_name, label, description, is_system, active)
         VALUES ('sys_user', 'Users (उपयोगकर्ता)', 'System Users and Credentials', 1, 1)`,

        `INSERT IGNORE INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, '_id', 'ID', 'number', 0, 1, NULL, 0, 1
         FROM sys_table t WHERE t.table_name = 'sys_user'`,

        `INSERT IGNORE INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, 'username', 'Username', 'string', 1, 0, NULL, 1, 1
         FROM sys_table t WHERE t.table_name = 'sys_user'`,

        `INSERT IGNORE INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, 'password', 'Password', 'string', 1, 0, NULL, 2, 1
         FROM sys_table t WHERE t.table_name = 'sys_user'`,

        `INSERT IGNORE INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, 'display_name', 'Display Name', 'string', 0, 0, NULL, 3, 1
         FROM sys_table t WHERE t.table_name = 'sys_user'`,

        `INSERT IGNORE INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, 'role', 'Role', 'string', 1, 0, 'author', 4, 1
         FROM sys_table t WHERE t.table_name = 'sys_user'`,

        `INSERT IGNORE INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, 'active', 'Active', 'boolean', 0, 0, '1', 5, 1
         FROM sys_table t WHERE t.table_name = 'sys_user'`
    ],

    // ── version 5 — sys_reminder_rule & sys_reminder_log ──────────
    [
        `CREATE TABLE IF NOT EXISTS sys_reminder_rule (
            _id                  INT AUTO_INCREMENT PRIMARY KEY,
            rule_name            VARCHAR(191) NOT NULL,
            reminder_type        VARCHAR(64) NOT NULL,
            severity             VARCHAR(32) DEFAULT 'warning',
            is_permanent         TINYINT DEFAULT 0,
            target_datetime      DATETIME,
            notes                TEXT,
            target_table         VARCHAR(191),
            target_column        VARCHAR(191),
            col_type             VARCHAR(64),
            operator             VARCHAR(32),
            operand_value        TEXT,
            condition_json       TEXT,
            schedule_time        VARCHAR(32),
            frequency            VARCHAR(64) DEFAULT 'daily_once',
            catch_up_if_missed   TINYINT DEFAULT 1,
            message_template     TEXT NOT NULL,
            sound_chime          VARCHAR(64) DEFAULT 'default',
            active               TINYINT DEFAULT 1,
            created_by           VARCHAR(191),
            created_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at           DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

        `CREATE TABLE IF NOT EXISTS sys_reminder_log (
            _id                  INT AUTO_INCREMENT PRIMARY KEY,
            rule_id              INT NOT NULL,
            triggered_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
            matching_count       INT DEFAULT 0,
            sample_records_json  LONGTEXT,
            status               VARCHAR(64) DEFAULT 'active',
            snoozed_until        DATETIME,
            dismissed_at         DATETIME,
            dismissed_by         VARCHAR(191),
            resolution_note      TEXT,
            is_permanent_active  TINYINT DEFAULT 0,
            created_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at           DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            CONSTRAINT fk_sys_rem_rule FOREIGN KEY (rule_id) REFERENCES sys_reminder_rule(_id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

        `INSERT IGNORE INTO sys_table (table_name, label, description, is_system, active)
         VALUES ('sys_reminder_rule', 'Reminder Rules (स्मार्ट अनुस्मारक नियम)', 'Automated watchdog and reminder rules', 1, 1)`,

        `INSERT IGNORE INTO sys_table (table_name, label, description, is_system, active)
         VALUES ('sys_reminder_log', 'Reminder History (अनुस्मारक इतिहास)', 'Firing history and notification logs', 1, 1)`
    ],

    // ── version 6 — sys_reminder registered in sys_column ─────────
    [
        `INSERT IGNORE INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, '_id', 'ID', 'number', 0, 1, NULL, 0, 1
         FROM sys_table t WHERE t.table_name = 'sys_reminder_rule'`,

        `INSERT IGNORE INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, 'rule_name', 'Rule Name', 'string', 1, 0, NULL, 1, 1
         FROM sys_table t WHERE t.table_name = 'sys_reminder_rule'`,

        `INSERT IGNORE INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, '_id', 'ID', 'number', 0, 1, NULL, 0, 1
         FROM sys_table t WHERE t.table_name = 'sys_reminder_log'`
    ],

    // ── version 7 — enrich sys_reminder_log ───────────────────────
    [
        `ALTER TABLE sys_reminder_log ADD COLUMN severity VARCHAR(32) DEFAULT 'warning'`,
        `ALTER TABLE sys_reminder_log ADD COLUMN rule_name VARCHAR(191)`,
        `ALTER TABLE sys_reminder_log ADD COLUMN message TEXT`,
        `ALTER TABLE sys_reminder_log ADD COLUMN target_table VARCHAR(191)`,
        `ALTER TABLE sys_reminder_log ADD COLUMN target_column VARCHAR(191)`
    ],

    // ── version 8 — indexes & constraints ─────────────────────────
    [
        `CREATE INDEX idx_sys_col_tbl ON sys_column(table_id)`,
        `CREATE INDEX idx_sys_join_tbl ON sys_join(table_id)`
    ],

    // ── version 9 — can_ocr capability flag on sys_user ───────────
    [
        `ALTER TABLE sys_user ADD COLUMN can_ocr TINYINT(1) DEFAULT 1`
    ],

    // ── version 10 — extensible misc_settings JSON column & sys_ auth metadata ─
    [
        `ALTER TABLE sys_user ADD COLUMN misc_settings LONGTEXT`,
        `ALTER TABLE sys_user_rights ADD COLUMN misc_settings LONGTEXT`,
        `ALTER TABLE sys_table ADD COLUMN misc_settings LONGTEXT`,

        `INSERT IGNORE INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, 'can_ocr', 'Can OCR', 'boolean', 0, 0, '1', 8, 1
         FROM sys_table t WHERE t.table_name = 'sys_user'`,

        `INSERT IGNORE INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, 'misc_settings', 'Misc Settings', 'json', 0, 0, NULL, 9, 1
         FROM sys_table t WHERE t.table_name = 'sys_user'`,

        `INSERT IGNORE INTO sys_table (table_name, label, description, is_system, active)
         VALUES ('sys_user_rights', 'User Table Rights', 'Per-table CRUD & row ownership rights', 1, 1)`,

        `INSERT IGNORE INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, '_id', 'ID', 'number', 0, 1, NULL, 0, 1 FROM sys_table t WHERE t.table_name = 'sys_user_rights'`,
        `INSERT IGNORE INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, 'user_id', 'User ID', 'number', 1, 0, NULL, 1, 1 FROM sys_table t WHERE t.table_name = 'sys_user_rights'`,
        `INSERT IGNORE INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, 'table_name', 'Table Name', 'string', 1, 0, NULL, 2, 1 FROM sys_table t WHERE t.table_name = 'sys_user_rights'`,
        `INSERT IGNORE INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, 'can_view', 'Can View', 'boolean', 0, 0, '1', 3, 1 FROM sys_table t WHERE t.table_name = 'sys_user_rights'`,
        `INSERT IGNORE INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, 'can_edit', 'Can Edit', 'boolean', 0, 0, '1', 4, 1 FROM sys_table t WHERE t.table_name = 'sys_user_rights'`,
        `INSERT IGNORE INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, 'can_delete', 'Can Delete', 'boolean', 0, 0, '1', 5, 1 FROM sys_table t WHERE t.table_name = 'sys_user_rights'`,
        `INSERT IGNORE INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, 'can_unmask', 'Can Unmask', 'boolean', 0, 0, '0', 6, 1 FROM sys_table t WHERE t.table_name = 'sys_user_rights'`,
        `INSERT IGNORE INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, 'misc_settings', 'Misc Settings', 'json', 0, 0, NULL, 7, 1 FROM sys_table t WHERE t.table_name = 'sys_user_rights'`,

        `INSERT IGNORE INTO sys_table (table_name, label, description, is_system, active)
         VALUES ('sys_column_security', 'Column Security', 'Hashed column unmask PINs', 1, 1)`,

        `INSERT IGNORE INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, '_id', 'ID', 'number', 0, 1, NULL, 0, 1 FROM sys_table t WHERE t.table_name = 'sys_column_security'`,
        `INSERT IGNORE INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, 'table_name', 'Table Name', 'string', 1, 0, NULL, 1, 1 FROM sys_table t WHERE t.table_name = 'sys_column_security'`,
        `INSERT IGNORE INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, 'column_name', 'Column Name', 'string', 1, 0, NULL, 2, 1 FROM sys_table t WHERE t.table_name = 'sys_column_security'`,
        `INSERT IGNORE INTO sys_column (table_id, column_name, label, col_type, is_required, is_pk, default_value, sort_order, active)
         SELECT t._id, 'secret_hash', 'Secret Hash', 'string', 1, 0, NULL, 3, 1 FROM sys_table t WHERE t.table_name = 'sys_column_security'`
    ]

];
