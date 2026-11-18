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
function getActiveProject(req) {
  const slug = req?.query?.project
    || req?.headers?.['x-project-slug']
    || req?.headers?.['x-project-id']
    || projectManager.activeProjectSlug
    || projectManager.getDefaultProjectSlug();
  const instance = projectManager.getProject(slug);
  if (!instance) {
    throw new Error(`Project "${slug || 'default'}" not found`);
  }
  if (instance.project?.project_slug && projectManager.activeProjectSlug !== instance.project.project_slug) {
    projectManager.activeProjectSlug = instance.project.project_slug;
  }
  return instance;
}

// 2. Create Express Application
const app = express();
app.use(cors(config.cors));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

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
masterRouter.post('/projects', (req, res) => {
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

    const { name, description, password, username, color, icon, dbSource, tempFileKey } = req.body;
    let tempDbFile = null;
    if (tempFileKey) {
      tempDbFile = path.resolve(projectManager.tempDir, tempFileKey);
    }

    const result = projectManager.createProject({
      name,
      description,
      password: password || '',
      username: username || 'admin',
      color: color || '#10b981',
      icon: icon || 'pi pi-folder',
      createdBy: requestingUser,
      dbSource: dbSource || 'blank',
      tempDbFile
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
 * GET /api/_sutram/master/projects/:slug
 * Retrieves project details
 */
masterRouter.get('/projects/:slug', (req, res) => {
  try {
    const instance = projectManager.getProject(req.params.slug);
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
 * Archives / soft-deletes a project
 */
masterRouter.delete('/projects/:slug', (req, res) => {
  try {
    const result = projectManager.deleteProject(req.params.slug);
    res.json(result);
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/_sutram/master/projects/switch/:slug
 * Instantly switches server active database connection to this project
 */
masterRouter.post('/projects/switch/:slug', (req, res) => {
  try {
    const instance = projectManager.setActiveProject(req.params.slug);
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
masterRouter.get('/projects/active', (req, res) => {
  try {
    const instance = projectManager.getActiveProject();
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
masterRouter.get('/projects/:slug/access', (req, res) => {
  try {
    const instance = projectManager.getProject(req.params.slug);
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
masterRouter.post('/projects/:slug/access', (req, res) => {
  try {
    const instance = projectManager.getProject(req.params.slug);
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
masterRouter.delete('/projects/:slug/access/:userId', (req, res) => {
  try {
    const instance = projectManager.getProject(req.params.slug);
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
schemaRouter.post('/create-table', (req, res) => {
  try {
    const { engine, excel } = getActiveProject(req);
    const { table_name, label, description, columns, joins } = req.body;
    if (!table_name) {
      return res.status(400).json({ success: false, error: 'table_name is required' });
    }
    if (!Array.isArray(columns) || columns.length === 0) {
      return res.status(400).json({ success: false, error: 'At least one column is required' });
    }

    console.log(`[sutramServer] Creating dynamic table "${table_name}" in project "${engine.db.name || 'active'}"...`);
    engine.schema.createTable({ table_name, label, description, columns, joins });

    // Auto-set UI metadata if label provided
    if (label) {
      try {
        engine.ui.setTableUi(table_name, { display_name: label, icon: 'pi pi-table' });
      } catch (e) {
        console.warn('[sutramServer] Notice: UiManager setTableUi warning:', e.message);
      }
    }

    // Auto-register the newly created table in Excel Studio with fresh schema derivation
    projectManager._syncExcelRegistrations(engine, excel, true);

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
schemaRouter.get('/table-detail/:tableName', (req, res) => {
  try {
    const { engine } = getActiveProject(req);
    const tableName = req.params.tableName;
    const detail = engine.schema.getTableDetail(tableName);
    const impact = engine.schema.getTableImpact(tableName);
    const ui = (engine.ui && engine.ui.getTableSchema) ? engine.ui.getTableSchema(tableName) : null;

    // Enrich columns with physical PRAGMA table_info (exact SQL type, notnull, default)
    const db = engine.db.db || engine.db;
    const pragmaCols = db.prepare(`PRAGMA table_info("${tableName}")`).all();
    const pragmaMap = new Map(pragmaCols.map(p => [p.name, p]));
    const pragmaIndexes = db.prepare(`PRAGMA index_list("${tableName}")`).all();
    const uniqueCols = new Set();
    const indexedCols = new Set();
    for (const idx of pragmaIndexes) {
      const info = db.prepare(`PRAGMA index_info("${idx.name}")`).all();
      for (const ic of info) {
        indexedCols.add(ic.name);
        if (idx.unique) uniqueCols.add(ic.name);
      }
    }

    const enrichedColumns = (detail.columns || []).map(c => {
      const pInfo = pragmaMap.get(c.column_name);
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
 * Updates an existing table using 2-Tier Hybrid Strategy (Fast In-Place or Atomic Shadow Rebuild)
 */
schemaRouter.put('/tables/:tableName', (req, res) => {
  try {
    const { engine, excel } = getActiveProject(req);
    const tableName = req.params.tableName;
    const { label, description, columns } = req.body;

    console.log(`[sutramServer] Updating table "${tableName}"...`);
    const result = engine.schema.updateTable(tableName, { label, description, columns });

    if (label) {
      try {
        engine.ui.setTableUi(tableName, { display_name: label, icon: 'pi pi-table' });
      } catch (e) {
        console.warn('[sutramServer] Notice: UiManager setTableUi warning:', e.message);
      }
    }

    projectManager._syncExcelRegistrations(engine, excel, true);

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
schemaRouter.delete('/tables/:tableName', (req, res) => {
  try {
    const { engine, excel } = getActiveProject(req);
    const tableName = req.params.tableName;

    console.log(`[sutramServer] Dropping table "${tableName}"...`);
    engine.schema.dropTable(tableName);
    projectManager._syncExcelRegistrations(engine, excel, true);

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
schemaRouter.get('/tables', (req, res) => {
  try {
    const { engine } = getActiveProject(req);
    const tables = Object.keys(engine._schema || {})
      .filter(t => !t.startsWith('sys_') && !t.startsWith('sqlite_'))
      .map(t => {
        const schema = engine._schema[t];
        const ui = (engine.ui && engine.ui.getTableSchema) ? engine.ui.getTableSchema(t) : null;
        return {
          table_name: t,
          display_name: ui?.display_name || t,
          columns: schema?.columns || {},
          joins: schema?.joins || {}
        };
      });
    res.json({ success: true, count: tables.length, result: tables });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/_sutram/schema/catalog
 * Rich catalog for Table Designer & Foreign Key multi-display mapping
 */
schemaRouter.get('/catalog', (req, res) => {
  try {
    const { engine } = getActiveProject(req);
    const tables = Object.keys(engine._schema || {})
      .filter(t => !t.startsWith('sys_') && !t.startsWith('sqlite_'))
      .map(t => {
        const schema = engine._schema[t];
        const ui = (engine.ui && engine.ui.getTableSchema) ? engine.ui.getTableSchema(t) : null;
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
        return {
          table_name: t,
          display_name: ui?.display_name || t,
          columns: cols,
          candidate_display_columns: candidateDisplays
        };
      });
    res.json({ success: true, count: tables.length, result: tables });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/_sutram/schema/reports
 */
schemaRouter.get('/reports', (req, res) => {
  try {
    const { engine } = getActiveProject(req);
    const reports = [];

    // 1. From sys_report via engine.report
    try {
      if (engine && engine.report && typeof engine.report.getReports === 'function') {
        const sysReps = engine.report.getReports();
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
    } catch (e) {
      // sys_report uninitialized
    }

    // 2. Discover live SQL Views from active DB
    try {
      const db = engine.db.db || engine.db;
      if (db && typeof db.prepare === 'function') {
        const views = db.prepare(
          `SELECT name FROM sqlite_master WHERE type = 'view' AND name NOT LIKE 'sys_%' AND name NOT LIKE 'sqlite_%'`
        ).all();
        for (const v of views) {
          if (!reports.some(r => r.id === v.name)) {
            reports.push({
              id: v.name,
              table: v.name,
              display_name: v.name,
              title: v.name,
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
schemaRouter.post('/preview-sql', (req, res) => {
  try {
    const { engine } = getActiveProject(req);
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
schemaRouter.get('/table-config/:table', (req, res) => {
  try {
    const { engine } = getActiveProject(req);
    const tbl = req.params.table;
    const db = engine.db.db || engine.db;
    
    const row = db.prepare(`SELECT value FROM sys_meta WHERE key = ?`).get(`table_ui_config:${tbl}`);
    if (row && row.value) {
      try {
        const savedConfig = JSON.parse(row.value);
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
schemaRouter.post('/table-config/:table', (req, res) => {
  try {
    const { engine } = getActiveProject(req);
    const tbl = req.params.table;
    const { display_name, columns = [], selected_keys = [] } = req.body;
    const db = engine.db.db || engine.db;

    db.prepare(`
      INSERT INTO sys_meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(`table_ui_config:${tbl}`, JSON.stringify({
      table_name: tbl,
      display_name,
      columns,
      selected_keys,
      updated_at: new Date().toISOString()
    }));

    if (display_name && engine.ui?.setTableUi) {
      try { engine.ui.setTableUi(tbl, { display_name }); } catch {}
    }
    if (Array.isArray(columns) && engine.ui?.setColumnUi) {
      for (let i = 0; i < columns.length; i++) {
        const col = columns[i];
        const colName = col.col_name || col.column_name || col.name || col.key;
        if (!colName) continue;
        try {
          engine.ui.setColumnUi(tbl, colName, {
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
schemaRouter.get('/triggers/:table', (req, res) => {
  try {
    const { engine } = getActiveProject(req);
    const tbl = req.params.table;
    let triggers = [];
    const triggerMgr = engine.trigger || engine.triggers;
    if (triggerMgr && typeof triggerMgr.getTriggers === 'function') {
      const allTriggers = triggerMgr.getTriggers();
      triggers = allTriggers.filter(t => t.source_table === tbl);
      for (const t of triggers) {
        try {
          const db = engine.db.db || engine.db;
          t.actions = db.prepare(`SELECT * FROM sys_trigger_action WHERE trigger_id = ? ORDER BY sort_order ASC`).all(t._id);
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
schemaRouter.post('/triggers', (req, res) => {
  try {
    const { engine } = getActiveProject(req);
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
    const id = triggerMgr.create(def);
    res.json({ success: true, message: `Trigger "${def.trigger_name}" created`, triggerId: id });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * DELETE /api/_sutram/schema/triggers/:id
 */
schemaRouter.delete('/triggers/:id', (req, res) => {
  try {
    const { engine } = getActiveProject(req);
    const id = req.params.id;
    const triggerMgr = engine.trigger || engine.triggers;
    if (triggerMgr && typeof triggerMgr.delete === 'function') {
      triggerMgr.delete(id);
    }
    res.json({ success: true, message: `Trigger ${id} deleted` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/_sutram/schema/ui-sutras/:table
 */
schemaRouter.get('/ui-sutras/:table', (req, res) => {
  try {
    const { engine } = getActiveProject(req);
    const tbl = req.params.table;
    const db = engine.db.db || engine.db;
    const row = db.prepare(`SELECT value FROM sys_meta WHERE key = ?`).get(`ui_sutras:${tbl}`);
    const formulas = row ? JSON.parse(row.value) : [];
    res.json({ success: true, result: formulas });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/_sutram/schema/ui-sutras/:table
 */
schemaRouter.post('/ui-sutras/:table', (req, res) => {
  try {
    const { engine } = getActiveProject(req);
    const tbl = req.params.table;
    const { formulas = [] } = req.body;
    const db = engine.db.db || engine.db;
    db.prepare(`
      INSERT INTO sys_meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(`ui_sutras:${tbl}`, JSON.stringify(formulas));
    res.json({ success: true, message: `UI Sutras saved for "${tbl}"` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// 5. In-Project Users & Author/Admin Roles (Project Database Level)
// ─────────────────────────────────────────────────────────────

function ensureUserColumns(db) {
  try {
    db.prepare(`
      CREATE TABLE IF NOT EXISTS sys_user (
        _id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        display_name TEXT,
        role TEXT DEFAULT 'author',
        active INTEGER DEFAULT 1,
        can_ocr INTEGER DEFAULT 1,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `).run();

    db.prepare(`
      CREATE TABLE IF NOT EXISTS sys_user_rights (
        _id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        table_name TEXT NOT NULL,
        can_view INTEGER DEFAULT 1,
        can_edit INTEGER DEFAULT 1,
        can_delete INTEGER DEFAULT 1,
        can_unmask INTEGER DEFAULT 0,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, table_name)
      )
    `).run();

    const cols = db.prepare(`PRAGMA table_info(sys_user)`).all();
    const hasOcr = cols.some(c => c.name === 'can_ocr');
    if (!hasOcr) {
      db.prepare(`ALTER TABLE sys_user ADD COLUMN can_ocr INTEGER DEFAULT 1`).run();
    }

    const userCount = db.prepare(`SELECT COUNT(*) as count FROM sys_user`).get()?.count || 0;
    if (userCount === 0) {
      db.prepare(`
        INSERT INTO sys_user (username, password, display_name, role, active, can_ocr)
        VALUES ('admin', 'admin', 'Project Administrator', 'admin', 1, 1)
      `).run();
    }
  } catch (err) {
    console.warn('[ensureUserColumns] Warning:', err.message);
  }
}

/**
 * GET /api/_sutram/schema/users
 * Returns users inside the active project database
 */
schemaRouter.get('/users', (req, res) => {
  try {
    const { engine } = getActiveProject(req);
    const db = engine.db.db || engine.db;
    ensureUserColumns(db);
    const users = db.prepare(`SELECT _id, username, display_name, role, active, COALESCE(can_ocr, 1) as can_ocr, created_at, updated_at FROM sys_user ORDER BY _id ASC`).all();
    res.json({ success: true, result: users });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/_sutram/schema/users
 * Creates a new Author or Admin user inside the active project database
 */
schemaRouter.post('/users', (req, res) => {
  try {
    const { engine } = getActiveProject(req);
    const { username, password, display_name, role = 'author', active = 1, can_ocr = 1 } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Username and password are required' });
    }
    const cleanUser = String(username).trim();
    const cleanPass = String(password).trim();
    const cleanRole = role === 'admin' ? 'admin' : 'author';
    const cleanOcr = (can_ocr === 0 || can_ocr === false) ? 0 : 1;
    const db = engine.db.db || engine.db;
    ensureUserColumns(db);

    const info = db.prepare(`
      INSERT INTO sys_user (username, password, display_name, role, active, can_ocr)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(cleanUser, cleanPass, display_name || cleanUser, cleanRole, active ? 1 : 0, cleanOcr);

    const newUser = db.prepare(`SELECT _id, username, display_name, role, active, COALESCE(can_ocr, 1) as can_ocr, created_at, updated_at FROM sys_user WHERE _id = ?`).get(info.lastInsertRowid);
    res.json({ success: true, message: `User "${cleanUser}" created successfully in project`, result: newUser });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * PUT /api/_sutram/schema/users/:id
 */
schemaRouter.put('/users/:id', (req, res) => {
  try {
    const { engine } = getActiveProject(req);
    const id = req.params.id;
    const { username, password, display_name, role, active, can_ocr } = req.body;
    const db = engine.db.db || engine.db;
    ensureUserColumns(db);

    const existing = db.prepare(`SELECT * FROM sys_user WHERE _id = ?`).get(id);
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
      const adminCount = db.prepare(`SELECT COUNT(*) as count FROM sys_user WHERE role = 'admin' AND active = 1`).get()?.count || 0;
      if (adminCount <= 1) {
        return res.status(400).json({ success: false, error: 'Cannot revoke admin role from the sole active administrator in this project' });
      }
    }

    db.prepare(`
      UPDATE sys_user
      SET username = ?, password = ?, display_name = ?, role = ?, active = ?, can_ocr = ?, updated_at = datetime('now', 'localtime')
      WHERE _id = ?
    `).run(updatedUser, updatedPass, updatedDisp, updatedRole, updatedAct, updatedOcr, id);

    const result = db.prepare(`SELECT _id, username, display_name, role, active, COALESCE(can_ocr, 1) as can_ocr, created_at, updated_at FROM sys_user WHERE _id = ?`).get(id);
    res.json({ success: true, message: `Project user updated successfully`, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * DELETE /api/_sutram/schema/users/:id
 */
schemaRouter.delete('/users/:id', (req, res) => {
  try {
    const { engine } = getActiveProject(req);
    const id = req.params.id;
    const db = engine.db.db || engine.db;

    const existing = db.prepare(`SELECT * FROM sys_user WHERE _id = ?`).get(id);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'User not found in this project' });
    }

    if (existing.role === 'admin') {
      const adminCount = db.prepare(`SELECT COUNT(*) as count FROM sys_user WHERE role = 'admin' AND active = 1`).get()?.count || 0;
      if (adminCount <= 1) {
        return res.status(400).json({ success: false, error: 'Cannot delete the sole administrator of this project' });
      }
    }

    db.prepare(`DELETE FROM sys_user WHERE _id = ?`).run(id);
    res.json({ success: true, message: `Project user "${existing.username}" deleted successfully` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/_sutram/schema/user-rights/:userId
 */
schemaRouter.get('/user-rights/:userId', (req, res) => {
  try {
    const { engine } = getActiveProject(req);
    const userId = req.params.userId;
    const db = engine.db.db || engine.db;
    const rights = db.prepare(`SELECT * FROM sys_user_rights WHERE user_id = ?`).all(userId);
    res.json({ success: true, result: rights });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/_sutram/schema/user-rights/:userId
 */
schemaRouter.post('/user-rights/:userId', (req, res) => {
  try {
    const { engine } = getActiveProject(req);
    const userId = req.params.userId;
    const rights = Array.isArray(req.body.rights) ? req.body.rights : [];
    const db = engine.db.db || engine.db;

    const upsert = db.prepare(`
      INSERT INTO sys_user_rights (user_id, table_name, can_view, can_edit, can_delete, can_unmask, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))
      ON CONFLICT(user_id, table_name) DO UPDATE SET
        can_view = excluded.can_view,
        can_edit = excluded.can_edit,
        can_delete = excluded.can_delete,
        can_unmask = excluded.can_unmask,
        updated_at = datetime('now', 'localtime')
    `);

    db.transaction(() => {
      for (const r of rights) {
        upsert.run(userId, r.table_name, r.can_view ? 1 : 0, r.can_edit ? 1 : 0, r.can_delete ? 1 : 0, r.can_unmask ? 1 : 0);
      }
    })();

    res.json({ success: true, message: 'User rights updated successfully in project' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * In-Project Password and Column Security Handlers
 */
function handleVerifyUnmask(req, res) {
  try {
    const { engine } = getActiveProject(req);
    const { userId, table, column, secret } = req.body;
    if (!secret) return res.status(400).json({ success: false, error: 'Password or PIN required' });
    const cleanSecret = String(secret).trim();
    const db = engine.db.db || engine.db;

    // 1. Check custom column security PIN first
    let colSec = null;
    if (table && column) {
      try {
        colSec = db.prepare(`SELECT secret_hash FROM sys_column_security WHERE table_name = ? AND column_name = ?`).get(table, column);
      } catch (e) {}
    }

    if (colSec && colSec.secret_hash && String(colSec.secret_hash).trim().length > 0) {
      if (colSec.secret_hash === cleanSecret) {
        return res.json({ success: true, authorized: true, method: 'column_pin' });
      } else {
        return res.status(401).json({ success: false, authorized: false, error: 'गलत पिन (विशेष कॉलम पिन अमान्य है)' });
      }
    }

    // 2. Fallback to active Admin password in this project
    const adminUser = db.prepare(`SELECT * FROM sys_user WHERE role = 'admin' AND active = 1 AND password = ?`).get(cleanSecret);
    if (adminUser) {
      return res.json({ success: true, authorized: true, method: 'admin_password' });
    }

    // 3. Match caller user password
    if (userId) {
      const user = db.prepare(`SELECT * FROM sys_user WHERE (_id = ? OR username = ?) AND active = 1 AND password = ?`).get(userId, userId, cleanSecret);
      if (user) {
        return res.json({ success: true, authorized: true, method: 'user_password' });
      }
    }

    res.status(401).json({ success: false, authorized: false, error: 'गलत पासवर्ड (Invalid Admin Password)' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

function handleSetColumnSecurity(req, res) {
  try {
    const { engine } = getActiveProject(req);
    const { table, column, secret } = req.body;
    if (!table || !column) return res.status(400).json({ success: false, error: 'Table and column required' });
    const db = engine.db.db || engine.db;

    if (!secret || !String(secret).trim()) {
      db.prepare(`DELETE FROM sys_column_security WHERE table_name = ? AND column_name = ?`).run(table, column);
      return res.json({ success: true, message: 'Column security PIN removed (admin password will be used)' });
    }

    db.prepare(`
      INSERT INTO sys_column_security (table_name, column_name, secret_hash, updated_at)
      VALUES (?, ?, ?, datetime('now', 'localtime'))
      ON CONFLICT(table_name, column_name) DO UPDATE SET
        secret_hash = excluded.secret_hash,
        updated_at = datetime('now', 'localtime')
    `).run(table, column, String(secret).trim());

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
 * Project-level database user login (sys_user)
 */
function handleProjectUserLogin(req, res) {
  try {
    const { engine } = getActiveProject(req);
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Username and password are required' });
    }
    const cleanUser = String(username).trim();
    const cleanPass = String(password).trim();
    const db = engine.db.db || engine.db;
    ensureUserColumns(db);

    const user = db.prepare(`
      SELECT _id, username, password, display_name, role, active, COALESCE(can_ocr, 1) as can_ocr
      FROM sys_user
      WHERE (username = ? OR _id = ?) AND active = 1
    `).get(cleanUser, cleanUser);

    if (!user || user.password !== cleanPass) {
      return res.status(401).json({ success: false, error: 'अमान्य यूज़रनेम या पासवर्ड (Invalid username or password)' });
    }

    const rights = db.prepare(`SELECT table_name, can_view, can_edit, can_delete, can_unmask FROM sys_user_rights WHERE user_id = ?`).all(user._id);

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
 * Retrieves current user and rights for the active project
 */
function handleGetProjectUserMe(req, res) {
  try {
    const { engine } = getActiveProject(req);
    const userParam = req.query.username || req.query.userId || req.headers['x-sutram-user'];
    if (!userParam) {
      return res.json({ success: true, result: null });
    }
    const db = engine.db.db || engine.db;
    ensureUserColumns(db);

    const user = db.prepare(`
      SELECT _id, username, display_name, role, active, COALESCE(can_ocr, 1) as can_ocr
      FROM sys_user
      WHERE (username = ? OR _id = ?) AND active = 1
    `).get(userParam, userParam);

    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found in project' });
    }

    const rights = db.prepare(`SELECT table_name, can_view, can_edit, can_delete, can_unmask FROM sys_user_rights WHERE user_id = ?`).all(user._id);

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
schemaRouter.post('/seed-demo', (req, res) => {
  try {
    const { engine, excel } = getActiveProject(req);
    const existing = Object.keys(engine._schema || {}).filter(t => !t.startsWith('sys_'));
    if (existing.length > 0) {
      return res.json({ success: true, message: 'Database already has tables', tables: existing });
    }

    // 1. Create 'item' table
    engine.schema.createTable({
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

    // 2. Create 'contact' table
    engine.schema.createTable({
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

    // 3. Create 'stock_ledger' table
    engine.schema.createTable({
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

    projectManager._syncExcelRegistrations(engine, excel, true);

    // Insert sample starter data
    const itemTbl = engine.table('item');
    itemTbl.insert({ item_name: 'Basmati Rice (बासमती चावल)', item_code: 'RICE-01', category: 'Grains', unit: 'KG', rate: 85, active: 1 });
    itemTbl.insert({ item_name: 'Mustard Oil (सरसों का तेल)', item_code: 'OIL-02', category: 'Oils', unit: 'Litre', rate: 140, active: 1 });
    itemTbl.insert({ item_name: 'Pure Desi Ghee (शुद्ध घी)', item_code: 'GHEE-01', category: 'Dairy', unit: 'KG', rate: 550, active: 1 });

    const contactTbl = engine.table('contact');
    contactTbl.insert({ party_name: 'Shree Krishna Traders', phone: '9876543210', city: 'Jaipur', gst_num: '08AAAAA0000A1Z5', balance: 12500 });
    contactTbl.insert({ party_name: 'Radhe Shyam & Sons', phone: '9829012345', city: 'Delhi', gst_num: '07BBBBB1111B1Z2', balance: -4500 });

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

reminderRouter.get('/rules', (req, res) => {
  try {
    const { engine } = getActiveProject(req);
    const rules = engine.reminder.getRules(req.query);
    res.json({ success: true, count: rules.length, result: rules });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

reminderRouter.post('/rules', (req, res) => {
  try {
    const { engine } = getActiveProject(req);
    const ruleId = engine.reminder.createRule(req.body);
    const newRule = engine.reminder.getRuleById(ruleId);
    res.json({ success: true, message: 'Reminder rule created', ruleId, result: newRule });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

reminderRouter.put('/rules/:id', (req, res) => {
  try {
    const { engine } = getActiveProject(req);
    engine.reminder.updateRule(req.params.id, req.body);
    const updated = engine.reminder.getRuleById(req.params.id);
    res.json({ success: true, message: 'Reminder rule updated', result: updated });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

reminderRouter.delete('/rules/:id', (req, res) => {
  try {
    const { engine } = getActiveProject(req);
    const deleted = engine.reminder.deleteRule(req.params.id);
    res.json({ success: true, message: `Rule ${req.params.id} deleted`, deleted });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

reminderRouter.post('/test', (req, res) => {
  try {
    const { engine } = getActiveProject(req);
    const preview = engine.reminder.testRule(req.body);
    res.json({ success: true, result: preview });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

reminderRouter.get('/active', (req, res) => {
  try {
    const { engine } = getActiveProject(req);
    const evalResult = engine.reminder.evaluateAll();
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

reminderRouter.post('/evaluate', (req, res) => {
  try {
    const { engine } = getActiveProject(req);
    const result = engine.reminder.evaluateAll({ force: true });
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

reminderRouter.post('/snooze/:logId', (req, res) => {
  try {
    const { engine } = getActiveProject(req);
    const minutes = req.body?.minutes || 15;
    engine.reminder.snooze(req.params.logId, minutes);
    res.json({ success: true, message: `Alert snoozed for ${minutes} minutes` });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

reminderRouter.post('/dismiss/:logId', (req, res) => {
  try {
    const { engine } = getActiveProject(req);
    const user = req.body?.user || 'admin';
    const reason = req.body?.reason || '';
    engine.reminder.dismiss(req.params.logId, user, reason);
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
app.use(['/_sutram/excel', '/api/_sutram/excel', '/api/sutram/excel'], (req, res, next) => {
  try {
    const { excel } = getActiveProject(req);
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
app.use(['/_sutram/vision', '/api/_sutram/vision', '/api/sutram/vision'], (req, res, next) => {
  try {
    const { core } = getActiveProject(req);
    req.projectDb = core.getRawDb();
  } catch (err) {
    // If no active project in context, ignore
  }
  return sutramVision.router()(req, res, next);
});

// ─────────────────────────────────────────────────────────────
// 8. Dynamic Project Core SutramEngine CRUD REST APIs
// ─────────────────────────────────────────────────────────────
app.use('/api', (req, res, next) => {
  // If request begins with _sutram, it was already handled or unknown
  if (req.path.startsWith('/_sutram/')) {
    return next();
  }
  try {
    const { engine } = getActiveProject(req);
    return engine.router()(req, res, next);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// 9. Root Info & Healthcheck
// ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  try {
    const defaultInstance = getActiveProject(req);
    const tables = Object.keys(defaultInstance.engine._schema || {}).filter(t => !t.startsWith('sys_'));
    res.json({
      app: 'Sutram Multi-Project Universal ERP Engine Platform',
      status: 'online',
      activeProject: defaultInstance.project.project_slug,
      activeTables: tables,
      projectsCount: projectManager.listProjects().length,
      frontend: 'SutramUI Angular App (Runs independently on port 4300)'
    });
  } catch (e) {
    res.json({
      app: 'Sutram Multi-Project Universal ERP Engine Platform',
      status: 'online',
      error: e.message
    });
  }
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
lanRouter.post('/share', (req, res) => {
  try {
    const { projectId, name, authType, pin, password, description } = req.body;
    if (!projectId) return res.status(400).json({ success: false, error: 'projectId is required' });

    let tablesCount = 0;
    try {
      const proj = projectManager.getProject(projectId);
      if (proj && proj.engine && proj.engine.db) {
        tablesCount = proj.engine.db.prepare("SELECT count(*) as count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get()?.count || 0;
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
// 9C. Serve Sutram UI Frontend (Portable Single-Port & LAN Web Access)
// ─────────────────────────────────────────────────────────────
const primaryDistPath = path.resolve(__dirname, '../dist');
const legacyDistPath = path.resolve(__dirname, '../sutramUI/dist');
const uiDistPath = fs.existsSync(primaryDistPath) ? primaryDistPath : legacyDistPath;
if (fs.existsSync(uiDistPath)) {
  app.use(express.static(uiDistPath));
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
