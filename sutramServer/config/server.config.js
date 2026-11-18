/**
 * server.config.js
 * ─────────────────────────────────────────────────────────────
 * Configuration file for Sutram Standalone ERP Engine Server.
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

const path = require('path');

const defaultDataDir = process.env.SUTRAM_DATA_DIR || path.resolve(__dirname, '../../../SutramData');

module.exports = {
  // Server Port (isolated from HisabKitab 3200 / Angular 4200)
  port: parseInt(process.env.PORT || '3300', 10),

  // External User Data Directory (kept outside sutram code folder for safe upgrades & portability)
  dataDir: defaultDataDir,

  // Database location (pure standalone SQLite database)
  dbPath: process.env.DB_PATH || path.resolve(defaultDataDir, 'sutram-erp.db'),

  // Dialect: 'sqlite' | 'mysql'
  dialect: process.env.DB_DIALECT || 'sqlite',

  // Mode: 'managed' (Pattern 3: schema lives in sys_ tables, zero static code)
  mode: 'managed',

  // Excel Studio & Dynamic ERP UI Configuration
  excel: {
    enabled: true,
    routePrefix: '/_sutram/excel',
    studioRoute: '/studio',
    autoRegisterAll: true // Auto-discover and register all user tables into Excel Studio
  },

  // CORS Configuration
  cors: {
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'x-project-slug', 'x-master-user', 'x-lan-token', 'Accept']
  }
};
