/**
 * ProjectManager.js
 * ─────────────────────────────────────────────────────────────
 * Multi-Project / Multi-Tenant Database & Workspace Engine.
 * 
 * • Master System Registry: Manages projects, master users, and access rights.
 * • Isolated Project Databases: Each project is an independent SQLite database.
 * • Dynamic SutramEngine & SutramExcel Pool: Instantiates and caches engines on-demand.
 * • Strict Separation: Master Workspace Users (who can see what project)
 *   vs In-Project Users (Authors & Admins inside each database).
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { SQLiteIntrospector } = require('../../packages/sutramcore');
const { SutramEngine, DatabaseAdopter } = require('../../packages/sutramEngine');
const { SutramExcel } = require('../../packages/sutramExcel');

class ProjectManager {
  constructor(config = {}) {
    this.dataDir = config.dataDir || process.env.SUTRAM_DATA_DIR || path.resolve(__dirname, '../../../SutramData');
    this.projectsDir = config.projectsDir || path.resolve(this.dataDir, 'projects');
    this.tempDir = config.tempDir || path.resolve(this.dataDir, 'temp_uploads');
    this.masterDbPath = config.masterDbPath || path.resolve(this.dataDir, 'sutram_master.db');
    this.legacyDbPath = config.dbPath || path.resolve(this.dataDir, 'sutram-erp.db');

    // Ensure directories exist
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
    if (!fs.existsSync(this.projectsDir)) {
      fs.mkdirSync(this.projectsDir, { recursive: true });
    }
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }

    // Dynamic pool of instantiated { project, engine, excel, lastUsed }
    this.pool = new Map();
    this._loadingPromises = new Map();
    this.activeProjectSlug = null;

    // Initialize Master Registry DB
    this._initMasterDb();
    this.activeProjectSlug = this.getDefaultProjectSlug();
  }

  /**
   * Initializes master database tables and seeds default master admin
   */
  _initMasterDb() {
    this.masterDb = new Database(this.masterDbPath);
    this.masterDb.pragma('journal_mode = WAL');
    this.masterDb.pragma('foreign_keys = ON');

    // 1. Projects Registry
    this.masterDb.prepare(`
      CREATE TABLE IF NOT EXISTS sys_project (
        _id            INTEGER PRIMARY KEY AUTOINCREMENT,
        project_name   TEXT NOT NULL,
        project_slug   TEXT NOT NULL UNIQUE,
        db_file        TEXT NOT NULL,
        db_path        TEXT NOT NULL,
        description    TEXT,
        color          TEXT DEFAULT '#10b981',
        icon           TEXT DEFAULT 'pi pi-folder',
        owner_username TEXT DEFAULT 'admin',
        active         INTEGER DEFAULT 1,
        created_at     TEXT DEFAULT (datetime('now', 'localtime')),
        updated_at     TEXT DEFAULT (datetime('now', 'localtime'))
      )
    `).run();

    // 2. Master Workspace Users (Who can log in to Sutram Workspace Hub)
    this.masterDb.prepare(`
      CREATE TABLE IF NOT EXISTS sys_master_user (
        _id          INTEGER PRIMARY KEY AUTOINCREMENT,
        username     TEXT NOT NULL UNIQUE,
        password     TEXT NOT NULL,
        display_name TEXT,
        role         TEXT NOT NULL DEFAULT 'superadmin' CHECK(role IN ('superadmin', 'admin', 'user')),
        active       INTEGER DEFAULT 1,
        can_create_project INTEGER DEFAULT 1,
        created_at   TEXT DEFAULT (datetime('now', 'localtime')),
        updated_at   TEXT DEFAULT (datetime('now', 'localtime'))
      )
    `).run();

    try {
      this.masterDb.prepare(`ALTER TABLE sys_master_user ADD COLUMN can_create_project INTEGER DEFAULT 1`).run();
    } catch (e) {}

    try {
      this.masterDb.prepare(`ALTER TABLE sys_project ADD COLUMN db_type TEXT DEFAULT 'sqlite'`).run();
    } catch (e) {}

    try {
      this.masterDb.prepare(`ALTER TABLE sys_project ADD COLUMN db_config TEXT`).run();
    } catch (e) {}

    // Seed default master superadmin if table is empty
    const userCount = this.masterDb.prepare(`SELECT COUNT(*) as count FROM sys_master_user`).get()?.count || 0;
    if (userCount === 0) {
      this.masterDb.prepare(`
        INSERT INTO sys_master_user (username, password, display_name, role)
        VALUES ('admin', 'sutram', 'System Master Administrator', 'superadmin')
      `).run();
      console.log('⚡ [ProjectManager] Seeded default master administrator (admin / sutram)');
    }

    // 3. User ↔ Project Access Control
    this.masterDb.prepare(`
      CREATE TABLE IF NOT EXISTS sys_project_access (
        _id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id      INTEGER NOT NULL REFERENCES sys_master_user(_id) ON DELETE CASCADE,
        project_id   INTEGER NOT NULL REFERENCES sys_project(_id) ON DELETE CASCADE,
        access_role  TEXT NOT NULL DEFAULT 'owner' CHECK(access_role IN ('owner', 'member', 'viewer')),
        created_at   TEXT DEFAULT (datetime('now', 'localtime')),
        UNIQUE(user_id, project_id)
      )
    `).run();

    // 4. Auto-register existing legacy database if present and no projects exist
    const projectCount = this.masterDb.prepare(`SELECT COUNT(*) as count FROM sys_project WHERE active = 1`).get()?.count || 0;
    if (projectCount === 0 && fs.existsSync(this.legacyDbPath)) {
      try {
        const legacySlug = 'default_workspace';
        this.masterDb.prepare(`
          INSERT OR IGNORE INTO sys_project (project_name, project_slug, db_file, db_path, description, color, icon, owner_username)
          VALUES ('Default Workspace (मुख्य कार्यक्षेत्र)', ?, ?, ?, 'Pre-existing default Sutram database workspace', '#6366f1', 'pi pi-database', 'admin')
        `).run(legacySlug, path.basename(this.legacyDbPath), path.basename(this.legacyDbPath));

        const defaultProj = this.masterDb.prepare(`SELECT _id FROM sys_project WHERE project_slug = ?`).get(legacySlug);
        const adminUser = this.masterDb.prepare(`SELECT _id FROM sys_master_user WHERE username = 'admin'`).get();
        if (defaultProj && adminUser) {
          this.masterDb.prepare(`
            INSERT OR IGNORE INTO sys_project_access (user_id, project_id, access_role)
            VALUES (?, ?, 'owner')
          `).run(adminUser._id, defaultProj._id);
        }
        console.log(`⚡ [ProjectManager] Auto-registered legacy database as project "${legacySlug}"`);
      } catch (err) {
        console.warn('⚠️ [ProjectManager] Failed to auto-register legacy DB:', err.message);
      }
    }
  }

  /**
   * Resolves a project's SQLite DB path portably across machines / pendrives.
   * Checks local projectsDir and dataDir first so moved folders never break.
   */
  resolveProjectDbPath(project) {
    if (!project) return '';
    const dbFile = project.db_file || (project.db_path ? path.basename(project.db_path) : '');

    // 1. Standard portable location: <SutramData>/projects/<db_file>
    if (dbFile) {
      const inProjects = path.resolve(this.projectsDir, dbFile);
      if (fs.existsSync(inProjects)) return inProjects;

      // 2. Root dataDir location (e.g. legacy sutram-erp.db)
      const inDataRoot = path.resolve(this.dataDir, dbFile);
      if (fs.existsSync(inDataRoot)) return inDataRoot;
    }

    // 3. Relative db_path resolved against dataDir
    if (project.db_path && !path.isAbsolute(project.db_path)) {
      const resolvedRel = path.resolve(this.dataDir, project.db_path);
      if (fs.existsSync(resolvedRel)) return resolvedRel;
    }

    // 4. Existing absolute path (for external user databases)
    if (project.db_path && path.isAbsolute(project.db_path) && fs.existsSync(project.db_path)) {
      return project.db_path;
    }

    // 5. Default fallback inside portable projectsDir
    return dbFile ? path.resolve(this.projectsDir, dbFile) : project.db_path;
  }

  /**
   * Helper to slugify project names (lowercase, space & symbols replaced by underscores)
   */
  static slugify(name) {
    if (!name) return `project_${Date.now()}`;
    return String(name)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || `project_${Date.now()}`;
  }

  /**
   * Auto-registers tables of an engine into SutramExcel
   */
  async _syncExcelRegistrations(engine, excel, forceReload = false) {
    const schema = engine._schema || {};
    const activeNames = new Set(
      Object.keys(schema).filter(t => !t.startsWith('sys_') && !t.startsWith('xls_') && !t.startsWith('sqlite_'))
    );

    // Prune dropped tables from Excel registry
    if (typeof excel.getRegisteredTables === 'function' && typeof excel.unregister === 'function') {
      for (const regName of excel.getRegisteredTables()) {
        if (!activeNames.has(regName)) {
          excel.unregister(regName);
        }
      }
    }

    let count = 0;
    for (const tableName of activeNames) {
      if (forceReload || !excel.getConfig(tableName)) {
        try {
          const tbl = engine.table(tableName);
          if (tbl) {
            const ui = (engine.ui && engine.ui.getTableSchema) ? await engine.ui.getTableSchema(tableName) : null;
            excel.register(tbl, ui?.display_name ? { display_name: ui.display_name } : {});
            count++;
          }
        } catch (err) {
          // Skip if already registered
        }
      }
    }
    return count;
  }

  /**
   * Returns list of projects accessible to a specific master user.
   * If user is superadmin or no username provided, returns all active projects.
   */
  listProjects(username = null) {
    let rows = [];
    let isSuperAdmin = false;

    if (username) {
      const u = this.masterDb.prepare(`SELECT * FROM sys_master_user WHERE username = ? AND active = 1`).get(username);
      if (u && (u.role === 'superadmin' || u.username === 'admin')) {
        isSuperAdmin = true;
      }
    } else {
      isSuperAdmin = true; // default admin mode
    }

    if (isSuperAdmin) {
      rows = this.masterDb.prepare(`
        SELECT p.*,
          (SELECT COUNT(*) FROM sys_project_access WHERE project_id = p._id) as members_count
        FROM sys_project p
        WHERE p.active = 1
        ORDER BY p.updated_at DESC, p._id DESC
      `).all();
    } else {
      rows = this.masterDb.prepare(`
        SELECT p.*,
          pa.access_role,
          (SELECT COUNT(*) FROM sys_project_access WHERE project_id = p._id) as members_count
        FROM sys_project p
        JOIN sys_project_access pa ON pa.project_id = p._id
        JOIN sys_master_user u ON u._id = pa.user_id
        WHERE p.active = 1 AND u.username = ? AND u.active = 1
        ORDER BY p.updated_at DESC, p._id DESC
      `).all(username);
    }

    // Enrich each project with live stats and table counts
    return rows.map(p => {
      let fileSize = 0;
      let tablesCount = 0;
      let isOnline = false;

      if (p.db_type === 'mysql') {
        isOnline = true;
        const cached = this.pool.get(p.project_slug);
        if (cached?.engine?._schema) {
          tablesCount = Object.keys(cached.engine._schema).filter(t => !t.startsWith('sys_') && !t.startsWith('xls_')).length;
        }
      } else {
        try {
          const resolvedDbPath = this.resolveProjectDbPath(p);
          if (resolvedDbPath && fs.existsSync(resolvedDbPath)) {
            const stats = fs.statSync(resolvedDbPath);
            fileSize = stats.size;
            isOnline = true;

            const quickDb = new Database(resolvedDbPath, { readonly: true });
            const res = quickDb.prepare(`
              SELECT COUNT(*) as count FROM sqlite_master
              WHERE type = 'table' AND name NOT LIKE 'sys_%' AND name NOT LIKE 'xls_%' AND name NOT LIKE 'sqlite_%'
            `).get();
            tablesCount = res?.count || 0;
            quickDb.close();
          }
        } catch (e) {
          // Safe fallback
        }
      }

      return {
        ...p,
        file_size: fileSize,
        tables_count: tablesCount,
        is_online: isOnline,
        is_cached: this.pool.has(p.project_slug)
      };
    });
  }

  /**
   * Retrieves or initializes a live { project, engine, excel } instance asynchronously.
   * Deduplicates concurrent connection/bootstrap calls via _loadingPromises.
   */
  async getProject(slug) {
    if (!slug) return null;
    const cleanSlug = ProjectManager.slugify(slug);

    // 1. Check in-memory pool
    if (this.pool.has(cleanSlug)) {
      const entry = this.pool.get(cleanSlug);
      entry.lastUsed = Date.now();
      return entry;
    }

    // 2. Deduplicate concurrent cold loads
    if (this._loadingPromises.has(cleanSlug)) {
      return await this._loadingPromises.get(cleanSlug);
    }

    const loadPromise = this._loadProjectInternal(cleanSlug, slug).finally(() => {
      this._loadingPromises.delete(cleanSlug);
    });
    this._loadingPromises.set(cleanSlug, loadPromise);
    return await loadPromise;
  }

  async _loadProjectInternal(cleanSlug, rawSlug) {
    // Re-check pool in case another promise just finished
    if (this.pool.has(cleanSlug)) {
      return this.pool.get(cleanSlug);
    }

    const project = this.masterDb.prepare(`SELECT * FROM sys_project WHERE (project_slug = ? OR _id = ?) AND active = 1`).get(cleanSlug, rawSlug);
    if (!project) {
      return null;
    }

    // ── Handle MySQL Projects ─────────────────────────────────
    if (project.db_type === 'mysql') {
      const mysqlConfig = project.db_config ? JSON.parse(project.db_config) : {};
      const { MySQLSutram, MySQLIntrospector } = require('../../packages/sutramcore-mysql');

      console.log(`⚡ [ProjectManager] Connecting to MySQL project "${project.project_name}" (${project.project_slug})...`);

      const targetDb = mysqlConfig.database || project.db_file;
      const sutram = new MySQLSutram({
        host: mysqlConfig.host || 'localhost',
        port: Number(mysqlConfig.port || 3306),
        user: mysqlConfig.user || 'root',
        password: mysqlConfig.password || '',
        database: targetDb,
        schema: {}
      });

      await sutram.connect();

      try {
        const introspected = await MySQLIntrospector.introspect(sutram.adapter, targetDb);
        const adopter = new DatabaseAdopter(sutram.adapter);
        await adopter.adoptAsync(introspected, {
          username: 'admin',
          displayName: `${project.project_name} Administrator`
        });
      } catch (err) {
        console.warn('⚠️ [ProjectManager] MySQL sync warning:', err.message);
      }

      const engine = await new SutramEngine({ sutram, mode: 'managed' }).init();
      const excel = await new SutramExcel(engine).init();
      await this._syncExcelRegistrations(engine, excel, true);

      const instance = {
        project,
        engine,
        excel,
        lastUsed: Date.now()
      };
      this.pool.set(project.project_slug, instance);
      return instance;
    }

    // ── Handle SQLite Projects ────────────────────────────────
    const resolvedDbPath = this.resolveProjectDbPath(project);
    const dbDir = path.dirname(resolvedDbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    console.log(`⚡ [ProjectManager] Loading project "${project.project_name}" (${project.project_slug})...`);

    const engine = await new SutramEngine({ dbPath: resolvedDbPath, mode: 'managed' }).init();

    // Synchronize any unregistered physical tables into sys_table
    try {
      const introspected = await engine.introspect();
      const adopter = new DatabaseAdopter(engine.db);
      const adoptRes = adopter.adopt(introspected, {
        username: 'admin',
        displayName: `${project.project_name} Administrator`
      });
      if (adoptRes.adoptedCount > 0) {
        console.log(`⚡ [ProjectManager] Auto-adopted ${adoptRes.adoptedCount} table(s) for "${project.project_name}"`);
        await engine.rebootstrap();
      }
    } catch (adoptErr) {
      console.warn('⚠️ [ProjectManager] Table sync warning:', adoptErr.message);
    }

    const excel = await new SutramExcel(engine).init();
    await this._syncExcelRegistrations(engine, excel, true);

    const instance = {
      project,
      engine,
      excel,
      lastUsed: Date.now()
    };

    this.pool.set(project.project_slug, instance);
    return instance;
  }

  /**
   * Pre-flight inspection of a candidate SQLite file before creating or adopting a project.
   */
  inspectCandidateDatabase(filePath) {
    if (!filePath || !fs.existsSync(filePath)) {
      throw new Error(`Database file not found: ${filePath}`);
    }

    const stats = fs.statSync(filePath);
    let quickDb = null;
    try {
      quickDb = new Database(filePath, { readonly: true });
      const report = SQLiteIntrospector.introspect(quickDb);
      quickDb.close();

      return {
        success: true,
        filePath,
        fileName: path.basename(filePath),
        fileSize: stats.size,
        isSutramDB: report.isSutram,
        engineVersion: report.engineVersion,
        tablesCount: report.tablesCount,
        tables: report.tables.map(t => ({
          name: t.tableName,
          rowCount: t.rowCount,
          columnsCount: t.columns.length,
          foreignKeysCount: t.foreignKeys.length
        }))
      };
    } catch (err) {
      if (quickDb) {
        try { quickDb.close(); } catch (e) {}
      }
      throw new Error(`Failed to introspect SQLite database: ${err.message}`);
    }
  }

  /**
   * Creates a brand new isolated project database, or adopts an uploaded SQLite database.
   * Configures initial project administrator and registers it in the master DB.
   */
  async createProject({
    name,
    description = '',
    password = '',
    username = 'admin',
    color = '#10b981',
    icon = 'pi pi-folder',
    createdBy = 'admin',
    dbSource = 'blank',
    tempDbFile = null,
    db_type = 'sqlite',
    mysql_config = null
  }) {
    if (!name || !String(name).trim()) {
      throw new Error('Project name is required');
    }

    const cleanName = String(name).trim();
    let slug = ProjectManager.slugify(cleanName);

    // Ensure slug uniqueness in sys_project
    let candidateSlug = slug;
    let counter = 1;
    while (this.masterDb.prepare(`SELECT 1 FROM sys_project WHERE project_slug = ?`).get(candidateSlug)) {
      candidateSlug = `${slug}_${counter}`;
      counter++;
    }
    slug = candidateSlug;

    const cleanAdminUser = String(username || 'admin').trim();
    const cleanAdminPass = password && String(password).trim() ? String(password).trim() : 'admin';
    let adopterLogs = [];

    // ── MySQL Project Creation / Adoption ──────────────────────
    if (db_type === 'mysql' || dbSource === 'mysql' || mysql_config) {
      const config = mysql_config || {};
      const { MySQLAdapter, MySQLIntrospector, MySQLSutram } = require('../../packages/sutramcore-mysql');

      const targetHost = config.host || 'localhost';
      const targetPort = Number(config.port || 3306);
      const targetUser = config.user || 'root';
      const targetPass = config.password || '';
      const targetDb = config.database || slug;

      // If requested to clone an existing database on MySQL server
      if (config.clone && config.clone_source_db) {
        const sourceDb = config.clone_source_db;
        adopterLogs.push(`[CLONE] Cloning MySQL database "${sourceDb}" into "${targetDb}"...`);
        try {
          const rootAdapter = new MySQLAdapter({ host: targetHost, port: targetPort, user: targetUser, password: targetPass, database: 'mysql' });
          await rootAdapter.connect();
          const cloneResult = await MySQLIntrospector.cloneDatabase(rootAdapter, sourceDb, targetDb);
          await rootAdapter.close();
          adopterLogs.push(`[CLONE] Successfully cloned ${cloneResult.clonedTables} table(s) into \`${targetDb}\`.`);
        } catch (cloneErr) {
          console.error('[ProjectManager] Clone DB error:', cloneErr.message);
          throw new Error(`Failed to clone database "${sourceDb}" to "${targetDb}": ${cloneErr.message}`);
        }
      } else if (config.create_if_missing) {
        try {
          const rootAdapter = new MySQLAdapter({ host: targetHost, port: targetPort, user: targetUser, password: targetPass, database: 'mysql' });
          await rootAdapter.connect();
          await rootAdapter.run(`CREATE DATABASE IF NOT EXISTS \`${targetDb}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
          await rootAdapter.close();
          adopterLogs.push(`[INIT] Verified/Created MySQL database: \`${targetDb}\``);
        } catch (createErr) {
          console.warn('[ProjectManager] Create DB notice:', createErr.message);
        }
      }

      // Connect to target database
      adopterLogs.push(`[CONNECT] Connecting to MySQL database \`${targetDb}\` on ${targetHost}:${targetPort}...`);
      const sutram = new MySQLSutram({ host: targetHost, port: targetPort, user: targetUser, password: targetPass, database: targetDb, schema: {} });
      await sutram.connect();

      // Introspect and Adopt
      const introspected = await MySQLIntrospector.introspect(sutram.adapter, targetDb);
      const adopter = new DatabaseAdopter(sutram.adapter);
      await adopter.adoptAsync(introspected, {
        username: cleanAdminUser,
        password: cleanAdminPass,
        displayName: `${cleanName} Administrator`
      }, (step, msg) => {
        adopterLogs.push(`[${step}] ${msg}`);
      });

      // Initialize Engine & Excel (Managed Mode, Uniform Async Contract)
      const engine = await new SutramEngine({ sutram, mode: 'managed' }).init();
      const excel = await new SutramExcel(engine).init();
      await this._syncExcelRegistrations(engine, excel, true);

      // Register in Master DB
      const serializedConfig = JSON.stringify({
        host: targetHost,
        port: targetPort,
        user: targetUser,
        password: targetPass,
        database: targetDb
      });

      const insertProj = this.masterDb.prepare(`
        INSERT INTO sys_project (
          project_name, project_slug, db_file, db_path, description, color, icon, owner_username, db_type, db_config, active
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'mysql', ?, 1)
      `).run(
        cleanName,
        slug,
        targetDb,
        `mysql://${targetHost}:${targetPort}/${targetDb}`,
        description ? String(description).trim() : '',
        color || '#3b82f6',
        icon || 'pi pi-server',
        createdBy || 'admin',
        serializedConfig
      );

      const projectId = insertProj.lastInsertRowid;
      const masterUser = this.masterDb.prepare(`SELECT _id FROM sys_master_user WHERE username = ?`).get(createdBy || 'admin');
      if (masterUser) {
        this.masterDb.prepare(`
          INSERT OR IGNORE INTO sys_project_access (user_id, project_id, access_role)
          VALUES (?, ?, 'owner')
        `).run(masterUser._id, projectId);
      }

      const newProject = this.masterDb.prepare(`SELECT * FROM sys_project WHERE _id = ?`).get(projectId);
      const instance = { project: newProject, engine, excel, lastUsed: Date.now() };
      this.pool.set(slug, instance);

      adopterLogs.push(`[SUCCESS] MySQL Project "${cleanName}" (${targetDb}) successfully initialized.`);
      return {
        success: true,
        project: newProject,
        logs: adopterLogs,
        message: `MySQL Project "${cleanName}" created and ready.`
      };
    }

    // ── SQLite Project Creation / Adoption ─────────────────────
    const dbFilename = `${slug}.db`;
    const targetDbPath = path.join(this.projectsDir, dbFilename);

    if (dbSource === 'upload' && tempDbFile) {
      if (!fs.existsSync(tempDbFile)) {
        throw new Error(`Uploaded database file missing at: ${tempDbFile}`);
      }

      adopterLogs.push(`[INIT] Copying uploaded database to workspace (${dbFilename})...`);
      fs.copyFileSync(tempDbFile, targetDbPath);

      // Clean up temp file
      try { fs.unlinkSync(tempDbFile); } catch (e) {}

      // Open target DB for optimization and adoption
      adopterLogs.push('[PRAGMA] Setting journal_mode = WAL, synchronous = NORMAL, foreign_keys = ON...');
      const targetDb = new Database(targetDbPath);
      targetDb.pragma('journal_mode = WAL');
      targetDb.pragma('foreign_keys = ON');
      targetDb.pragma('synchronous = NORMAL');
      targetDb.pragma('busy_timeout = 10000');

      const introspected = SQLiteIntrospector.introspect(targetDb);
      const adopter = new DatabaseAdopter(targetDb);
      const adoptRes = adopter.adopt(introspected, {
        username: cleanAdminUser,
        password: cleanAdminPass,
        displayName: `${cleanName} Administrator`
      }, (step, msg) => {
        adopterLogs.push(`[${step}] ${msg}`);
      });

      targetDb.close();
    } else {
      adopterLogs.push(`[INIT] Creating blank SQLite database: ${dbFilename}...`);
    }

    // 1. Initialize engine instance (runs SysMigrator and loads schema)
    const engine = await new SutramEngine({ dbPath: targetDbPath, mode: 'managed' }).init();

    // 2. Configure In-Project Administrator in project's sys_user table
    await engine.upsert('sys_user', ['username'], {
      username: cleanAdminUser,
      password: cleanAdminPass,
      display_name: `${cleanName} Administrator`,
      role: 'admin',
      active: 1
    });
    adopterLogs.push(`[USER] Project administrator configured (${cleanAdminUser}).`);

    // 3. Register project in Master DB (using portable relative path)
    const portableDbPath = path.posix.join('projects', dbFilename);
    const insertProj = this.masterDb.prepare(`
      INSERT INTO sys_project (
        project_name, project_slug, db_file, db_path, description, color, icon, owner_username, active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      cleanName,
      slug,
      dbFilename,
      portableDbPath,
      description ? String(description).trim() : '',
      color || '#10b981',
      icon || 'pi pi-folder',
      createdBy || 'admin'
    );

    const projectId = insertProj.lastInsertRowid;

    // 4. Link Creator to Project Access in sys_project_access
    const masterUser = this.masterDb.prepare(`SELECT _id FROM sys_master_user WHERE username = ?`).get(createdBy || 'admin');
    if (masterUser) {
      this.masterDb.prepare(`
        INSERT OR IGNORE INTO sys_project_access (user_id, project_id, access_role)
        VALUES (?, ?, 'owner')
      `).run(masterUser._id, projectId);
    }

    // 5. Instantiate SutramExcel strictly on top of SutramEngine
    adopterLogs.push('[EXCEL] Initializing SutramExcel dictionary & reference matcher...');
    const excel = await new SutramExcel(engine).init();
    await this._syncExcelRegistrations(engine, excel, true);

    const newProject = this.masterDb.prepare(`SELECT * FROM sys_project WHERE _id = ?`).get(projectId);

    const instance = {
      project: newProject,
      engine,
      excel,
      lastUsed: Date.now()
    };

    this.pool.set(slug, instance);
    adopterLogs.push(`[SUCCESS] Project "${cleanName}" (${slug}) successfully initialized!`);

    console.log(`✓ [ProjectManager] Project "${cleanName}" (${slug}) successfully initialized.`);

    return {
      success: true,
      project: newProject,
      logs: adopterLogs,
      message: `Project "${cleanName}" created and ready.`
    };
  }

  /**
   * Updates project metadata (display name, description, color, icon)
   */
  updateProject(slug, { name, description, color, icon }) {
    const existing = this.masterDb.prepare(`SELECT * FROM sys_project WHERE project_slug = ? AND active = 1`).get(slug);
    if (!existing) {
      throw new Error(`Project "${slug}" not found`);
    }

    const updatedName = name ? String(name).trim() : existing.project_name;
    const updatedDesc = description !== undefined ? String(description).trim() : existing.description;
    const updatedColor = color || existing.color;
    const updatedIcon = icon || existing.icon;

    this.masterDb.prepare(`
      UPDATE sys_project
      SET project_name = ?, description = ?, color = ?, icon = ?, updated_at = datetime('now', 'localtime')
      WHERE _id = ?
    `).run(updatedName, updatedDesc, updatedColor, updatedIcon, existing._id);

    if (this.pool.has(slug)) {
      this.pool.get(slug).project = this.masterDb.prepare(`SELECT * FROM sys_project WHERE _id = ?`).get(existing._id);
    }

    return this.masterDb.prepare(`SELECT * FROM sys_project WHERE _id = ?`).get(existing._id);
  }

  /**
   * Soft-deletes a project from active list, optionally running a zero-trace purge of Sutram metadata
   */
  async deleteProject(slug, purge = false) {
    const existing = this.masterDb.prepare(`SELECT * FROM sys_project WHERE project_slug = ?`).get(slug);
    if (!existing) {
      throw new Error(`Project "${slug}" not found`);
    }

    let purgedCount = 0;
    if (purge) {
      try {
        const instance = await this.getProject(slug);
        if (instance?.engine && typeof instance.engine.purgeSutram === 'function') {
          const res = await instance.engine.purgeSutram();
          purgedCount = res?.purgedCount || 0;
        }
      } catch (purgeErr) {
        console.warn(`⚠️ [ProjectManager] Error during purge for "${slug}":`, purgeErr.message);
      }
    }

    // Close active engine core connection if pooled
    const cached = this.pool.get(slug);
    if (cached?.engine?.core && typeof cached.engine.core.close === 'function') {
      try { await cached.engine.core.close(); } catch {}
    }

    this.masterDb.prepare(`UPDATE sys_project SET active = 0, updated_at = datetime('now', 'localtime') WHERE _id = ?`).run(existing._id);
    this.pool.delete(slug);

    return {
      success: true,
      purged: purge,
      purgedCount,
      message: purge
        ? `Project "${existing.project_name}" deleted and ${purgedCount} Sutram metadata tables cleanly purged from database.`
        : `Project "${existing.project_name}" archived.`
    };
  }

  /**
   * Returns default project slug (first active project or legacy)
   */
  getDefaultProjectSlug() {
    const p = this.masterDb.prepare(`SELECT project_slug FROM sys_project WHERE active = 1 ORDER BY _id ASC LIMIT 1`).get();
    return p?.project_slug || null;
  }

  /**
   * Sets active project database connection
   */
  async setActiveProject(slug) {
    if (!slug) return null;
    const project = await this.getProject(slug);
    if (!project) {
      throw new Error(`Project "${slug}" not found`);
    }
    this.activeProjectSlug = project.project.project_slug;
    console.log(`⚡ [ProjectManager] Active project database switched to: "${project.project.project_name}" (${this.activeProjectSlug})`);
    return project;
  }

  /**
   * Returns current active project instance
   */
  async getActiveProject() {
    const slug = this.activeProjectSlug || this.getDefaultProjectSlug();
    return await this.getProject(slug);
  }

  // ─────────────────────────────────────────────────────────────
  // Master Workspace Users & Access Control
  // ─────────────────────────────────────────────────────────────

  getMasterUsers() {
    return this.masterDb.prepare(`
      SELECT _id, username, display_name, role, can_create_project, active, created_at, updated_at
      FROM sys_master_user
      ORDER BY _id ASC
    `).all();
  }

  getUserProjects(userId) {
    return this.masterDb.prepare(`
      SELECT p._id as project_id, p.project_name, p.project_slug, pa.access_role
      FROM sys_project_access pa
      JOIN sys_project p ON p._id = pa.project_id
      WHERE pa.user_id = ? AND p.active = 1
    `).all(userId);
  }

  createMasterUser({ username, password, display_name, role = 'user', can_create_project }) {
    if (!username || !password) {
      throw new Error('Username and password are required');
    }
    const cleanUser = String(username).trim();
    const cleanPass = String(password).trim();
    const cleanRole = role === 'superadmin' ? 'superadmin' : (role === 'admin' ? 'admin' : 'user');
    let canCreate = 0;
    if (cleanRole === 'superadmin') {
      canCreate = 1;
    } else if (cleanRole === 'admin') {
      canCreate = can_create_project !== undefined ? (can_create_project ? 1 : 0) : 1;
    } else {
      canCreate = can_create_project ? 1 : 0;
    }

    const info = this.masterDb.prepare(`
      INSERT INTO sys_master_user (username, password, display_name, role, can_create_project, active)
      VALUES (?, ?, ?, ?, ?, 1)
    `).run(cleanUser, cleanPass, display_name || cleanUser, cleanRole, canCreate);

    return this.masterDb.prepare(`SELECT _id, username, display_name, role, can_create_project, active, created_at FROM sys_master_user WHERE _id = ?`).get(info.lastInsertRowid);
  }

  updateMasterUser(userId, { display_name, role, can_create_project, active, password }) {
    const existing = this.masterDb.prepare(`SELECT * FROM sys_master_user WHERE _id = ?`).get(userId);
    if (!existing) throw new Error('User not found');

    const newName = display_name !== undefined ? display_name : existing.display_name;
    const newRole = role !== undefined ? role : existing.role;
    let newCanCreate = existing.can_create_project;
    if (can_create_project !== undefined) {
      newCanCreate = can_create_project ? 1 : 0;
    }
    if (newRole === 'superadmin') newCanCreate = 1;

    const newActive = active !== undefined ? (active ? 1 : 0) : existing.active;

    if (password && String(password).trim()) {
      this.masterDb.prepare(`
        UPDATE sys_master_user
        SET display_name = ?, role = ?, can_create_project = ?, active = ?, password = ?, updated_at = datetime('now', 'localtime')
        WHERE _id = ?
      `).run(newName, newRole, newCanCreate, newActive, String(password).trim(), userId);
    } else {
      this.masterDb.prepare(`
        UPDATE sys_master_user
        SET display_name = ?, role = ?, can_create_project = ?, active = ?, updated_at = datetime('now', 'localtime')
        WHERE _id = ?
      `).run(newName, newRole, newCanCreate, newActive, userId);
    }

    return this.masterDb.prepare(`SELECT _id, username, display_name, role, can_create_project, active, updated_at FROM sys_master_user WHERE _id = ?`).get(userId);
  }

  getProjectAccess(projectId) {
    return this.masterDb.prepare(`
      SELECT pa._id as access_id, pa.access_role, pa.created_at,
             u._id as user_id, u.username, u.display_name, u.role as master_role
      FROM sys_project_access pa
      JOIN sys_master_user u ON u._id = pa.user_id
      WHERE pa.project_id = ?
      ORDER BY u.username ASC
    `).all(projectId);
  }

  grantProjectAccess(userId, projectId, accessRole = 'member') {
    this.masterDb.prepare(`
      INSERT INTO sys_project_access (user_id, project_id, access_role)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id, project_id) DO UPDATE SET access_role = excluded.access_role
    `).run(userId, projectId, accessRole);
    return { success: true };
  }

  revokeProjectAccess(userId, projectId) {
    this.masterDb.prepare(`
      DELETE FROM sys_project_access WHERE user_id = ? AND project_id = ?
    `).run(userId, projectId);
    return { success: true };
  }

  verifyMasterUser(username, password) {
    const user = this.masterDb.prepare(`
      SELECT _id, username, display_name, role, can_create_project, active, created_at
      FROM sys_master_user
      WHERE username = ? AND password = ? AND active = 1
    `).get(username, password);
    if (!user) return null;
    const token = Buffer.from(`${user.username}:${Date.now()}:${user._id}`).toString('base64');
    return { ...user, token };
  }

  canUserCreateProject(username) {
    if (!username) return false;
    const u = this.masterDb.prepare(`SELECT * FROM sys_master_user WHERE username = ? AND active = 1`).get(username);
    if (!u) return false;
    if (u.role === 'superadmin' || u.username === 'admin') return true;
    return u.can_create_project === 1;
  }
}

module.exports = ProjectManager;

