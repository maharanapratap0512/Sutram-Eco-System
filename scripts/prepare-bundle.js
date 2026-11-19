#!/usr/bin/env node
/**
 * prepare-bundle.js — Cross-Platform Release Staging Builder (Windows + macOS)
 * ──────────────────────────────────────────────────────────────────────────────
 * Builds and stages a complete, self-contained Sutram bundle in:
 *   sutram/releases/staging/
 *     ├── Sutram.exe                    (Windows) / Sutram Dynamic ERP.app (macOS)
 *     ├── SutramData/                   (Clean empty user-data root, or copied via --include-data)
 *     │   └── projects/
 *     └── sutram/
 *         ├── dist/                     (Built Angular UI)
 *         ├── sutramServer/             (Backend Express + SQLite server)
 *         ├── packages/                 (sutramcore, sutramEngine, sutramExcel, sutramLan, sutramVision)
 *         ├── node_modules/             (Production dependencies + FAT32/ZIP-safe local shims)
 *         ├── runtime/                  (Portable Node.js binary matching better-sqlite3 ABI)
 *         └── package.json
 *
 * Flags:
 *   --skip-ui          Reuse existing sutram/dist/ (skip Angular ng build)
 *   --skip-tauri       Reuse existing Tauri .exe/.app (skip cargo/tauri build)
 *   --no-runtime       Do not bundle portable Node.js binary into sutram/runtime/
 *   --include-data     Copy existing ../SutramData into staging (default: clean empty folder)
 *   --platform=win|mac Override target label (informational; builds for host OS)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RELEASES_DIR = path.join(ROOT, 'releases');
const STAGING_DIR = path.join(RELEASES_DIR, 'staging');
const STAGING_APP = path.join(STAGING_DIR, 'sutram');
const STAGING_DATA = path.join(STAGING_DIR, 'SutramData');

const args = new Set(process.argv.slice(2));
const skipUi = args.has('--skip-ui');
const skipTauri = args.has('--skip-tauri');
const noRuntime = args.has('--no-runtime');
const includeData = args.has('--include-data');

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const arch = process.arch; // x64 | arm64

// Packages in sutram/packages/ to include (pure backend/engine packages)
const LOCAL_PACKAGES = [
  { npmName: 'sutramcore', dirName: 'sutramcore' },
  { npmName: 'sutramengine', dirName: 'sutramEngine' },
  { npmName: 'sutramexcel', dirName: 'sutramExcel' },
  { npmName: 'sutramlan', dirName: 'sutramLan' },
  { npmName: 'sutramvision', dirName: 'sutramVision' },
];

// Dev-only packages to exclude from production bundle node_modules
const EXCLUDED_NODE_MODULES = new Set([
  '@tauri-apps',
  'nodemon',
  '.bin',
  '.cache',
  ...LOCAL_PACKAGES.map(p => p.npmName),
]);

function logStep(step, msg) {
  console.log(`\n[${step}] ${msg}`);
}

function run(cmd, cwd = ROOT, envExtra = {}) {
  console.log(`  $ ${cmd}`);
  execSync(cmd, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, ...envExtra },
  });
}

function getAppVersion() {
  try {
    const tauriConf = JSON.parse(fs.readFileSync(path.join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8'));
    if (tauriConf.version) return tauriConf.version;
  } catch {}
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    if (pkg.version) return pkg.version;
  } catch {}
  return '2.0.0';
}

function copyDirClean(src, dest, excludeNames = new Set()) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (excludeNames.has(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirClean(srcPath, destPath, excludeNames);
    } else if (entry.isSymbolicLink()) {
      const target = fs.realpathSync(srcPath);
      const stat = fs.statSync(target);
      if (stat.isDirectory()) {
        copyDirClean(target, destPath, excludeNames);
      } else {
        fs.copyFileSync(target, destPath);
      }
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function findTauriBinary() {
  if (isWin) {
    const candidates = [
      path.join(ROOT, 'src-tauri', 'target', 'release', 'sutram-desktop.exe'),
      path.join(ROOT, 'src-tauri', 'target', 'release', 'Sutram Dynamic ERP.exe'),
      path.join(ROOT, 'src-tauri', 'target', 'release', 'Sutram.exe'),
    ];
    return candidates.find(p => fs.existsSync(p)) || null;
  }
  if (isMac) {
    const candidates = [
      path.join(ROOT, 'src-tauri', 'target', 'release', 'bundle', 'macos', 'Sutram Dynamic ERP.app'),
      path.join(ROOT, 'src-tauri', 'target', 'release', 'bundle', 'macos', 'Sutram.app'),
    ];
    return candidates.find(p => fs.existsSync(p)) || null;
  }
  return null;
}

function copyMacAppBundle(srcApp, destApp) {
  // Use macOS `ditto` to preserve Mach-O permissions, Info.plist, and bundle structure cleanly
  const res = spawnSync('ditto', [srcApp, destApp], { stdio: 'inherit' });
  if (res.status !== 0) {
    throw new Error(`ditto failed copying ${srcApp} to ${destApp}`);
  }
}

function stageNodeRuntime() {
  const runtimeDir = path.join(STAGING_APP, 'runtime');
  fs.mkdirSync(runtimeDir, { recursive: true });

  const nodeBinName = isWin ? 'node.exe' : 'node';
  const destBin = path.join(runtimeDir, nodeBinName);
  const currentNode = process.execPath;
  const nodeVersion = process.versions.node;
  const major = nodeVersion.split('.')[0];

  // Using the exact build host's Node binary guarantees 100% ABI match with better-sqlite3!
  fs.copyFileSync(currentNode, destBin);
  if (!isWin) {
    fs.chmodSync(destBin, 0o755);
  }

  fs.writeFileSync(
    path.join(runtimeDir, 'NODE_VERSION.txt'),
    `${major}\n${nodeVersion}\n`,
    'utf8'
  );

  const sizeMb = (fs.statSync(destBin).size / (1024 * 1024)).toFixed(1);
  console.log(`  ✓ Bundled private Node.js v${nodeVersion} (ABI major ${major}, ${sizeMb} MB) → sutram/runtime/${nodeBinName}`);
  return { nodeVersion, major };
}

function main() {
  const version = getAppVersion();
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Sutram Dynamic ERP v${version} — Release Bundle Staging`);
  console.log(`  Host: ${process.platform} (${arch}) | Node: v${process.versions.node}`);
  console.log('═══════════════════════════════════════════════════════════');

  // ── Step 1: Angular UI Build ──────────────────────────────
  const distIndex = path.join(ROOT, 'dist', 'index.html');
  if (skipUi && fs.existsSync(distIndex)) {
    logStep('1/6', 'Skipping Angular UI build (--skip-ui) — reusing sutram/dist/');
  } else {
    logStep('1/6', 'Building Angular UI into sutram/dist/...');
    const uiDir = path.join(ROOT, 'sutramUI');
    if (!fs.existsSync(path.join(uiDir, 'node_modules'))) {
      run('npm install --legacy-peer-deps', uiDir);
    }
    run('npx ng build', uiDir, {
      CI: 'true',
      NG_CLI_ANALYTICS: 'false',
      ...(isMac ? { HOME: process.env.HOME || '/tmp' } : {}),
    });
  }
  if (!fs.existsSync(distIndex)) {
    throw new Error('Angular build output missing at sutram/dist/index.html');
  }

  // ── Step 2: Tauri Native Shell Build ──────────────────────
  let tauriBin = findTauriBinary();
  if (skipTauri && tauriBin) {
    logStep('2/6', `Skipping Tauri build (--skip-tauri) — reusing ${path.basename(tauriBin)}`);
  } else {
    logStep('2/6', 'Building Tauri native desktop shell...');
    const tauriCmd = isMac ? 'npx tauri build --bundles app' : 'npx tauri build --no-bundle';
    run(tauriCmd, ROOT);
    tauriBin = findTauriBinary();
  }
  if (!tauriBin) {
    throw new Error('Built Tauri binary not found. Run `npm run build:tauri` first or remove --skip-tauri.');
  }

  // ── Step 3: Clean & Create Staging Directory ──────────────
  logStep('3/6', 'Preparing clean staging directory (releases/staging/)...');
  if (fs.existsSync(STAGING_DIR)) {
    fs.rmSync(STAGING_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(STAGING_APP, { recursive: true });
  fs.mkdirSync(path.join(STAGING_DATA, 'projects'), { recursive: true });

  // Place desktop shell at root OUTSIDE sutram/
  if (isWin) {
    fs.copyFileSync(tauriBin, path.join(STAGING_DIR, 'Sutram.exe'));
    console.log('  ✓ Copied Sutram.exe to staging root');
  } else if (isMac) {
    copyMacAppBundle(tauriBin, path.join(STAGING_DIR, 'Sutram Dynamic ERP.app'));
    console.log('  ✓ Copied Sutram Dynamic ERP.app to staging root');
  }

  // Optionally include existing SutramData
  if (includeData) {
    const existingData = path.resolve(ROOT, '..', 'SutramData');
    if (fs.existsSync(existingData)) {
      copyDirClean(existingData, STAGING_DATA, new Set(['.DS_Store', 'Thumbs.db']));
      console.log('  ✓ Included existing SutramData (--include-data)');
    }
  } else {
    fs.writeFileSync(
      path.join(STAGING_DATA, 'README.txt'),
      'SutramData stores your SQLite databases (master.db & projects/*.db).\nKeep this folder safe when upgrading or backing up Sutram.\n',
      'utf8'
    );
  }

  // ── Step 4: Copy dist/, sutramServer/, packages/, package.json ──
  logStep('4/6', 'Copying dist/, sutramServer/, and packages/...');
  const junk = new Set(['.DS_Store', 'Thumbs.db', 'node_modules', 'test', 'tests', '.git', 'data', 'temp_uploads', 'temp_updates']);

  copyDirClean(path.join(ROOT, 'dist'), path.join(STAGING_APP, 'dist'), new Set(['.DS_Store', 'Thumbs.db']));
  copyDirClean(path.join(ROOT, 'sutramServer'), path.join(STAGING_APP, 'sutramServer'), junk);

  for (const pkg of LOCAL_PACKAGES) {
    copyDirClean(
      path.join(ROOT, 'packages', pkg.dirName),
      path.join(STAGING_APP, 'packages', pkg.dirName),
      junk
    );
  }

  // Write clean production package.json
  const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const prodPkg = {
    name: rootPkg.name,
    version,
    description: rootPkg.description,
    private: true,
    scripts: { start: 'node sutramServer/server.js' },
    dependencies: rootPkg.dependencies,
  };
  fs.writeFileSync(path.join(STAGING_APP, 'package.json'), JSON.stringify(prodPkg, null, 2), 'utf8');
  console.log('  ✓ App code & UI staged');

  // ── Step 5: Stage Production node_modules + Symlink-Free Local Shims ──
  logStep('5/6', 'Staging production node_modules (zero symlinks — FAT32/ZIP/Installer safe)...');
  const srcNodeModules = path.join(ROOT, 'node_modules');
  const destNodeModules = path.join(STAGING_APP, 'node_modules');
  if (!fs.existsSync(srcNodeModules)) {
    throw new Error('sutram/node_modules not found! Run `npm install --legacy-peer-deps` in sutram/ first.');
  }
  copyDirClean(srcNodeModules, destNodeModules, EXCLUDED_NODE_MODULES);

  // Create clean 1-line forwarding shims for local packages (no symlinks needed, OTA-safe!)
  for (const pkg of LOCAL_PACKAGES) {
    const shimDir = path.join(destNodeModules, pkg.npmName);
    fs.mkdirSync(shimDir, { recursive: true });
    fs.writeFileSync(
      path.join(shimDir, 'package.json'),
      JSON.stringify({ name: pkg.npmName, version: '1.0.0', main: 'index.js' }, null, 2),
      'utf8'
    );
    fs.writeFileSync(
      path.join(shimDir, 'index.js'),
      `'use strict';\nmodule.exports = require('../../packages/${pkg.dirName}');\n`,
      'utf8'
    );
  }
  console.log('  ✓ Production node_modules + local package shims staged');

  // ── Step 6: Bundle Portable Node.js Runtime ───────────────
  let runtimeInfo = null;
  if (noRuntime) {
    logStep('6/6', 'Skipping portable Node.js runtime (--no-runtime)');
  } else {
    logStep('6/6', 'Bundling portable Node.js runtime into sutram/runtime/...');
    runtimeInfo = stageNodeRuntime();
  }

  // Write manifest
  const manifest = {
    name: 'Sutram Dynamic ERP',
    version,
    platform: process.platform,
    arch,
    nodeVersion: runtimeInfo?.nodeVersion || process.versions.node,
    nodeMajor: runtimeInfo?.major || process.versions.node.split('.')[0],
    hasBundledRuntime: !noRuntime,
    builtAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(STAGING_DIR, 'bundle-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  console.log('\n✅ Staging bundle ready at: sutram/releases/staging/');
  console.log('   Next steps:');
  console.log('   • Portable package : npm run build:portable');
  if (isWin) {
    console.log('   • Windows Installer: npm run build:installer');
  }
}

try {
  main();
} catch (err) {
  console.error('\n❌ prepare-bundle failed:', err.message);
  process.exit(1);
}
