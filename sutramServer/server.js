/**
 * server.js
 * ─────────────────────────────────────────────────────────────
 * Sutram Standalone Schema-Oriented Universal ERP Engine Server.
 * 
 * • Multi-Project / Multi-Tenant Database & Workspace Engine.
 * • Master System Registry: Projects, Master Users & Access Control.
 * • Pure Schema-Oriented: All tables, constraints, and UI schemas
 *   reside dynamically in isolated database system tables.
 * • Autonomous Table Creation & Live Introspection.
 * • Integrated Sutram Excel Studio UI & Ingestion Pipeline.
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const config = require('./config/server.config');
const { SchemaHeuristics } = require('../packages/sutramEngine');
const ProjectManager = require('./src/ProjectManager');

// 1. Initialize Multi-Project Manager (External SutramData directory outside code folder)
console.log(`⚡ [sutramServer] Initializing Sutram Multi-Project Manager (Data Dir: ${config.dataDir})...`);
const projectManager = new ProjectManager({
  dataDir: config.dataDir,
  projectsDir: path.resolve(config.dataDir, 'projects'),
  masterDbPath: path.resolve(config.dataDir, 'sutram_master.db'),
  dbPath: config.dbPath
});

// Helper to resolve active project instance from request query, headers, or server active project
async function getActiveProject(req) {
  const slug = req?.query?.project
    || req?.headers?.['x-project-slug']
    || req?.headers?.['x-project-id']
    || projectManager.activeProjectSlug
    || projectManager.getDefaultProjectSlug();
  const instance = await projectManager.getProject(slug);
  if (!instance) {
    throw new Error(`Project "${slug || 'default'}" not found`);
  }
  if (instance.project?.project_slug && projectManager.activeProjectSlug !== instance.project.project_slug) {
    projectManager.activeProjectSlug = instance.project.project_slug;
  }
  return instance;
}

function nowTimestampStr() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// 2. Create Express Application
const app = express();
app.use(cors(config.cors));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// 2A. Serve Sutram UI Static Assets (Portable Single-Port & LAN Web Access)
const primaryDistPath = path.resolve(__dirname, '../dist');
const legacyDistPath = path.resolve(__dirname, '../sutramUI/dist');
const uiDistPath = fs.existsSync(primaryDistPath) ? primaryDistPath : legacyDistPath;
if (fs.existsSync(uiDistPath)) {
  app.use(express.static(uiDistPath));
}

// ─────────────────────────────────────────────────────────────
// 3. Master Workspace & Project Management REST APIs
// ─────────────────────────────────────────────────────────────
const masterRouter = express.Router();

/**
 * GET /api/_sutram/master/projects
 * List all projects accessible to the specified master user (or all if admin)
 */
masterRouter.get('/projects', (req, res) => {
  try {
    const username = req.query.username || null;
    const projects = projectManager.listProjects(username);
    res.json({ success: true, count: projects.length, result: projects });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

const multer = require('multer');

const tempUpload = multer({
  dest: projectManager.tempDir,
  limits: { fileSize: 500 * 1024 * 1024 } // 500 MB limit
});

/**
 * POST /api/_sutram/master/projects/upload-db-temp
 * Uploads a temporary SQLite file and runs instant pre-flight inspection
 */
masterRouter.post('/projects/upload-db-temp', tempUpload.single('dbFile'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No database file provided.' });
    }

    const tempFilePath = req.file.path;
    const originalName = req.file.originalname || 'database.db';
    const inspection = projectManager.inspectCandidateDatabase(tempFilePath);

    res.json({
      success: true,
      tempFileKey: req.file.filename,
      originalName,
      inspection
    });
  } catch (err) {
    if (req.file?.path && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
    }
    res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/_sutram/master/projects/inspect-db
 * Runs pre-flight inspection on a given path or temp file
 */
masterRouter.post('/projects/inspect-db', (req, res) => {
  try {
    const { tempFileKey, filePath } = req.body;
    const targetPath = tempFileKey
      ? path.resolve(projectManager.tempDir, tempFileKey)
      : filePath;

    const report = projectManager.inspectCandidateDatabase(targetPath);
    res.json({ success: true, inspection: report });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/_sutram/master/projects
 * Creates a brand new isolated project database or adopts an uploaded SQLite database
 */
masterRouter.post('/projects', async (req, res) => {
  try {
    const requestingUser = req.headers['x-master-user'] || req.body.createdBy;
    if (!requestingUser) {
      return res.status(401).json({
        success: false,
        error: 'लॉगिन आवश्यक है (Authentication required: x-master-user header or createdBy missing)'
      });
    }
    if (!projectManager.canUserCreateProject(requestingUser)) {
      return res.status(403).json({
        success: false,
        error: `यूज़र "${requestingUser}" को नया प्रोजेक्ट बनाने की अनुमति नहीं है (Permission Denied: User cannot create projects)`
      });
    }

    const { name, description, password, username, color, icon, dbSource, tempFileKey, db_type, mysql_config } = req.body;
    let tempDbFile = null;
    if (tempFileKey) {
      tempDbFile = path.resolve(projectManager.tempDir, tempFileKey);
    }

    const result = await projectManager.createProject({
      name,
      description,
      password: password || '',
      username: username || 'admin',
      color: color || '#10b981',
      icon: icon || 'pi pi-folder',
      createdBy: requestingUser,
      dbSource: dbSource || 'blank',
      tempDbFile,
      db_type: db_type || (dbSource === 'mysql' ? 'mysql' : 'sqlite'),
      mysql_config
    });

    res.json({
      success: true,
      message: result.message,
      result: result.project,
      logs: result.logs || []
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/_sutram/master/projects/mysql/databases
 * Auto-discovers available user databases on MySQL server
 */
masterRouter.post('/projects/mysql/databases', async (req, res) => {
  try {
    const { MySQLIntrospector } = require('../packages/sutramcore-mysql');
    const { host, port, user, password } = req.body;
    const databases = await MySQLIntrospector.listDatabases({ host, port, user, password });
    res.json({ success: true, count: databases.length, result: databases });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/_sutram/master/projects/mysql/inspect
 * Pre-flight schema inspection for a candidate MySQL database
 */
masterRouter.post('/projects/mysql/inspect', async (req, res) => {
  try {
    const { MySQLAdapter, MySQLIntrospector } = require('../packages/sutramcore-mysql');
    const { host, port, user, password, database } = req.body;
    const adapter = new MySQLAdapter({ host, port, user, password, database });
    await adapter.connect();
    try {
      const report = await MySQLIntrospector.introspect(adapter, database);
      res.json({ success: true, result: report });
    } finally {
      await adapter.close();
    }
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/_sutram/master/projects/:slug
 * Retrieves project details
 */
masterRouter.get('/projects/:slug', async (req, res) => {
  try {
    const instance = await projectManager.getProject(req.params.slug);
    if (!instance) {
      return res.status(404).json({ success: false, error: `Project "${req.params.slug}" not found` });
    }
    res.json({ success: true, result: instance.project });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * PUT /api/_sutram/master/projects/:slug
 * Updates project metadata (name, description, color, icon)
 */
masterRouter.put('/projects/:slug', (req, res) => {
  try {
    const updated = projectManager.updateProject(req.params.slug, req.body);
    res.json({ success: true, message: 'Project updated successfully', result: updated });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * DELETE /api/_sutram/master/projects/:slug
 * Archives / soft-deletes a project with optional zero-trace database purge
 */
masterRouter.delete('/projects/:slug', async (req, res) => {
  try {
    const purge = req.query.purge === 'true' || req.body?.purge === true;
    const result = await projectManager.deleteProject(req.params.slug, purge);
    res.json(result);
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/_sutram/master/projects/switch/:slug
 * Instantly switches server active database connection to this project
 */
masterRouter.post('/projects/switch/:slug', async (req, res) => {
  try {
    const instance = await projectManager.setActiveProject(req.params.slug);
    res.json({
      success: true,
      message: `Active project connection switched to "${instance.project.project_name}" (${instance.project.project_slug})`,
      activeProject: instance.project
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/_sutram/master/projects/active
 * Returns current active project info
 */
masterRouter.get('/projects/active', async (req, res) => {
  try {
    const instance = await projectManager.getActiveProject();
    res.json({
      success: true,
      activeProject: instance.project
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/_sutram/master/users
 * Returns list of master workspace users
 */
masterRouter.get('/users', (req, res) => {
  try {
    const users = projectManager.getMasterUsers();
    res.json({ success: true, count: users.length, result: users });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/_sutram/master/users/:userId/projects
 * Returns list of projects accessible to a specific master user
 */
masterRouter.get('/users/:userId/projects', (req, res) => {
  try {
    const access = projectManager.getUserProjects(req.params.userId);
    res.json({ success: true, count: access.length, result: access });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/_sutram/master/users
 * Creates a new master workspace user
 */
masterRouter.post('/users', (req, res) => {
  try {
    const user = projectManager.createMasterUser(req.body);
    res.json({ success: true, message: `Master user "${user.username}" created`, result: user });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * PUT /api/_sutram/master/users/:userId
 * Updates master user profile, role, or permissions
 */
masterRouter.put('/users/:userId', (req, res) => {
  try {
    const updated = projectManager.updateMasterUser(req.params.userId, req.body);
    res.json({ success: true, message: 'User updated successfully', result: updated });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/_sutram/master/login
 * Validates master user credentials for Workspace Hub
 */
masterRouter.post('/login', (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'यूज़रनेम और पासवर्ड आवश्यक हैं (Username and password are required)' });
    }
    const user = projectManager.verifyMasterUser(username, password);
    if (!user) {
      return res.status(401).json({ success: false, error: 'अमान्य यूज़रनेम या पासवर्ड (Invalid username or password)' });
    }
    res.json({ success: true, message: 'लॉगिन सफल (Login successful)', result: user });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/_sutram/master/projects/:slug/access
 * Returns users with access to a project
 */
masterRouter.get('/projects/:slug/access', async (req, res) => {
  try {
    const instance = await projectManager.getProject(req.params.slug);
    if (!instance) return res.status(404).json({ success: false, error: 'Project not found' });
    const members = projectManager.getProjectAccess(instance.project._id);
    res.json({ success: true, count: members.length, result: members });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/_sutram/master/projects/:slug/access
 * Grants project access to a master user
 */
masterRouter.post('/projects/:slug/access', async (req, res) => {
  try {
    const instance = await projectManager.getProject(req.params.slug);
    if (!instance) return res.status(404).json({ success: false, error: 'Project not found' });
    const { userId, accessRole } = req.body;
    projectManager.grantProjectAccess(userId, instance.project._id, accessRole || 'member');
    res.json({ success: true, message: 'Access granted successfully' });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * DELETE /api/_sutram/master/projects/:slug/access/:userId
 * Revokes project access from a master user
 */
masterRouter.delete('/projects/:slug/access/:userId', async (req, res) => {
  try {
    const instance = await projectManager.getProject(req.params.slug);
    if (!instance) return res.status(404).json({ success: false, error: 'Project not found' });
    projectManager.revokeProjectAccess(req.params.userId, instance.project._id);
    res.json({ success: true, message: 'Access revoked successfully' });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Mount masterRouter
app.use('/api/_sutram/master', masterRouter);
app.use('/_sutram/master', masterRouter);

// ─────────────────────────────────────────────────────────────
// 4. Project-Scoped Dynamic Schema DDL REST APIs
// ─────────────────────────────────────────────────────────────
const schemaRouter = express.Router();
const authRouter = express.Router();

/**
 * POST /api/_sutram/schema/create-table
 * Dynamically creates a table in the active project database and updates sys_ tables
 */
schemaRouter.post('/create-table', async (req, res) => {
  try {
    const activeProjectInfo = await getActiveProject(req);
    const { engine, excel } = activeProjectInfo;
    const { table_name, label, description, columns, joins } = req.body;
    if (!table_name) {
      return res.status(400).json({ success: false, error: 'table_name is required' });
    }
    if (!Array.isArray(columns) || columns.length === 0) {
      return res.status(400).json({ success: false, error: 'At least one column is required' });
    }

    const projectName = engine.dbName || activeProjectInfo.project?.project_name || req.activeProjectSlug || 'active';
    console.log(`[sutramServer] Creating dynamic table "${table_name}" in project "${projectName}"...`);
    await engine.schema.createTable({ table_name, label, description, columns, joins });

    // Auto-set UI metadata if label provided
    if (label) {
      try {
        await engine.ui.setTableUi(table_name, { display_name: label, icon: 'pi pi-table' });
      } catch (e) {
        console.warn('[sutramServer] Notice: UiManager setTableUi warning:', e.message);
      }
    }

    // Auto-register the newly created table in Excel Studio with fresh schema derivation
    await projectManager._syncExcelRegistrations(engine, excel, true);

    res.json({
      success: true,
      message: `Table "${table_name}" created and registered successfully.`,
      result: {
        table_name,
        label: label || table_name,
        columnsCount: columns.length
      }
    });
  } catch (err) {
    console.error('[sutramServer] create-table error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/_sutram/schema/table-detail/:tableName
 * Returns full table schema, columns, row count, and incoming FK references for Edit/Delete
 */
schemaRouter.get('/table-detail/:tableName', async (req, res) => {
  try {
    const { engine } = await getActiveProject(req);
    const tableName = req.params.tableName;
    const detail = await engine.schema.getTableDetail(tableName);
    const impact = await engine.schema.getTableImpact(tableName);
    const ui = (engine.ui && engine.ui.getTableSchema) ? await engine.ui.getTableSchema(tableName) : null;

    // Enrich columns cleanly via Core inspectTable (SQLite PRAGMA / MySQL information_schema)
    const inspected = await engine.inspectTable(tableName);
    const physMap = new Map((inspected.columns || []).map(p => [p.name, p]));
    const uniqueCols = new Set();
    const indexedCols = new Set();
    for (const idx of (inspected.indexes || [])) {
      for (const colName of (idx.columns || [])) {
        indexedCols.add(colName);
        if (idx.unique) uniqueCols.add(colName);
      }
    }

    const enrichedColumns = (detail.columns || []).map(c => {
      const pInfo = physMap.get(c.column_name);
      let refSelect = [];
      if (c.ref_select) {
        try {
          const parsed = JSON.parse(c.ref_select);
          refSelect = Array.isArray(parsed) ? parsed : [String(parsed)];
        } catch {
          refSelect = String(c.ref_select).split(',').map(s => s.trim()).filter(Boolean);
        }
      }
      return {
        ...c,
        sql_type: pInfo?.type || '',
        is_unique: uniqueCols.has(c.column_name) ? 1 : 0,
        has_index: indexedCols.has(c.column_name) ? 1 : 0,
        ref_select: refSelect
      };
    });

    res.json({
      success: true,
      result: {
        ...detail,
        display_name: ui?.display_name || detail.label || tableName,
        columns: enrichedColumns,
        rowCount: impact.rowCount,
        referencingTables: impact.referencingTables
      }
    });
  } catch (err) {
    console.error('[sutramServer] table-detail error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * PUT /api/_sutram/schema/tables/:tableName
 * Updates an existing table using Core physical DDL
 */
schemaRouter.put('/tables/:tableName', async (req, res) => {
  try {
    const { engine, excel } = await getActiveProject(req);
    const tableName = req.params.tableName;
    const { label, description, columns } = req.body;

    console.log(`[sutramServer] Updating table "${tableName}"...`);
    const result = await engine.schema.updateTable(tableName, { label, description, columns });

    if (label) {
      try {
        await engine.ui.setTableUi(tableName, { display_name: label, icon: 'pi pi-table' });
      } catch (e) {
        console.warn('[sutramServer] Notice: UiManager setTableUi warning:', e.message);
      }
    }

    await projectManager._syncExcelRegistrations(engine, excel, true);

    res.json({
      success: true,
      message: `Table "${tableName}" updated successfully (${result.strategy}).`,
      result
    });
  } catch (err) {
    console.error('[sutramServer] update table error:', err);
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});

/**
 * DELETE /api/_sutram/schema/tables/:tableName
 * Safely drops a user table and cleans up metadata & Excel registration
 */
schemaRouter.delete('/tables/:tableName', async (req, res) => {
  try {
    const { engine, excel } = await getActiveProject(req);
    const tableName = req.params.tableName;

    console.log(`[sutramServer] Dropping table "${tableName}"...`);
    await engine.schema.dropTable(tableName);
    await projectManager._syncExcelRegistrations(engine, excel, true);

    res.json({
      success: true,
      message: `Table "${tableName}" deleted successfully.`
    });
  } catch (err) {
    console.error('[sutramServer] delete table error:', err);
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/_sutram/schema/tables
 * Returns all active user tables for the active project
 */
schemaRouter.get('/tables', async (req, res) => {
  try {
    const { engine } = await getActiveProject(req);
    const tableNames = Object.keys(engine._schema || {})
      .filter(t => !t.startsWith('sys_') && !t.startsWith('xls_') && !t.startsWith('sqlite_'));
    const tables = [];
    for (const t of tableNames) {
      const schema = engine._schema[t];
      const ui = (engine.ui && engine.ui.getTableSchema) ? await engine.ui.getTableSchema(t) : null;
      tables.push({
        table_name: t,
        display_name: ui?.display_name || t,
        columns: schema?.columns || {},
        joins: schema?.joins || {}
      });
    }
    res.json({ success: true, count: tables.length, result: tables });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/_sutram/schema/catalog
 * Rich catalog for Table Designer & Foreign Key multi-display mapping
 */
schemaRouter.get('/catalog', async (req, res) => {
  try {
    const { engine } = await getActiveProject(req);
    const tableNames = Object.keys(engine._schema || {})
      .filter(t => !t.startsWith('sys_') && !t.startsWith('xls_') && !t.startsWith('sqlite_'));
    const tables = [];
    for (const t of tableNames) {
      const schema = engine._schema[t];
      const ui = (engine.ui && engine.ui.getTableSchema) ? await engine.ui.getTableSchema(t) : null;
      const cols = Object.keys(schema?.columns || {}).map(cName => {
        const colDef = schema.columns[cName];
        return {
          column_name: cName,
          label: colDef?.label || cName,
          type: colDef?.type || 'string',
          is_pk: cName === '_id' || colDef?.is_pk === 1,
          ref: colDef?.ref || null
        };
      });
      const candidateDisplays = SchemaHeuristics.inferCandidateDisplayColumns(cols);
      tables.push({
        table_name: t,
        display_name: ui?.display_name || t,
        columns: cols,
        candidate_display_columns: candidateDisplays
      });
    }
    res.json({ success: true, count: tables.length, result: tables });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/_sutram/schema/reports
 */
schemaRouter.get('/reports', async (req, res) => {
  try {
    const { engine } = await getActiveProject(req);
    const reports = [];

    // 1. From sys_report via engine.report
    try {
      if (engine && engine.report && typeof engine.report.getReports === 'function') {
        const sysReps = await engine.report.getReports();
        for (const r of sysReps) {
          if (r.active !== 0) {
            reports.push({
              id: r.report_name,
              table: r.report_name,
              display_name: r.label || r.report_name,
              title: r.label || r.report_name,
              desc: r.description || 'Dynamic CTE Report',
              icon: 'pi-chart-line',
              category: 'Engine Reports',
              params: r.params || [],
              type: 'report'
            });
          }
        }
      }
    } catch {}

    // 2. Discover live SQL Views via Core listViews
    try {
      if (engine && typeof engine.getViews === 'function') {
        const views = await engine.getViews();
        for (const vName of views) {
          if (!reports.some(r => r.id === vName)) {
            reports.push({
              id: vName,
              table: vName,
              display_name: vName,
              title: vName,
              desc: 'Live Database SQL View',
              icon: 'pi-chart-bar',
              category: 'Database Views',
              type: 'view'
            });
          }
        }
      }
    } catch (e) {
      console.warn('[sutramServer] View introspection notice:', e.message);
    }

    res.json({ success: true, count: reports.length, result: reports });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/_sutram/schema/infer-column
 */
schemaRouter.post('/infer-column', (req, res) => {
  try {
    const { column_name } = req.body;
    if (!column_name) {
      return res.status(400).json({ success: false, error: 'column_name required' });
    }
    const inferred = SchemaHeuristics.inferTypeFromName(column_name);
    res.json({ success: true, result: inferred });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/_sutram/schema/preview-sql
 */
schemaRouter.post('/preview-sql', async (req, res) => {
  try {
    const { engine } = await getActiveProject(req);
    const { table_name, columns } = req.body;
    if (!table_name) {
      return res.status(400).json({ success: false, error: 'table_name required' });
    }
    const sql = engine.schema._buildCreateSQL(table_name, columns || []);
    res.json({ success: true, sql });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/_sutram/schema/table-config/:table
 */
schemaRouter.get('/table-config/:table', async (req, res) => {
  try {
    const { engine } = await getActiveProject(req);
    const tbl = req.params.table;
    const raw = await engine.getMeta(`table_ui_config:${tbl}`);
    if (raw) {
      try {
        const savedConfig = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return res.json({ success: true, result: savedConfig });
      } catch {}
    }
    return res.json({ success: true, result: null });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/_sutram/schema/table-config/:table
 */
schemaRouter.post('/table-config/:table', async (req, res) => {
  try {
    const { engine } = await getActiveProject(req);
    const tbl = req.params.table;
    const { display_name, columns = [], selected_keys = [] } = req.body;

    await engine.setMeta(`table_ui_config:${tbl}`, {
      table_name: tbl,
      display_name,
      columns,
      selected_keys,
      updated_at: new Date().toISOString()
    });

    if (display_name && engine.ui?.setTableUi) {
      try { await engine.ui.setTableUi(tbl, { display_name }); } catch {}
    }
    if (Array.isArray(columns) && engine.ui?.setColumnUi) {
      for (let i = 0; i < columns.length; i++) {
        const col = columns[i];
        const colName = col.col_name || col.column_name || col.name || col.key;
        if (!colName) continue;
        try {
          await engine.ui.setColumnUi(tbl, colName, {
            label: col.label,
            field_type: col.field_type || col.type || 'text',
            display_format: col.display_format || col.format || null,
            visible_list: col.visible_list !== false && col.visible !== false,
            sort_order: col.sort_order !== undefined ? col.sort_order : i
          });
        } catch (e) {}
      }
    }
    res.json({ success: true, message: `Configuration saved for table "${tbl}"` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/_sutram/schema/triggers/:table
 */
schemaRouter.get('/triggers/:table', async (req, res) => {
  try {
    const { engine } = await getActiveProject(req);
    const tbl = req.params.table;
    let triggers = [];
    const triggerMgr = engine.trigger || engine.triggers;
    if (triggerMgr && typeof triggerMgr.getTriggers === 'function') {
      const allTriggers = await triggerMgr.getTriggers();
      triggers = allTriggers.filter(t => t.source_table === tbl);
      for (const t of triggers) {
        try {
          t.actions = await triggerMgr.getActions(t._id);
        } catch {}
      }
    }
    res.json({ success: true, result: triggers });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/_sutram/schema/triggers
 */
schemaRouter.post('/triggers', async (req, res) => {
  try {
    const { engine } = await getActiveProject(req);
    const def = req.body;
    const triggerMgr = engine.trigger || engine.triggers;
    if (!triggerMgr || typeof triggerMgr.create !== 'function') {
      return res.status(400).json({ success: false, error: 'TriggerManager not available' });
    }
    if (!Array.isArray(def.actions) || def.actions.length === 0) {
      def.actions = [{
        action_type: def.action_type || 'raw_sql',
        target_table: def.target_table || null,
        condition: def.condition || null,
        raw_sql: def.raw_sql || null,
        field_map: def.field_map || {}
      }];
    }
    const id = await triggerMgr.create(def);
    res.json({ success: true, message: `Trigger "${def.trigger_name}" created`, triggerId: id });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * DELETE /api/_sutram/schema/triggers/:id
 */
schemaRouter.delete('/triggers/:id', async (req, res) => {
  try {
    const { engine } = await getActiveProject(req);
    const id = req.params.id;
    const triggerMgr = engine.trigger || engine.triggers;
    if (triggerMgr && typeof triggerMgr.delete === 'function') {
      await triggerMgr.delete(id);
    }
    res.json({ success: true, message: `Trigger ${id} deleted` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/_sutram/schema/ui-sutras/:table
 */
schemaRouter.get('/ui-sutras/:table', async (req, res) => {
  try {
    const { engine } = await getActiveProject(req);
    const tbl = req.params.table;
    const raw = await engine.getMeta(`ui_sutras:${tbl}`);
    const formulas = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : [];
    res.json({ success: true, result: formulas });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/_sutram/schema/ui-sutras/:table
 */
schemaRouter.post('/ui-sutras/:table', async (req, res) => {
  try {
    const { engine } = await getActiveProject(req);
    const tbl = req.params.table;
    const { formulas = [] } = req.body;
    await engine.setMeta(`ui_sutras:${tbl}`, formulas);
    res.json({ success: true, message: `UI Sutras saved for "${tbl}"` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// 5. In-Project Users & Author/Admin Roles (Project Database Level)
// ─────────────────────────────────────────────────────────────

async function ensureUserColumns(engine) {
  try {
    const inspected = await engine.inspectTable('sys_user');
    const hasOcr = (inspected.columns || []).some(c => c.name === 'can_ocr');
    if (!hasOcr) {
      try {
        await engine.core.addColumn('sys_user', {
          column_name: 'can_ocr',
          col_type: 'boolean',
          sql_type: 'TINYINT',
          default_value: '1'
        });
      } catch {}
    }

    const row = await engine.queryOne(`SELECT COUNT(*) as count FROM sys_user`);
    const userCount = row?.count || 0;
    if (userCount === 0) {
      await engine.run(
        `INSERT INTO sys_user (username, password, display_name, role, active, can_ocr) VALUES ('admin', 'admin', 'Project Administrator', 'admin', 1, 1)`
      );
    }
  } catch (err) {
    console.warn('[ensureUserColumns] Warning:', err.message);
  }
}

/**
 * GET /api/_sutram/schema/users
 */
schemaRouter.get('/users', async (req, res) => {
  try {
    const { engine } = await getActiveProject(req);
    await ensureUserColumns(engine);
    const users = await engine.query(`SELECT _id, username, display_name, role, active, COALESCE(can_ocr, 1) as can_ocr, created_at, updated_at FROM sys_user ORDER BY _id ASC`);
    res.json({ success: true, result: users });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/_sutram/schema/users
 */
schemaRouter.post('/users', async (req, res) => {
  try {
    const { engine } = await getActiveProject(req);
    const { username, password, display_name, role = 'author', active = 1, can_ocr = 1 } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Username and password are required' });
    }
    const cleanUser = String(username).trim();
    const cleanPass = String(password).trim();
    const cleanRole = role === 'admin' ? 'admin' : 'author';
    const cleanOcr = (can_ocr === 0 || can_ocr === false) ? 0 : 1;
    await ensureUserColumns(engine);

    const info = await engine.run(`
      INSERT INTO sys_user (username, password, display_name, role, active, can_ocr)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [cleanUser, cleanPass, display_name || cleanUser, cleanRole, active ? 1 : 0, cleanOcr]);

    const newId = info.insertId ?? info.lastInsertRowid;
    const newUser = await engine.queryOne(`SELECT _id, username, display_name, role, active, COALESCE(can_ocr, 1) as can_ocr, created_at, updated_at FROM sys_user WHERE _id = ?`, [newId]);
    res.json({ success: true, message: `User "${cleanUser}" created successfully in project`, result: newUser });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * PUT /api/_sutram/schema/users/:id
 */
schemaRouter.put('/users/:id', async (req, res) => {
  try {
    const { engine } = await getActiveProject(req);
    const id = req.params.id;
    const { username, password, display_name, role, active, can_ocr } = req.body;
    await ensureUserColumns(engine);

    const existing = await engine.queryOne(`SELECT * FROM sys_user WHERE _id = ?`, [id]);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'User not found in this project' });
    }

    const updatedUser = username ? String(username).trim() : existing.username;
    const updatedPass = (password && String(password).trim()) ? String(password).trim() : existing.password;
    const updatedDisp = display_name !== undefined ? display_name : existing.display_name;
    const updatedRole = role ? (role === 'admin' ? 'admin' : 'author') : existing.role;
    const updatedAct = active !== undefined ? (active ? 1 : 0) : existing.active;
    const updatedOcr = can_ocr !== undefined ? ((can_ocr === 0 || can_ocr === false) ? 0 : 1) : (existing.can_ocr !== undefined ? existing.can_ocr : 1);

    if (existing.role === 'admin' && updatedRole !== 'admin') {
      const adminCount = (await engine.queryOne(`SELECT COUNT(*) as count FROM sys_user WHERE role = 'admin' AND active = 1`))?.count || 0;
      if (adminCount <= 1) {
        return res.status(400).json({ success: false, error: 'Cannot revoke admin role from the sole active administrator in this project' });
      }
    }

    await engine.run(`
      UPDATE sys_user
      SET username = ?, password = ?, display_name = ?, role = ?, active = ?, can_ocr = ?, updated_at = ?
      WHERE _id = ?
    `, [updatedUser, updatedPass, updatedDisp, updatedRole, updatedAct, updatedOcr, nowTimestampStr(), id]);

    const result = await engine.queryOne(`SELECT _id, username, display_name, role, active, COALESCE(can_ocr, 1) as can_ocr, created_at, updated_at FROM sys_user WHERE _id = ?`, [id]);
    res.json({ success: true, message: `Project user updated successfully`, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * DELETE /api/_sutram/schema/users/:id
 */
schemaRouter.delete('/users/:id', async (req, res) => {
  try {
    const { engine } = await getActiveProject(req);
    const id = req.params.id;

    const existing = await engine.queryOne(`SELECT * FROM sys_user WHERE _id = ?`, [id]);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'User not found in this project' });
    }

    if (existing.role === 'admin') {
      const adminCount = (await engine.queryOne(`SELECT COUNT(*) as count FROM sys_user WHERE role = 'admin' AND active = 1`))?.count || 0;
      if (adminCount <= 1) {
        return res.status(400).json({ success: false, error: 'Cannot delete the sole administrator of this project' });
      }
    }

    await engine.run(`DELETE FROM sys_user WHERE _id = ?`, [id]);
    res.json({ success: true, message: `Project user "${existing.username}" deleted successfully` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/_sutram/schema/user-rights/:userId
 */
schemaRouter.get('/user-rights/:userId', async (req, res) => {
  try {
    const { engine } = await getActiveProject(req);
    const userId = req.params.userId;
    const rights = await engine.query(`SELECT * FROM sys_user_rights WHERE user_id = ?`, [userId]);
    res.json({ success: true, result: rights });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/_sutram/schema/user-rights/:userId
 */
schemaRouter.post('/user-rights/:userId', async (req, res) => {
  try {
    const { engine } = await getActiveProject(req);
    const userId = req.params.userId;
    const rights = Array.isArray(req.body.rights) ? req.body.rights : [];

    const now = nowTimestampStr();
    const needTx = !engine.inTransaction;
    try {
      if (needTx) await engine.begin();
      for (const r of rights) {
        await engine.upsert('sys_user_rights', ['user_id', 'table_name'], {
          user_id: userId,
          table_name: r.table_name,
          can_view: r.can_view ? 1 : 0,
          can_edit: r.can_edit ? 1 : 0,
          can_delete: r.can_delete ? 1 : 0,
          can_unmask: r.can_unmask ? 1 : 0,
          updated_at: now
        });
      }
      if (needTx) await engine.commit();
    } catch (txErr) {
      if (needTx && engine.inTransaction) await engine.rollback();
      throw txErr;
    }

    res.json({ success: true, message: 'User rights updated successfully in project' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * In-Project Password and Column Security Handlers
 */
async function handleVerifyUnmask(req, res) {
  try {
    const { engine } = await getActiveProject(req);
    const { userId, table, column, secret } = req.body;
    if (!secret) return res.status(400).json({ success: false, error: 'Password or PIN required' });
    const cleanSecret = String(secret).trim();

    let colSec = null;
    if (table && column) {
      try {
        colSec = await engine.queryOne(`SELECT secret_hash FROM sys_column_security WHERE table_name = ? AND column_name = ?`, [table, column]);
      } catch (e) {}
    }

    if (colSec && colSec.secret_hash && String(colSec.secret_hash).trim().length > 0) {
      if (colSec.secret_hash === cleanSecret) {
        return res.json({ success: true, authorized: true, method: 'column_pin' });
      } else {
        return res.status(401).json({ success: false, authorized: false, error: 'गलत पिन (विशेष कॉलम पिन अमान्य है)' });
      }
    }

    const adminUser = await engine.queryOne(`SELECT * FROM sys_user WHERE role = 'admin' AND active = 1 AND password = ?`, [cleanSecret]);
    if (adminUser) {
      return res.json({ success: true, authorized: true, method: 'admin_password' });
    }

    if (userId) {
      const user = await engine.queryOne(`SELECT * FROM sys_user WHERE (_id = ? OR username = ?) AND active = 1 AND password = ?`, [userId, userId, cleanSecret]);
      if (user) {
        return res.json({ success: true, authorized: true, method: 'user_password' });
      }
    }

    res.status(401).json({ success: false, authorized: false, error: 'गलत पासवर्ड (Invalid Admin Password)' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

async function handleSetColumnSecurity(req, res) {
  try {
    const { engine } = await getActiveProject(req);
    const { table, column, secret } = req.body;
    if (!table || !column) return res.status(400).json({ success: false, error: 'Table and column required' });

    if (!secret || !String(secret).trim()) {
      await engine.run(`DELETE FROM sys_column_security WHERE table_name = ? AND column_name = ?`, [table, column]);
      return res.json({ success: true, message: 'Column security PIN removed (admin password will be used)' });
    }

    await engine.upsert('sys_column_security', ['table_name', 'column_name'], {
      table_name: table,
      column_name: column,
      secret_hash: String(secret).trim(),
      updated_at: nowTimestampStr()
    });

    res.json({ success: true, message: 'Column security PIN saved successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

authRouter.post('/verify-unmask', handleVerifyUnmask);
authRouter.post('/set-column-security', handleSetColumnSecurity);
schemaRouter.post('/auth/verify-unmask', handleVerifyUnmask);
schemaRouter.post('/auth/set-column-security', handleSetColumnSecurity);

/**
 * POST /api/_sutram/auth/login
 */
async function handleProjectUserLogin(req, res) {
  try {
    const { engine } = await getActiveProject(req);
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Username and password are required' });
    }
    const cleanUser = String(username).trim();
    const cleanPass = String(password).trim();
    await ensureUserColumns(engine);

    const user = await engine.queryOne(`
      SELECT _id, username, password, display_name, role, active, COALESCE(can_ocr, 1) as can_ocr
      FROM sys_user
      WHERE (username = ? OR _id = ?) AND active = 1
    `, [cleanUser, cleanUser]);

    if (!user || user.password !== cleanPass) {
      return res.status(401).json({ success: false, error: 'अमान्य यूज़रनेम या पासवर्ड (Invalid username or password)' });
    }

    const rights = await engine.query(`SELECT table_name, can_view, can_edit, can_delete, can_unmask FROM sys_user_rights WHERE user_id = ?`, [user._id]);

    return res.json({
      success: true,
      result: {
        user: {
          _id: user._id,
          username: user.username,
          display_name: user.display_name,
          role: user.role,
          active: user.active,
          can_ocr: user.can_ocr === 1
        },
        rights
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * GET /api/_sutram/auth/me
 */
async function handleGetProjectUserMe(req, res) {
  try {
    const { engine } = await getActiveProject(req);
    const userParam = req.query.username || req.query.userId || req.headers['x-sutram-user'];
    if (!userParam) {
      return res.json({ success: true, result: null });
    }
    await ensureUserColumns(engine);

    const user = await engine.queryOne(`
      SELECT _id, username, display_name, role, active, COALESCE(can_ocr, 1) as can_ocr
      FROM sys_user
      WHERE (username = ? OR _id = ?) AND active = 1
    `, [userParam, userParam]);

    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found in project' });
    }

    const rights = await engine.query(`SELECT table_name, can_view, can_edit, can_delete, can_unmask FROM sys_user_rights WHERE user_id = ?`, [user._id]);

    res.json({
      success: true,
      result: {
        user: {
          _id: user._id,
          username: user.username,
          display_name: user.display_name,
          role: user.role,
          active: user.active,
          can_ocr: user.can_ocr === 1
        },
        rights
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

authRouter.post('/login', handleProjectUserLogin);
authRouter.get('/me', handleGetProjectUserMe);
schemaRouter.post('/auth/login', handleProjectUserLogin);
schemaRouter.get('/auth/me', handleGetProjectUserMe);

/**
 * POST /api/_sutram/seed-demo
 * Seeds starter tables in the active project database
 */
schemaRouter.post('/seed-demo', async (req, res) => {
  try {
    const { engine, excel } = await getActiveProject(req);
    const existing = Object.keys(engine._schema || {}).filter(t => !t.startsWith('sys_') && !t.startsWith('xls_'));
    if (existing.length > 0) {
      return res.json({ success: true, message: 'Database already has tables', tables: existing });
    }

    await engine.schema.createTable({
      table_name: 'item',
      label: 'Item Master (सामग्री सूची)',
      description: 'Products and items inventory master',
      columns: [
        { column_name: 'item_name', col_type: 'string', label: 'Item Name', is_required: 1 },
        { column_name: 'item_code', col_type: 'string', label: 'Item Code', is_required: 0 },
        { column_name: 'category', col_type: 'string', label: 'Category', is_required: 0 },
        { column_name: 'unit', col_type: 'string', label: 'Unit', is_required: 0 },
        { column_name: 'rate', col_type: 'number', label: 'Standard Rate', is_required: 0 },
        { column_name: 'active', col_type: 'boolean', label: 'Active', default_value: '1' }
      ]
    });

    await engine.schema.createTable({
      table_name: 'contact',
      label: 'Contacts & Parties (पार्टी विवरण)',
      description: 'Vendors, customers, and counterparties',
      columns: [
        { column_name: 'party_name', col_type: 'string', label: 'Party Name', is_required: 1 },
        { column_name: 'phone', col_type: 'string', label: 'Phone Number', is_required: 0 },
        { column_name: 'city', col_type: 'string', label: 'City', is_required: 0 },
        { column_name: 'gst_num', col_type: 'string', label: 'GST Number', is_required: 0 },
        { column_name: 'balance', col_type: 'number', label: 'Current Balance', default_value: '0' }
      ]
    });

    await engine.schema.createTable({
      table_name: 'stock_ledger',
      label: 'Stock Ledger (स्टॉक रजिस्टर)',
      description: 'Inventory transactions ledger',
      columns: [
        { column_name: 'entry_date', col_type: 'string', label: 'Date', is_required: 1 },
        { column_name: 'item_name', col_type: 'string', label: 'Item Name', is_required: 1 },
        { column_name: 'voucher_type', col_type: 'string', label: 'Inward / Outward', is_required: 1 },
        { column_name: 'quantity', col_type: 'number', label: 'Quantity', is_required: 1 },
        { column_name: 'remarks', col_type: 'string', label: 'Remarks', is_required: 0 }
      ]
    });

    await projectManager._syncExcelRegistrations(engine, excel, true);

    await engine.insert('item', { item_name: 'Basmati Rice (बासमती चावल)', item_code: 'RICE-01', category: 'Grains', unit: 'KG', rate: 85, active: 1 }, false);
    await engine.insert('item', { item_name: 'Mustard Oil (सरसों का तेल)', item_code: 'OIL-02', category: 'Oils', unit: 'Litre', rate: 140, active: 1 }, false);
    await engine.insert('item', { item_name: 'Pure Desi Ghee (शुद्ध घी)', item_code: 'GHEE-01', category: 'Dairy', unit: 'KG', rate: 550, active: 1 }, false);

    await engine.insert('contact', { party_name: 'Shree Krishna Traders', phone: '9876543210', city: 'Jaipur', gst_num: '08AAAAA0000A1Z5', balance: 12500 }, false);
    await engine.insert('contact', { party_name: 'Radhe Shyam & Sons', phone: '9829012345', city: 'Delhi', gst_num: '07BBBBB1111B1Z2', balance: -4500 }, false);

    res.json({
      success: true,
      message: 'Demo ERP tables seeded successfully in project!',
      tables: ['item', 'contact', 'stock_ledger']
    });
  } catch (err) {
    console.error('[sutramServer] seed-demo error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Mount schema router
app.use('/api/_sutram/schema', schemaRouter);
app.use('/_sutram/schema', schemaRouter);

// Mount auth router
app.use('/api/_sutram/auth', authRouter);
app.use('/_sutram/auth', authRouter);

// ─────────────────────────────────────────────────────────────
// 6. Reminders & Smart Watchdog REST APIs (Project Scoped)
// ─────────────────────────────────────────────────────────────
const reminderRouter = express.Router();

reminderRouter.get('/rules', async (req, res) => {
  try {
    const { engine } = await getActiveProject(req);
    const rules = await engine.reminder.getRules(req.query);
    res.json({ success: true, count: rules.length, result: rules });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

reminderRouter.post('/rules', async (req, res) => {
  try {
    const { engine } = await getActiveProject(req);
    const ruleId = await engine.reminder.createRule(req.body);
    const newRule = await engine.reminder.getRuleById(ruleId);
    res.json({ success: true, message: 'Reminder rule created', ruleId, result: newRule });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

reminderRouter.put('/rules/:id', async (req, res) => {
  try {
    const { engine } = await getActiveProject(req);
    await engine.reminder.updateRule(req.params.id, req.body);
    const updated = await engine.reminder.getRuleById(req.params.id);
    res.json({ success: true, message: 'Reminder rule updated', result: updated });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

reminderRouter.delete('/rules/:id', async (req, res) => {
  try {
    const { engine } = await getActiveProject(req);
    const deleted = await engine.reminder.deleteRule(req.params.id);
    res.json({ success: true, message: `Rule ${req.params.id} deleted`, deleted });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

reminderRouter.post('/test', async (req, res) => {
  try {
    const { engine } = await getActiveProject(req);
    const preview = await engine.reminder.testRule(req.body);
    res.json({ success: true, result: preview });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

reminderRouter.get('/active', async (req, res) => {
  try {
    const { engine } = await getActiveProject(req);
    const evalResult = await engine.reminder.evaluateAll();
    const active = evalResult.activeAlerts || [];
    const permanent = evalResult.permanentAlerts || [];
    const combined = [...active];
    for (const p of permanent) {
      if (!combined.some(c => (c.log_id && c.log_id === p.log_id) || c.rule_id === p.rule_id)) {
        combined.push(p);
      }
    }
    res.json({ success: true, count: combined.length, result: combined, details: evalResult });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

reminderRouter.post('/evaluate', async (req, res) => {
  try {
    const { engine } = await getActiveProject(req);
    const result = await engine.reminder.evaluateAll({ force: true });
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

reminderRouter.post('/snooze/:logId', async (req, res) => {
  try {
    const { engine } = await getActiveProject(req);
    const minutes = req.body?.minutes || 15;
    await engine.reminder.snooze(req.params.logId, minutes);
    res.json({ success: true, message: `Alert snoozed for ${minutes} minutes` });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

reminderRouter.post('/dismiss/:logId', async (req, res) => {
  try {
    const { engine } = await getActiveProject(req);
    const user = req.body?.user || 'admin';
    const reason = req.body?.reason || '';
    await engine.reminder.dismiss(req.params.logId, user, reason);
    res.json({ success: true, message: 'Alert dismissed successfully' });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.use('/api/_sutram/reminders', reminderRouter);
app.use('/_sutram/reminders', reminderRouter);

// ─────────────────────────────────────────────────────────────
// 7. Dynamic Project SutramExcel Routing
// ─────────────────────────────────────────────────────────────
app.use(['/_sutram/excel', '/api/_sutram/excel', '/api/sutram/excel'], async (req, res, next) => {
  try {
    const { excel } = await getActiveProject(req);
    return excel.router()(req, res, next);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// 7.1. Dynamic SutramVision (Visual Document & Handwriting OCR AI)
// ─────────────────────────────────────────────────────────────
const { SutramVision } = require('../packages/sutramVision');
const sutramVision = new SutramVision();
app.use(['/_sutram/vision', '/api/_sutram/vision', '/api/sutram/vision'], async (req, res, next) => {
  try {
    const { engine } = await getActiveProject(req);
    req.sutramEngine = engine;
    req.projectDb = engine.db || null;
  } catch (err) {
    // If no active project in context, ignore
  }
  return sutramVision.router()(req, res, next);
});

// ─────────────────────────────────────────────────────────────
// 8. Dynamic Project Core SutramEngine CRUD REST APIs
// ─────────────────────────────────────────────────────────────
app.use('/api', async (req, res, next) => {
  // Let system diagnostics and server-level _sutram namespaces pass through cleanly;
  // allow engine-owned /_sutram/menu, /_sutram/schema/:table, and /_sutram/reports to reach engine.router().
  if (
    req.path === '/' ||
    req.path === '/status' ||
    req.path === '/health' ||
    /^\/_sutram\/(master|auth|reminders|excel|vision|lan|update)(\/|$)/.test(req.path)
  ) {
    return next();
  }
  try {
    const { engine } = await getActiveProject(req);
    return engine.router()(req, res, next);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// 9. Root & Healthcheck (Serve Angular Single Page App on `/`)
// ─────────────────────────────────────────────────────────────
async function sendApiStatus(req, res) {
  try {
    const defaultInstance = await getActiveProject(req);
    const tables = Object.keys(defaultInstance.engine._schema || {}).filter(t => !t.startsWith('sys_') && !t.startsWith('xls_'));
    res.json({
      app: 'Sutram Multi-Project Universal ERP Engine Platform',
      status: 'online',
      activeProject: defaultInstance.project?.project_slug || 'default',
      activeTables: tables,
      projectsCount: projectManager.listProjects().length,
      frontend: fs.existsSync(path.join(uiDistPath, 'index.html')) ? 'Integrated SutramUI Production Bundle' : 'SutramUI Dev Server (port 4300)'
    });
  } catch (e) {
    res.json({
      app: 'Sutram Multi-Project Universal ERP Engine Platform',
      status: 'online',
      error: e.message
    });
  }
}

app.get(['/api', '/api/status'], sendApiStatus);

app.get('/', async (req, res, next) => {
  const indexHtml = path.join(uiDistPath, 'index.html');
  if (fs.existsSync(indexHtml) && req.accepts('html')) {
    return res.sendFile(indexHtml);
  }
  await sendApiStatus(req, res);
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'online',
    app: 'Sutram Multi-Project ERP Server',
    timestamp: new Date().toISOString()
  });
});

// ─────────────────────────────────────────────────────────────
// 9. LAN Network Discovery & Sharing REST APIs (sutramLan)
// ─────────────────────────────────────────────────────────────
const SutramLan = require('../packages/sutramLan');
const UpdateManager = require('./src/UpdateManager');

const sutramLan = new SutramLan({
  nodeName: config.nodeName || require('os').hostname() || 'Sutram Workstation',
  httpPort: config.port || 3300,
  broadcastPort: 43210
});

const updateManager = new UpdateManager({
  sutramRoot: path.resolve(__dirname, '../'),
  sutramServerDir: __dirname,
  sutramPackagesDir: path.resolve(__dirname, '../packages'),
  sutramUiDistDir: path.resolve(__dirname, '../dist'),
  backupsDir: path.resolve(config.dataDir, 'backups'),
  tempDir: path.resolve(config.dataDir, 'temp_updates')
});

const lanRouter = express.Router();

// GET /api/_sutram/lan/status - Local node identity & active peers count
lanRouter.get('/status', (req, res) => {
  try {
    const nodeInfo = sutramLan.getNodeInfo();
    const peers = sutramLan.getPeers();
    res.json({ success: true, node: nodeInfo, peersCount: peers.length, peers });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/_sutram/lan/peers - Discovered peers on local Wi-Fi / LAN
lanRouter.get('/peers', (req, res) => {
  try {
    const peers = sutramLan.getPeers();
    res.json({ success: true, count: peers.length, result: peers });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/_sutram/lan/share - Toggle project sharing on LAN
lanRouter.post('/share', async (req, res) => {
  try {
    const { projectId, name, authType, pin, password, description } = req.body;
    if (!projectId) return res.status(400).json({ success: false, error: 'projectId is required' });

    let tablesCount = 0;
    try {
      const proj = await projectManager.getProject(projectId);
      if (proj && proj.engine && typeof proj.engine.listPhysicalTables === 'function') {
        const phys = await proj.engine.listPhysicalTables();
        tablesCount = phys.filter(t => !t.startsWith('sys_') && !t.startsWith('xls_') && !t.startsWith('sqlite_')).length;
      }
    } catch {}

    sutramLan.shareProject({
      id: projectId,
      name: name || projectId,
      authType: authType || (pin ? 'pin' : (password ? 'password' : 'none')),
      pin,
      password,
      tablesCount,
      description
    });

    res.json({ success: true, message: `Project "${projectId}" is now live on LAN`, isLive: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/_sutram/lan/unshare - Stop sharing project on LAN
lanRouter.post('/unshare', (req, res) => {
  try {
    const { projectId } = req.body;
    if (!projectId) return res.status(400).json({ success: false, error: 'projectId is required' });
    sutramLan.unshareProject(projectId);
    res.json({ success: true, message: `Project "${projectId}" is now private (local only)`, isLive: false });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/_sutram/lan/challenge - Request auth challenge for remote access
lanRouter.post('/challenge', (req, res) => {
  try {
    const { projectId } = req.body;
    if (!projectId) return res.status(400).json({ success: false, error: 'projectId is required' });
    const result = sutramLan.createAuthChallenge(projectId);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/_sutram/lan/auth - Verify PIN/Password challenge solution
lanRouter.post('/auth', (req, res) => {
  try {
    const { challenge, response, secret } = req.body;
    if (!challenge) return res.status(400).json({ success: false, error: 'challenge is required' });
    const result = sutramLan.verifyAuthResponse(challenge, response, secret);
    if (!result.success) {
      return res.status(401).json({ success: false, error: result.error || 'Authentication failed' });
    }
    res.json({ success: true, token: result.token });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.use('/api/_sutram/lan', lanRouter);

// ─────────────────────────────────────────────────────────────
// 9B. Application Zip Update APIs (Safe Replacement Engine)
// ─────────────────────────────────────────────────────────────
const updateRouter = express.Router();

// POST /api/_sutram/update/upload - Upload and apply update.zip
updateRouter.post('/upload', tempUpload.single('updateZip'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No update ZIP file provided' });
    }
    const result = await updateManager.applyUpdate(req.file.path);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/_sutram/update/backups - List previous restore points
updateRouter.get('/backups', (req, res) => {
  try {
    const backups = updateManager.listBackups();
    res.json({ success: true, count: backups.length, result: backups });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/_sutram/update/rollback - Restore from a previous backup
updateRouter.post('/rollback', (req, res) => {
  try {
    const { backupId } = req.body;
    if (!backupId) return res.status(400).json({ success: false, error: 'backupId is required' });
    const result = updateManager.rollbackBackup(backupId);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.use('/api/_sutram/update', updateRouter);

// ─────────────────────────────────────────────────────────────
// 9C. HTML5 Client-Side Routing Fallback (Angular Single Page App)
// ─────────────────────────────────────────────────────────────
if (fs.existsSync(uiDistPath)) {
  app.get('*', (req, res, next) => {
    // Let API routes fall through
    if (req.path.startsWith('/api') || req.path.startsWith('/_sutram')) {
      return next();
    }
    const indexHtml = path.join(uiDistPath, 'index.html');
    if (fs.existsSync(indexHtml)) {
      return res.sendFile(indexHtml);
    }
    next();
  });
}

// ─────────────────────────────────────────────────────────────
// 10. Start Server
// ─────────────────────────────────────────────────────────────
let server = null;
if (require.main === module) {
  server = app.listen(config.port, async () => {
    const projects = projectManager.listProjects();
    
    // Auto-start LAN beacon & scanner
    try {
      await sutramLan.start();
      console.log(`📡 [sutramLan] Active on UDP Port ${sutramLan.broadcastPort} (Node: "${sutramLan.nodeName}")`);
    } catch (lanErr) {
      console.warn(`⚠️ [sutramLan] Warning: Could not bind UDP port: ${lanErr.message}`);
    }

    console.log(`
╔═══════════════════════════════════════════════════════════════════╗
║             SUTRAM MULTI-PROJECT ERP ENGINE SERVER                ║
║           Universal Multi-Database Workspace Platform             ║
╠═══════════════════════════════════════════════════════════════════╣
║  🌐 Backend API:        http://localhost:${config.port}                     ║
║  📡 LAN Mesh Status:    http://localhost:${config.port}/api/_sutram/lan/status      ║
║  🚀 Master Projects:    http://localhost:${config.port}/api/_sutram/master/projects ║
║  📊 Active Projects:    ${projects.length} workspace database(s) loaded       ║
║  💾 Master Registry:    sutram_master.db (Managed Mode)           ║
║  💻 Frontend UI:        http://localhost:4300 (sutramUI)           ║
╚═══════════════════════════════════════════════════════════════════╝
    `);
  });
}

module.exports = { app, server, projectManager, getActiveProject };
