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
const { Sutram, SQLiteIntrospector } = require('../../packages/sutramcore');
const { SutramEngine, DatabaseAdopter, AuthManager } = require('../../packages/sutramEngine');
const { SutramExcel } = require('../../packages/sutramExcel');
const SessionManager = require('./SessionManager');

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
    this.sessionManager = new SessionManager(this.dataDir);

    // Initialize Master Registry DB (via Core ORM)
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
    this.masterDb.exec(`
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
        db_type        TEXT DEFAULT 'sqlite',
        db_config      TEXT,
        misc_settings  TEXT,
        created_at     TEXT DEFAULT (datetime('now', 'localtime')),
        updated_at     TEXT DEFAULT (datetime('now', 'localtime'))
      )
    `);

    // 2. Master Workspace Users
    this.masterDb.exec(`
      CREATE TABLE IF NOT EXISTS sys_master_user (
        _id          INTEGER PRIMARY KEY AUTOINCREMENT,
        username     TEXT NOT NULL UNIQUE,
        password     TEXT NOT NULL,
        display_name TEXT,
        role         TEXT NOT NULL DEFAULT 'superadmin' CHECK(role IN ('superadmin', 'admin', 'user')),
        active       INTEGER DEFAULT 1,
        can_create_project INTEGER DEFAULT 1,
        misc_settings TEXT,
        created_at   TEXT DEFAULT (datetime('now', 'localtime')),
        updated_at   TEXT DEFAULT (datetime('now', 'localtime'))
      )
    `);

    for (const sql of [
      `ALTER TABLE sys_master_user ADD COLUMN can_create_project INTEGER DEFAULT 1`,
      `ALTER TABLE sys_master_user ADD COLUMN misc_settings TEXT`,
      `ALTER TABLE sys_project ADD COLUMN db_type TEXT DEFAULT 'sqlite'`,
      `ALTER TABLE sys_project ADD COLUMN db_config TEXT`,
      `ALTER TABLE sys_project ADD COLUMN misc_settings TEXT`
    ]) {
      try { this.masterDb.exec(sql); } catch {}
    }

    // 3. User ↔ Project Access Control
    this.masterDb.exec(`
      CREATE TABLE IF NOT EXISTS sys_project_access (
        _id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id      INTEGER NOT NULL REFERENCES sys_master_user(_id) ON DELETE CASCADE,
        project_id   INTEGER NOT NULL REFERENCES sys_project(_id) ON DELETE CASCADE,
        access_role  TEXT NOT NULL DEFAULT 'owner' CHECK(access_role IN ('owner', 'member', 'viewer')),
        created_at   TEXT DEFAULT (datetime('now', 'localtime')),
        UNIQUE(user_id, project_id)
      )
    `);

    this.masterCore = new Sutram({
      db: this.masterDb,
      schema: {
        sys_project: {
          columns: {
            _id: { type: 'id', pk: true },
            project_name: { type: 'string', required: true },
            project_slug: { type: 'string', required: true },
            db_file: { type: 'string', required: true },
            db_path: { type: 'string', required: true },
            description: { type: 'string' },
            color: { type: 'string' },
            icon: { type: 'string' },
            owner_username: { type: 'string' },
            active: { type: 'number' },
            db_type: { type: 'string' },
            db_config: { type: 'string' },
            misc_settings: { type: 'string' },
            created_at: { type: 'string' },
            updated_at: { type: 'string' }
          }
        },
        sys_master_user: {
          columns: {
            _id: { type: 'id', pk: true },
            username: { type: 'string', required: true },
            password: { type: 'string', required: true },
            display_name: { type: 'string' },
            role: { type: 'string' },
            active: { type: 'number' },
            can_create_project: { type: 'number' },
            misc_settings: { type: 'string' },
            created_at: { type: 'string' },
            updated_at: { type: 'string' }
          }
        },
        sys_project_access: {
          columns: {
            _id: { type: 'id', pk: true },
            user_id: { type: 'number', required: true },
            project_id: { type: 'number', required: true },
            access_role: { type: 'string' },
            created_at: { type: 'string' }
          }
        }
      }
    });

    // Seed default master superadmin (hashed) if empty
    const userCount = this.masterCore.table('sys_master_user').count();
    if (userCount === 0) {
      this.masterCore.table('sys_master_user').insert({
        username: 'admin',
        password: AuthManager.hashPassword('sutram'),
        display_name: 'System Master Administrator',
        role: 'superadmin',
        can_create_project: 1,
        active: 1,
        misc_settings: AuthManager.stringifyMisc({ is_blank_password: false })
      }, false);
      console.log('⚡ [ProjectManager] Seeded default master administrator (admin / sutram)');
    }

    // 4. Auto-register existing legacy database if present and no projects exist
    const projectCount = this.masterCore.table('sys_project').count({ active: 1 });
    if (projectCount === 0 && fs.existsSync(this.legacyDbPath)) {
      try {
        const legacySlug = 'default_workspace';
        this.masterCore.upsert('sys_project', ['project_slug'], {
          project_name: 'Default Workspace (मुख्य कार्यक्षेत्र)',
          project_slug: legacySlug,
          db_file: path.basename(this.legacyDbPath),
          db_path: path.basename(this.legacyDbPath),
          description: 'Pre-existing default Sutram database workspace',
          color: '#6366f1',
          icon: 'pi pi-database',
          owner_username: 'admin',
          active: 1
        });

        const defaultProj = this.masterCore.table('sys_project').getOne({ project_slug: legacySlug }, { full: false });
        const adminUser = this.masterCore.table('sys_master_user').getOne({ username: 'admin' }, { full: false });
        if (defaultProj && adminUser) {
          this.masterCore.upsert('sys_project_access', ['user_id', 'project_id'], {
            user_id: adminUser._id,
            project_id: defaultProj._id,
            access_role: 'owner'
          });
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
      const u = this.masterCore.table('sys_master_user').getOne({ username, active: 1 }, { full: false });
      if (u && (u.role === 'superadmin' || u.username === 'admin')) {
        isSuperAdmin = true;
      }
    } else {
      isSuperAdmin = true; // default admin mode
    }

    if (isSuperAdmin) {
      rows = this.masterCore.query(`
        SELECT p.*,
          (SELECT COUNT(*) FROM sys_project_access WHERE project_id = p._id) as members_count
        FROM sys_project p
        WHERE p.active = 1
        ORDER BY p.updated_at DESC, p._id DESC
      `);
    } else {
      rows = this.masterCore.query(`
        SELECT p.*,
          pa.access_role,
          (SELECT COUNT(*) FROM sys_project_access WHERE project_id = p._id) as members_count
        FROM sys_project p
        JOIN sys_project_access pa ON pa.project_id = p._id
        JOIN sys_master_user u ON u._id = pa.user_id
        WHERE p.active = 1 AND u.username = ? AND u.active = 1
        ORDER BY p.updated_at DESC, p._id DESC
      `, [username]);
    }

    // Enrich each project with live stats and sanitized metadata (never expose db_config credentials)
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

            const cached = this.pool.get(p.project_slug);
            if (cached?.engine?._schema) {
              tablesCount = Object.keys(cached.engine._schema).filter(t => !t.startsWith('sys_') && !t.startsWith('xls_') && !t.startsWith('sqlite_')).length;
            } else {
              const quickDb = new Database(resolvedDbPath, { readonly: true });
              const quickCore = new Sutram({ db: quickDb, schema: {} });
              tablesCount = quickCore.listPhysicalTables().filter(t => !t.startsWith('sys_') && !t.startsWith('xls_') && !t.startsWith('sqlite_')).length;
              quickDb.close();
            }
          }
        } catch (e) {
          // Safe fallback
        }
      }

      const safeProj = this.sessionManager.sanitizeProjectForApi(p);
      return {
        ...safeProj,
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

    const project = this.masterCore.queryOne(`SELECT * FROM sys_project WHERE (project_slug = ? OR _id = ?) AND active = 1`, [cleanSlug, rawSlug]);
    if (!project) {
      return null;
    }

    const safeProject = this.sessionManager.sanitizeProjectForApi(project);

    // ── Handle MySQL Projects ─────────────────────────────────
    if (project.db_type === 'mysql') {
      const decryptedCfg = this.sessionManager.decryptSecret(project.db_config);
      const mysqlConfig = decryptedCfg ? JSON.parse(decryptedCfg) : {};
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
        project: safeProject,
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
      project: safeProject,
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
    while (this.masterCore.table('sys_project').getOne({ project_slug: candidateSlug }, { full: false })) {
      candidateSlug = `${slug}_${counter}`;
      counter++;
    }
    slug = candidateSlug;

    const cleanAdminUser = String(username || 'admin').trim();
    const cleanAdminPass = AuthManager.normalizePassword(password);
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

      adopterLogs.push(`[CONNECT] Connecting to MySQL database \`${targetDb}\` on ${targetHost}:${targetPort}...`);
      const sutram = new MySQLSutram({ host: targetHost, port: targetPort, user: targetUser, password: targetPass, database: targetDb, schema: {} });
      await sutram.connect();

      const introspected = await MySQLIntrospector.introspect(sutram.adapter, targetDb);
      const adopter = new DatabaseAdopter(sutram.adapter);
      await adopter.adoptAsync(introspected, {
        username: cleanAdminUser,
        password: cleanAdminPass,
        displayName: `${cleanName} Administrator`
      }, (step, msg) => {
        adopterLogs.push(`[${step}] ${msg}`);
      });

      const engine = await new SutramEngine({ sutram, mode: 'managed' }).init();
      const excel = await new SutramExcel(engine).init();
      await this._syncExcelRegistrations(engine, excel, true);

      const encryptedConfig = this.sessionManager.encryptSecret({
        host: targetHost,
        port: targetPort,
        user: targetUser,
        password: targetPass,
        database: targetDb
      });

      const projectId = this.masterCore.table('sys_project').insert({
        project_name: cleanName,
        project_slug: slug,
        db_file: targetDb,
        db_path: `mysql://${targetHost}:${targetPort}/${targetDb}`,
        description: description ? String(description).trim() : '',
        color: color || '#3b82f6',
        icon: icon || 'pi pi-server',
        owner_username: createdBy || 'admin',
        db_type: 'mysql',
        db_config: encryptedConfig,
        misc_settings: AuthManager.stringifyMisc({ created_mode: 'mysql' }),
        active: 1
      }, false);

      const masterUser = this.masterCore.table('sys_master_user').getOne({ username: createdBy || 'admin' }, { full: false });
      if (masterUser) {
        this.masterCore.upsert('sys_project_access', ['user_id', 'project_id'], {
          user_id: masterUser._id,
          project_id: projectId,
          access_role: 'owner'
        });
      }

      const rawProject = this.masterCore.table('sys_project').getById(projectId);
      const safeProject = this.sessionManager.sanitizeProjectForApi(rawProject);
      const instance = { project: safeProject, engine, excel, lastUsed: Date.now() };
      this.pool.set(slug, instance);

      adopterLogs.push(`[SUCCESS] MySQL Project "${cleanName}" (${targetDb}) successfully initialized.`);
      return {
        success: true,
        project: safeProject,
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

      try { fs.unlinkSync(tempDbFile); } catch (e) {}

      adopterLogs.push('[PRAGMA] Setting journal_mode = WAL, synchronous = NORMAL, foreign_keys = ON...');
      const targetDb = new Database(targetDbPath);
      targetDb.pragma('journal_mode = WAL');
      targetDb.pragma('foreign_keys = ON');
      targetDb.pragma('synchronous = NORMAL');
      targetDb.pragma('busy_timeout = 10000');

      const introspected = SQLiteIntrospector.introspect(targetDb);
      const adopter = new DatabaseAdopter(targetDb);
      adopter.adopt(introspected, {
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

    // 2. Configure In-Project Administrator in project's sys_user table (salted hash + blank password safe)
    await engine.upsert('sys_user', ['username'], {
      username: cleanAdminUser,
      password: AuthManager.hashPassword(cleanAdminPass),
      display_name: `${cleanName} Administrator`,
      role: 'admin',
      active: 1,
      can_ocr: 1,
      misc_settings: AuthManager.stringifyMisc({
        can_ocr: 1,
        is_blank_password: cleanAdminPass === ''
      })
    });
    adopterLogs.push(`[USER] Project administrator configured (${cleanAdminUser}).`);

    // 3. Register project in Master DB (using portable relative path)
    const portableDbPath = path.posix.join('projects', dbFilename);
    const projectId = this.masterCore.table('sys_project').insert({
      project_name: cleanName,
      project_slug: slug,
      db_file: dbFilename,
      db_path: portableDbPath,
      description: description ? String(description).trim() : '',
      color: color || '#10b981',
      icon: icon || 'pi pi-folder',
      owner_username: createdBy || 'admin',
      db_type: 'sqlite',
      misc_settings: AuthManager.stringifyMisc({ created_mode: dbSource || 'blank' }),
      active: 1
    }, false);

    // 4. Link Creator to Project Access in sys_project_access
    const masterUser = this.masterCore.table('sys_master_user').getOne({ username: createdBy || 'admin' }, { full: false });
    if (masterUser) {
      this.masterCore.upsert('sys_project_access', ['user_id', 'project_id'], {
        user_id: masterUser._id,
        project_id: projectId,
        access_role: 'owner'
      });
    }

    // 5. Instantiate SutramExcel strictly on top of SutramEngine
    adopterLogs.push('[EXCEL] Initializing SutramExcel dictionary & reference matcher...');
    const excel = await new SutramExcel(engine).init();
    await this._syncExcelRegistrations(engine, excel, true);

    const rawProject = this.masterCore.table('sys_project').getById(projectId);
    const safeProject = this.sessionManager.sanitizeProjectForApi(rawProject);

    const instance = {
      project: safeProject,
      engine,
      excel,
      lastUsed: Date.now()
    };

    this.pool.set(slug, instance);
    adopterLogs.push(`[SUCCESS] Project "${cleanName}" (${slug}) successfully initialized!`);

    console.log(`✓ [ProjectManager] Project "${cleanName}" (${slug}) successfully initialized.`);

    return {
      success: true,
      project: safeProject,
      logs: adopterLogs,
      message: `Project "${cleanName}" created and ready.`
    };
  }

  /**
   * Updates project metadata (display name, description, color, icon)
   */
  updateProject(slug, { name, description, color, icon }) {
    const existing = this.masterCore.table('sys_project').getOne({ project_slug: slug, active: 1 }, { full: false });
    if (!existing) {
      throw new Error(`Project "${slug}" not found`);
    }

    const updatedName = name ? String(name).trim() : existing.project_name;
    const updatedDesc = description !== undefined ? String(description).trim() : existing.description;
    const updatedColor = color || existing.color;
    const updatedIcon = icon || existing.icon;

    this.masterCore.run(`
      UPDATE sys_project
      SET project_name = ?, description = ?, color = ?, icon = ?, updated_at = datetime('now', 'localtime')
      WHERE _id = ?
    `, [updatedName, updatedDesc, updatedColor, updatedIcon, existing._id]);

    const updatedRaw = this.masterCore.table('sys_project').getById(existing._id);
    const safeUpdated = this.sessionManager.sanitizeProjectForApi(updatedRaw);
    if (this.pool.has(slug)) {
      this.pool.get(slug).project = safeUpdated;
    }

    return safeUpdated;
  }

  /**
   * Soft-deletes a project from active list, optionally running a zero-trace purge of Sutram metadata
   */
  async deleteProject(slug, purge = false) {
    const existing = this.masterCore.table('sys_project').getOne({ project_slug: slug }, { full: false });
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

    const cached = this.pool.get(slug);
    if (cached?.engine?.core && typeof cached.engine.core.close === 'function') {
      try { await cached.engine.core.close(); } catch {}
    }

    this.masterCore.run(`UPDATE sys_project SET active = 0, updated_at = datetime('now', 'localtime') WHERE _id = ?`, [existing._id]);
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
    const p = this.masterCore.queryOne(`SELECT project_slug FROM sys_project WHERE active = 1 ORDER BY _id ASC LIMIT 1`);
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

  _sanitizeMasterUser(u) {
    if (!u) return null;
    const misc = AuthManager.parseMisc(u.misc_settings);
    const isBlank = misc.is_blank_password !== undefined
      ? Boolean(misc.is_blank_password)
      : (String(u.password || '') === '' || AuthManager.verifyPassword('', u.password).valid);
    return {
      _id: u._id,
      username: u.username,
      display_name: u.display_name,
      role: u.role,
      can_create_project: u.can_create_project,
      active: u.active,
      is_blank_password: isBlank,
      misc_settings: misc,
      created_at: u.created_at,
      updated_at: u.updated_at
    };
  }

  getMasterUserById(userId) {
    const u = this.masterCore.table('sys_master_user').getOne({ _id: Number(userId), active: 1 }, { full: false });
    return this._sanitizeMasterUser(u);
  }

  getMasterUsers() {
    const rows = this.masterCore.table('sys_master_user').getAll({}, { full: false, orderBy: '_id ASC' });
    return (rows || []).map(u => this._sanitizeMasterUser(u));
  }

  getUserProjects(userId) {
    return this.masterCore.query(`
      SELECT p._id as project_id, p.project_name, p.project_slug, pa.access_role
      FROM sys_project_access pa
      JOIN sys_project p ON p._id = pa.project_id
      WHERE pa.user_id = ? AND p.active = 1
    `, [Number(userId)]);
  }

  userHasProjectAccess(userId, slug) {
    const u = this.getMasterUserById(userId);
    if (!u) return false;
    if (u.role === 'superadmin' || u.username === 'admin') return true;
    const hit = this.masterCore.queryOne(`
      SELECT pa._id FROM sys_project_access pa
      JOIN sys_project p ON p._id = pa.project_id
      WHERE pa.user_id = ? AND (p.project_slug = ? OR p._id = ?) AND p.active = 1
    `, [Number(userId), String(slug), slug]);
    return Boolean(hit);
  }

  createMasterUser({ username, password = '', display_name, role = 'user', can_create_project, misc_settings = {} }) {
    const cleanUser = String(username || '').trim();
    if (!cleanUser) {
      throw new Error('Username is required');
    }
    const cleanPass = AuthManager.normalizePassword(password);
    const hashed = AuthManager.hashPassword(cleanPass);
    const cleanRole = role === 'superadmin' ? 'superadmin' : (role === 'admin' ? 'admin' : 'user');
    let canCreate = 0;
    if (cleanRole === 'superadmin') {
      canCreate = 1;
    } else if (cleanRole === 'admin') {
      canCreate = can_create_project !== undefined ? (can_create_project ? 1 : 0) : 1;
    } else {
      canCreate = can_create_project ? 1 : 0;
    }

    const misc = {
      ...AuthManager.parseMisc(misc_settings),
      is_blank_password: cleanPass === ''
    };

    const newId = this.masterCore.table('sys_master_user').insert({
      username: cleanUser,
      password: hashed,
      display_name: display_name || cleanUser,
      role: cleanRole,
      can_create_project: canCreate,
      active: 1,
      misc_settings: AuthManager.stringifyMisc(misc)
    }, false);

    return this._sanitizeMasterUser(this.masterCore.table('sys_master_user').getById(newId));
  }

  updateMasterUser(userId, { display_name, role, can_create_project, active, password, misc_settings }) {
    const existing = this.masterCore.table('sys_master_user').getOne({ _id: Number(userId) }, { full: false });
    if (!existing) throw new Error('User not found');

    const newName = display_name !== undefined ? display_name : existing.display_name;
    const newRole = role !== undefined ? role : existing.role;
    let newCanCreate = existing.can_create_project;
    if (can_create_project !== undefined) {
      newCanCreate = can_create_project ? 1 : 0;
    }
    if (newRole === 'superadmin') newCanCreate = 1;

    const newActive = active !== undefined ? (active ? 1 : 0) : existing.active;
    const nextMisc = {
      ...AuthManager.parseMisc(existing.misc_settings),
      ...AuthManager.parseMisc(misc_settings)
    };

    let nextPassword = existing.password;
    if (password !== undefined && password !== null) {
      const cleanPass = AuthManager.normalizePassword(password);
      nextPassword = AuthManager.hashPassword(cleanPass);
      nextMisc.is_blank_password = cleanPass === '';
    }

    this.masterCore.run(`
      UPDATE sys_master_user
      SET display_name = ?, role = ?, can_create_project = ?, active = ?, password = ?, misc_settings = ?, updated_at = datetime('now', 'localtime')
      WHERE _id = ?
    `, [newName, newRole, newCanCreate, newActive, nextPassword, AuthManager.stringifyMisc(nextMisc), Number(userId)]);

    return this._sanitizeMasterUser(this.masterCore.table('sys_master_user').getById(Number(userId)));
  }

  getProjectAccess(projectId) {
    return this.masterCore.query(`
      SELECT pa._id as access_id, pa.access_role, pa.created_at,
             u._id as user_id, u.username, u.display_name, u.role as master_role
      FROM sys_project_access pa
      JOIN sys_master_user u ON u._id = pa.user_id
      WHERE pa.project_id = ?
      ORDER BY u.username ASC
    `, [Number(projectId)]);
  }

  grantProjectAccess(userId, projectId, accessRole = 'member') {
    this.masterCore.upsert('sys_project_access', ['user_id', 'project_id'], {
      user_id: Number(userId),
      project_id: Number(projectId),
      access_role: accessRole
    });
    return { success: true };
  }

  revokeProjectAccess(userId, projectId) {
    this.masterCore.run(`DELETE FROM sys_project_access WHERE user_id = ? AND project_id = ?`, [Number(userId), Number(projectId)]);
    return { success: true };
  }

  verifyMasterUser(username, password = '') {
    const cleanUser = String(username || '').trim();
    if (!cleanUser) return null;

    const rawUser = this.masterCore.table('sys_master_user').getOne({ username: cleanUser, active: 1 }, { full: false });
    if (!rawUser) return null;

    const cleanPass = AuthManager.normalizePassword(password);
    const check = AuthManager.verifyPassword(cleanPass, rawUser.password);
    if (!check.valid) return null;

    if (check.needsRehash) {
      try {
        const misc = {
          ...AuthManager.parseMisc(rawUser.misc_settings),
          is_blank_password: cleanPass === ''
        };
        this.masterCore.run(
          `UPDATE sys_master_user SET password = ?, misc_settings = ?, updated_at = datetime('now', 'localtime') WHERE _id = ?`,
          [AuthManager.hashPassword(cleanPass), AuthManager.stringifyMisc(misc), rawUser._id]
        );
        rawUser.misc_settings = AuthManager.stringifyMisc(misc);
      } catch {}
    }

    const safeUser = this._sanitizeMasterUser(rawUser);
    const token = this.sessionManager.issueMasterToken(safeUser);
    return { ...safeUser, token };
  }

  canUserCreateProject(username) {
    if (!username) return false;
    const u = this.masterCore.table('sys_master_user').getOne({ username: String(username).trim(), active: 1 }, { full: false });
    if (!u) return false;
    if (u.role === 'superadmin' || u.username === 'admin') return true;
    return u.can_create_project === 1;
  }
}

module.exports = ProjectManager;

