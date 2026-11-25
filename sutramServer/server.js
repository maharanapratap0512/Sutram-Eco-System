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

function extractBearerOrHeader(req, headerName) {
  const direct = req?.headers?.[headerName];
  if (direct) return String(direct).trim();
  const auth = req?.headers?.authorization;
  if (auth && /^Bearer\s+/i.test(auth)) {
    return auth.replace(/^Bearer\s+/i, '').trim();
  }
  return '';
}

function getRequestProjectSlug(req, activeProj = null) {
  return (
    activeProj?.project?.project_slug ||
    req?.query?.project ||
    req?.headers?.['x-project-slug'] ||
    req?.headers?.['x-project-id'] ||
    projectManager.activeProjectSlug ||
    projectManager.getDefaultProjectSlug() ||
    ''
  );
}

/**
 * Verifies signed Master Workspace token (or valid LAN share token when allowed).
 */
function requireMasterAuth({ allowLan = false } = {}) {
  return (req, res, next) => {
    const masterToken = extractBearerOrHeader(req, 'x-master-token');
    if (masterToken) {
      const claims = projectManager.sessionManager.verifyToken(masterToken, 'master');
      if (claims) {
        const masterUser = projectManager.getMasterUserById(claims.uid);
        if (masterUser) {
          req.masterUser = masterUser;
          return next();
        }
      }
    }

    if (allowLan) {
      const lanToken = extractBearerOrHeader(req, 'x-lan-token');
      if (lanToken) {
        const lanClaims = sutramLan.security.verifyToken(lanToken);
        if (lanClaims) {
          req.lanSession = lanClaims;
          return next();
        }
      }
      const targetSlug = req.params?.slug || req.headers['x-project-slug'] || req.query?.project;
      const beaconProj = targetSlug && sutramLan?.beacon?.projects?.get(String(targetSlug));
      if (beaconProj && beaconProj.authType === 'none') {
        req.lanSession = { projectId: String(targetSlug), role: 'guest', authType: 'none' };
        return next();
      }
    }

    return res.status(401).json({
      success: false,
      code: 'MASTER_AUTH_REQUIRED',
      error: 'Authentication required: please sign in to Sutram Workspace.'
    });
  };
}

/**
 * Verifies signed per-project session token (x-project-token) AND live sys_user record.
 * Never trusts spoofable username headers or UI-only guards.
 */
async function requireProjectAuth(req, res, next) {
  try {
    const projectToken = extractBearerOrHeader(req, 'x-project-token');
    if (!projectToken) {
      return res.status(401).json({
        success: false,
        code: 'PROJECT_AUTH_REQUIRED',
        error: 'Project login required. Please sign in to open this workspace.'
      });
    }

    const claims = projectManager.sessionManager.verifyToken(projectToken, 'project');
    if (!claims) {
      return res.status(401).json({
        success: false,
        code: 'PROJECT_TOKEN_INVALID',
        error: 'Project session expired or invalid. Please sign in again.'
      });
    }

    const requestedSlug = req?.query?.project || req?.headers?.['x-project-slug'] || req?.headers?.['x-project-id'] || claims.slug;
    const activeProjectInfo = await projectManager.getProject(requestedSlug);
    if (!activeProjectInfo || activeProjectInfo.project?.project_slug !== claims.slug) {
      return res.status(401).json({
        success: false,
        code: 'PROJECT_TOKEN_MISMATCH',
        error: 'Project session token does not match the active project.'
      });
    }

    const { engine } = activeProjectInfo;
    const liveUser = engine.auth ? await engine.auth.getUserByIdOrUsername(claims.uid) : null;
    if (!liveUser || liveUser.active === 0) {
      return res.status(401).json({
        success: false,
        code: 'PROJECT_USER_INVALID',
        error: 'User account is inactive or missing in this project.'
      });
    }

    const rights = engine.auth ? await engine.auth.getUserRights(liveUser._id) : [];
    req.activeProjectInfo = activeProjectInfo;
    req.projectUser = liveUser;
    req.projectRights = rights;
    req.unmaskedCols = new Set();

    const unmaskHeader = req.headers['x-unmask-tokens'] || req.headers['x-unmask-token'];
    if (unmaskHeader) {
      const tokenList = String(unmaskHeader).split(',').map(s => s.trim()).filter(Boolean);
      for (const tok of tokenList) {
        const uClaims = projectManager.sessionManager.verifyToken(tok, 'unmask');
        if (uClaims && uClaims.slug === claims.slug && Number(uClaims.uid) === Number(liveUser._id) && uClaims.column) {
          req.unmaskedCols.add(uClaims.column);
        }
      }
    }

    if (projectManager.activeProjectSlug !== activeProjectInfo.project.project_slug) {
      projectManager.activeProjectSlug = activeProjectInfo.project.project_slug;
    }

    return next();
  } catch (err) {
    return res.status(401).json({
      success: false,
      code: 'PROJECT_AUTH_ERROR',
      error: err.message
    });
  }
}

function requireProjectAdmin(req, res, next) {
  if (!req.projectUser || req.projectUser.role !== 'admin') {
    return res.status(403).json({
      success: false,
      error: 'Administrator privileges are required for this action.'
    });
  }
  return next();
}

// Helper to resolve active project instance from request (prefers authenticated context)
async function getActiveProject(req) {
  if (req?.activeProjectInfo) {
    return req.activeProjectInfo;
  }
  const slug = getRequestProjectSlug(req);
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

const masterAuthStrict = requireMasterAuth({ allowLan: false });

/**
 * GET /api/_sutram/master/me
 * Verifies master token & returns fresh user profile
 */
masterRouter.get('/me', masterAuthStrict, (req, res) => {
  res.json({ success: true, result: req.masterUser });
});

/**
 * GET /api/_sutram/master/projects
 * List all projects accessible to the authenticated master user
 */
masterRouter.get('/projects', masterAuthStrict, (req, res) => {
  try {
    const projects = projectManager.listProjects(req.masterUser.username);
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
masterRouter.post('/projects/upload-db-temp', masterAuthStrict, tempUpload.single('dbFile'), (req, res) => {
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
masterRouter.post('/projects/inspect-db', masterAuthStrict, (req, res) => {
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
masterRouter.post('/projects', masterAuthStrict, async (req, res) => {
  try {
    const requestingUser = req.masterUser.username;
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
      password: password !== undefined && password !== null ? String(password) : '',
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
masterRouter.post('/projects/mysql/databases', masterAuthStrict, async (req, res) => {
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
masterRouter.post('/projects/mysql/inspect', masterAuthStrict, async (req, res) => {
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
masterRouter.get('/projects/:slug', masterAuthStrict, async (req, res) => {
  try {
    if (!projectManager.userHasProjectAccess(req.masterUser._id, req.params.slug)) {
      return res.status(403).json({ success: false, error: 'Access denied to this project' });
    }
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
masterRouter.put('/projects/:slug', masterAuthStrict, (req, res) => {
  try {
    if (!projectManager.userHasProjectAccess(req.masterUser._id, req.params.slug)) {
      return res.status(403).json({ success: false, error: 'Access denied to this project' });
    }
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
masterRouter.delete('/projects/:slug', masterAuthStrict, async (req, res) => {
  try {
    if (req.masterUser.role !== 'superadmin' && req.masterUser.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Only administrators can delete projects' });
    }
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
masterRouter.post('/projects/switch/:slug', requireMasterAuth({ allowLan: true }), async (req, res) => {
  try {
    if (req.masterUser && !projectManager.userHasProjectAccess(req.masterUser._id, req.params.slug)) {
      return res.status(403).json({ success: false, error: 'Access denied to this project' });
    }
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
masterRouter.get('/projects/active', masterAuthStrict, async (req, res) => {
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
masterRouter.get('/users', masterAuthStrict, (req, res) => {
  try {
    if (req.masterUser.role !== 'superadmin' && req.masterUser.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Admin access required' });
    }
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
masterRouter.get('/users/:userId/projects', masterAuthStrict, (req, res) => {
  try {
    if (req.masterUser.role !== 'superadmin' && req.masterUser.role !== 'admin' && Number(req.masterUser._id) !== Number(req.params.userId)) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    const access = projectManager.getUserProjects(req.params.userId);
    res.json({ success: true, count: access.length, result: access });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/_sutram/master/users
 * Creates a new master workspace user (supports blank password)
 */
masterRouter.post('/users', masterAuthStrict, (req, res) => {
  try {
    if (req.masterUser.role !== 'superadmin' && req.masterUser.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Admin access required' });
    }
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
masterRouter.put('/users/:userId', masterAuthStrict, (req, res) => {
  try {
    if (req.masterUser.role !== 'superadmin' && req.masterUser.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Admin access required' });
    }
    const updated = projectManager.updateMasterUser(req.params.userId, req.body);
    res.json({ success: true, message: 'User updated successfully', result: updated });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/_sutram/master/login
 * Validates master user credentials for Workspace Hub (blank password supported)
 */
masterRouter.post('/login', (req, res) => {
  try {
    const { username, password = '' } = req.body || {};
    if (!username || !String(username).trim()) {
      return res.status(400).json({ success: false, error: 'यूज़रनेम आवश्यक है (Username is required)' });
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
 */
masterRouter.get('/projects/:slug/access', masterAuthStrict, async (req, res) => {
  try {
    if (req.masterUser.role !== 'superadmin' && req.masterUser.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Admin access required' });
    }
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
 */
masterRouter.post('/projects/:slug/access', masterAuthStrict, async (req, res) => {
  try {
    if (req.masterUser.role !== 'superadmin' && req.masterUser.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Admin access required' });
    }
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
 */
masterRouter.delete('/projects/:slug/access/:userId', masterAuthStrict, async (req, res) => {
  try {
    if (req.masterUser.role !== 'superadmin' && req.masterUser.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Admin access required' });
    }
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

// Enforce authenticated project session on all schemaRouter endpoints (except /auth/login which requires Master/LAN auth)
schemaRouter.use((req, res, next) => {
  if (req.path === '/auth/login') {
    return requireMasterAuth({ allowLan: true })(req, res, next);
  }
  return requireProjectAuth(req, res, next);
});

/**
 * POST /api/_sutram/schema/create-table
 * Dynamically creates a table in the active project database and updates sys_ tables
 */
schemaRouter.post('/create-table', requireProjectAdmin, async (req, res) => {
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
schemaRouter.put('/tables/:tableName', requireProjectAdmin, async (req, res) => {
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
schemaRouter.delete('/tables/:tableName', requireProjectAdmin, async (req, res) => {
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
      .filter(t => !t.startsWith('sys_') && !t.startsWith('xls_') && !t.startsWith('sqlite_'))
      .filter(t => {
        if (!req.projectUser || !engine.auth) return true;
        return engine.auth.getEffectiveRights(req.projectUser, t, req.projectRights || []).can_view;
      });
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
schemaRouter.post('/table-config/:table', requireProjectAdmin, async (req, res) => {
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
schemaRouter.post('/triggers', requireProjectAdmin, async (req, res) => {
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
schemaRouter.delete('/triggers/:id', requireProjectAdmin, async (req, res) => {
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
schemaRouter.post('/ui-sutras/:table', requireProjectAdmin, async (req, res) => {
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
// 5. In-Project Users & Author/Admin Roles (Delegated to Engine.auth)
// ─────────────────────────────────────────────────────────────

schemaRouter.get('/users', requireProjectAdmin, async (req, res) => {
  try {
    const { engine } = await getActiveProject(req);
    const users = await engine.auth.listUsers();
    res.json({ success: true, result: users });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

schemaRouter.post('/users', requireProjectAdmin, async (req, res) => {
  try {
    const { engine } = await getActiveProject(req);
    const { username, password = '', display_name, role = 'author', active = 1, can_ocr = 1, misc_settings } = req.body || {};
    if (!username || !String(username).trim()) {
      return res.status(400).json({ success: false, error: 'Username is required' });
    }
    const newUser = await engine.auth.createUser({
      username,
      password,
      display_name,
      role,
      active,
      can_ocr,
      misc_settings
    });
    res.json({ success: true, message: `User "${newUser.username}" created successfully in project`, result: newUser });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

schemaRouter.put('/users/:id', requireProjectAdmin, async (req, res) => {
  try {
    const { engine } = await getActiveProject(req);
    const updated = await engine.auth.updateUser(req.params.id, req.body || {});
    res.json({ success: true, message: 'Project user updated successfully', result: updated });
  } catch (err) {
    res.status(err.statusCode || 400).json({ success: false, error: err.message });
  }
});

schemaRouter.delete('/users/:id', requireProjectAdmin, async (req, res) => {
  try {
    const { engine } = await getActiveProject(req);
    const deleted = await engine.auth.deleteUser(req.params.id);
    res.json({ success: true, message: `Project user "${deleted.username}" deleted successfully` });
  } catch (err) {
    res.status(err.statusCode || 400).json({ success: false, error: err.message });
  }
});

schemaRouter.get('/user-rights/:userId', requireProjectAdmin, async (req, res) => {
  try {
    const { engine } = await getActiveProject(req);
    const rights = await engine.auth.getUserRights(req.params.userId);
    res.json({ success: true, result: rights });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

schemaRouter.post('/user-rights/:userId', requireProjectAdmin, async (req, res) => {
  try {
    const { engine, excel } = await getActiveProject(req);
    const rights = Array.isArray(req.body?.rights) ? req.body.rights : [];
    const saved = await engine.auth.setUserRights(req.params.userId, rights);
    // Sync Excel registrations in case an owner user_id column was just added
    try { await projectManager._syncExcelRegistrations(engine, excel, true); } catch {}
    res.json({ success: true, message: 'User rights updated successfully in project', result: saved });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * In-Project Password and Column Security Handlers (via Engine.auth)
 */
async function handleVerifyUnmask(req, res) {
  try {
    const activeInfo = await getActiveProject(req);
    const { engine } = activeInfo;
    const { table, column, secret = '' } = req.body || {};

    if (table) {
      const eff = engine.auth.getEffectiveRights(req.projectUser, table, req.projectRights || []);
      if (req.projectUser.role !== 'admin' && !eff.can_unmask) {
        return res.status(403).json({ success: false, authorized: false, error: 'You do not have can_unmask permission for this table.' });
      }
    }

    const result = await engine.auth.verifyUnmask({
      userId: req.projectUser?._id,
      table,
      column,
      secret
    });

    if (!result.authorized) {
      return res.status(401).json({ success: false, authorized: false, error: result.error });
    }

    const slug = activeInfo.project?.project_slug || getRequestProjectSlug(req, activeInfo);
    const unmaskToken = projectManager.sessionManager.issueUnmaskToken(slug, req.projectUser._id, table, column);
    return res.json({ success: true, authorized: true, method: result.method, unmaskToken });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

async function handleSetColumnSecurity(req, res) {
  try {
    const { engine } = await getActiveProject(req);
    const { table, column, secret } = req.body || {};
    const result = await engine.auth.setColumnSecurity({ table, column, secret });
    res.json({ success: true, message: result.message });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
}

authRouter.post('/verify-unmask', requireProjectAuth, handleVerifyUnmask);
authRouter.post('/set-column-security', requireProjectAuth, requireProjectAdmin, handleSetColumnSecurity);
schemaRouter.post('/auth/verify-unmask', handleVerifyUnmask);
schemaRouter.post('/auth/set-column-security', requireProjectAdmin, handleSetColumnSecurity);

/**
 * POST /api/_sutram/auth/login
 * Validates in-project user (supports blank password) & issues signed project session token
 */
async function handleProjectUserLogin(req, res) {
  try {
    const activeInfo = await getActiveProject(req);
    const slug = activeInfo.project?.project_slug || getRequestProjectSlug(req, activeInfo);

    if (req.masterUser && !projectManager.userHasProjectAccess(req.masterUser._id, slug)) {
      return res.status(403).json({ success: false, error: 'You do not have access to this project.' });
    }
    if (req.lanSession && req.lanSession.projectId && req.lanSession.projectId !== slug) {
      return res.status(403).json({ success: false, error: 'LAN token does not grant access to this project.' });
    }

    const { username, password = '' } = req.body || {};
    if (!username || !String(username).trim()) {
      return res.status(400).json({ success: false, error: 'यूज़रनेम आवश्यक है (Username is required)' });
    }

    const authRes = await activeInfo.engine.auth.verifyLogin(username, password);
    if (!authRes) {
      return res.status(401).json({ success: false, error: 'अमान्य यूज़रनेम या पासवर्ड (Invalid username or password)' });
    }

    const projectToken = projectManager.sessionManager.issueProjectToken(slug, authRes.user);
    return res.json({
      success: true,
      result: {
        user: {
          ...authRes.user,
          can_ocr: authRes.user.can_ocr === 1
        },
        rights: authRes.rights,
        token: projectToken,
        projectSlug: slug
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * GET /api/_sutram/auth/me
 * Validates active project session token and returns live user + table rights
 */
async function handleGetProjectUserMe(req, res) {
  try {
    res.json({
      success: true,
      result: {
        user: {
          ...req.projectUser,
          can_ocr: req.projectUser.can_ocr === 1
        },
        rights: req.projectRights || [],
        projectSlug: req.activeProjectInfo?.project?.project_slug
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

authRouter.post('/login', requireMasterAuth({ allowLan: true }), handleProjectUserLogin);
authRouter.get('/me', requireProjectAuth, handleGetProjectUserMe);
schemaRouter.post('/auth/login', handleProjectUserLogin);
schemaRouter.get('/auth/me', handleGetProjectUserMe);

/**
 * POST /api/_sutram/seed-demo
 * Seeds starter tables in the active project database
 */
schemaRouter.post('/seed-demo', requireProjectAdmin, async (req, res) => {
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
reminderRouter.use(requireProjectAuth);

reminderRouter.get('/rules', async (req, res) => {
  try {
    const { engine } = await getActiveProject(req);
    const rules = await engine.reminder.getRules(req.query);
    res.json({ success: true, count: rules.length, result: rules });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

reminderRouter.post('/rules', requireProjectAdmin, async (req, res) => {
  try {
    const { engine } = await getActiveProject(req);
    const ruleId = await engine.reminder.createRule(req.body);
    const newRule = await engine.reminder.getRuleById(ruleId);
    res.json({ success: true, message: 'Reminder rule created', ruleId, result: newRule });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

reminderRouter.put('/rules/:id', requireProjectAdmin, async (req, res) => {
  try {
    const { engine } = await getActiveProject(req);
    await engine.reminder.updateRule(req.params.id, req.body);
    const updated = await engine.reminder.getRuleById(req.params.id);
    res.json({ success: true, message: 'Reminder rule updated', result: updated });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

reminderRouter.delete('/rules/:id', requireProjectAdmin, async (req, res) => {
  try {
    const { engine } = await getActiveProject(req);
    const deleted = await engine.reminder.deleteRule(req.params.id);
    res.json({ success: true, message: `Rule ${req.params.id} deleted`, deleted });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

reminderRouter.post('/test', requireProjectAdmin, async (req, res) => {
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
    const user = req.projectUser?.username || req.body?.user || 'admin';
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
app.use(['/_sutram/excel', '/api/_sutram/excel', '/api/sutram/excel'], requireProjectAuth, async (req, res, next) => {
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
app.use(['/_sutram/vision', '/api/_sutram/vision', '/api/sutram/vision'], requireProjectAuth, async (req, res, next) => {
  try {
    const { engine } = await getActiveProject(req);
    if (req.projectUser && req.projectUser.role !== 'admin' && req.projectUser.can_ocr !== 1) {
      return res.status(403).json({ success: false, error: 'AI Vision OCR permission is disabled for your user account.' });
    }
    req.sutramEngine = engine;
    req.projectDb = engine.db || null;
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
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
  return requireProjectAuth(req, res, async () => {
    try {
      const { engine } = await getActiveProject(req);
      return engine.router()(req, res, next);
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
});

// ─────────────────────────────────────────────────────────────
// 9. Root & Healthcheck (Serve Angular Single Page App on `/`)
// ─────────────────────────────────────────────────────────────
async function sendApiStatus(req, res) {
  const masterToken = extractBearerOrHeader(req, 'x-master-token');
  const validMaster = masterToken ? projectManager.sessionManager.verifyToken(masterToken, 'master') : null;
  const payload = {
    app: 'Sutram Multi-Project Universal ERP Engine Platform',
    status: 'online',
    frontend: fs.existsSync(path.join(uiDistPath, 'index.html')) ? 'Integrated SutramUI Production Bundle' : 'SutramUI Dev Server (port 4300)'
  };
  if (validMaster) {
    payload.projectsCount = projectManager.listProjects(validMaster.username).length;
  }
  res.json(payload);
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
lanRouter.get('/status', masterAuthStrict, (req, res) => {
  try {
    const nodeInfo = sutramLan.getNodeInfo();
    const peers = sutramLan.getPeers();
    res.json({ success: true, node: nodeInfo, peersCount: peers.length, peers });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/_sutram/lan/peers - Discovered peers on local Wi-Fi / LAN
lanRouter.get('/peers', masterAuthStrict, (req, res) => {
  try {
    const peers = sutramLan.getPeers();
    res.json({ success: true, count: peers.length, result: peers });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/_sutram/lan/share - Toggle project sharing on LAN
lanRouter.post('/share', masterAuthStrict, async (req, res) => {
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
lanRouter.post('/unshare', masterAuthStrict, (req, res) => {
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
updateRouter.use(masterAuthStrict, (req, res, next) => {
  if (req.masterUser.role !== 'superadmin' && req.masterUser.role !== 'admin') {
    return res.status(403).json({ success: false, error: 'Superadmin/Admin privileges required for system updates.' });
  }
  return next();
});

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

module.exports = { app, server, projectManager, getActiveProject, sutramLan };
