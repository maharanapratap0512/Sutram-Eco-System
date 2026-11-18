#!/usr/bin/env node
'use strict';

/**
 * make-update.js
 * ─────────────────────────────────────────────────────────────
 * Builds Angular frontend into ../dist and packages ONLY:
 *   - sutramServer/
 *   - packages/ (excluding node_modules, docs, old public caches)
 *   - dist/
 * into a clean, lightweight update ZIP ready for Sutram's in-app Updater.
 *
 * Usage:
 *   npm run make-update              (builds Angular + creates ZIP)
 *   npm run make-update -- --skip-build  (uses existing dist/)
 * ─────────────────────────────────────────────────────────────
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const sutramRoot = path.resolve(__dirname, '..');
const skipBuild = process.argv.includes('--skip-build');
const outDir = path.resolve(sutramRoot, 'releases');

if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

if (!skipBuild) {
  console.log('🔨 Building Angular production bundle into sutram/dist/ ...');
  execSync('npx ng build', {
    cwd: path.join(sutramRoot, 'sutramUI'),
    stdio: 'inherit',
    env: { ...process.env, CI: 'true', NG_CLI_ANALYTICS: 'false' }
  });
}

if (!fs.existsSync(path.join(sutramRoot, 'dist', 'index.html'))) {
  console.error('❌ Error: sutram/dist/index.html not found! Run without --skip-build.');
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(path.join(sutramRoot, 'package.json'), 'utf8'));
const stamp = new Date().toISOString().slice(0, 10);
const zipName = `sutram-update-v${pkg.version || '2.0.0'}-${stamp}.zip`;
const zipPath = path.join(outDir, zipName);

if (fs.existsSync(zipPath)) {
  fs.unlinkSync(zipPath);
}

console.log(`📦 Creating lightweight update package: releases/${zipName} ...`);

if (process.platform === 'win32') {
  const stageDir = path.join(outDir, '_stage_zip');
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });

  const copyFiltered = (src, dest) => {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      if (['node_modules', 'data', 'backups', '.git', '.DS_Store', 'public', 'test.db'].includes(entry.name)) continue;
      const s = path.join(src, entry.name);
      const d = path.join(dest, entry.name);
      if (entry.isDirectory()) copyFiltered(s, d);
      else fs.copyFileSync(s, d);
    }
  };

  copyFiltered(path.join(sutramRoot, 'sutramServer'), path.join(stageDir, 'sutramServer'));
  copyFiltered(path.join(sutramRoot, 'packages'), path.join(stageDir, 'packages'));
  copyFiltered(path.join(sutramRoot, 'dist'), path.join(stageDir, 'dist'));

  execSync(`powershell -NoProfile -Command "Compress-Archive -Path '${stageDir}\\*' -DestinationPath '${zipPath}' -Force"`, { stdio: 'inherit' });
  fs.rmSync(stageDir, { recursive: true, force: true });
} else {
  execSync(
    `zip -r -q "${zipPath}" sutramServer packages dist -x "*/node_modules/*" "*/data/*" "*/.DS_Store" "packages/sutramExcel/public/*" "packages/ng-sutramui-*/*" "packages/docs/*" "*.db" "*.db-wal" "*.db-shm"`,
    { cwd: sutramRoot, stdio: 'inherit' }
  );
}

const sizeMb = (fs.statSync(zipPath).size / (1024 * 1024)).toFixed(2);
console.log(`✅ Update ZIP ready: ${zipPath} (${sizeMb} MB)`);
console.log('💡 Upload this ZIP inside Sutram App -> Updates -> Apply Update.');
