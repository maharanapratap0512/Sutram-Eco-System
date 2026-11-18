#!/usr/bin/env node
/**
 * build-portable.js — Direct Portable Launcher (Default) OR Full Self-Contained Bundle (--full)
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * DEFAULT MODE (Direct Portable Launcher — ~5-10 MB):
 *   Builds/extracts ONLY the standalone desktop shell so you can drop it beside your
 *   existing `sutram/` folder and double-click to start immediately!
 *     • Windows: releases/Sutram.exe
 *     • macOS  : releases/Sutram Dynamic ERP.app  (+ optional --dmg for a tiny launcher DMG)
 *
 * FULL BUNDLE MODE (--full):
 *   Packages the complete `releases/staging/` folder (exe/app + dist + server + packages +
 *   node_modules + Node runtime + SutramData) into a single pendrive archive:
 *     • Windows: releases/Sutram-Portable-v<ver>-win-<arch>.zip
 *     • macOS  : releases/Sutram-Portable-v<ver>-mac-<arch>.dmg (or --zip-only)
 *
 * Flags:
 *   --skip-tauri  Reuse already-built Tauri binary without re-running cargo/tauri build
 *   --dmg         On macOS default mode, also wrap `Sutram Dynamic ERP.app` in a lightweight .dmg
 *   --full        Package the complete self-contained bundle from releases/staging/
 *   --prepare     With --full, auto-run prepare-bundle.js first
 *   --zip         With --full on macOS, also create a .zip alongside .dmg
 *   --zip-only    With --full on macOS, create only .zip (skip hdiutil .dmg)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RELEASES_DIR = path.join(ROOT, 'releases');
const STAGING_DIR = path.join(RELEASES_DIR, 'staging');
const MANIFEST_PATH = path.join(STAGING_DIR, 'bundle-manifest.json');

const args = new Set(process.argv.slice(2));
const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const arch = process.arch;

function getAppVersion() {
  try {
    const conf = JSON.parse(fs.readFileSync(path.join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8'));
    if (conf.version) return conf.version;
  } catch {}
  return '2.0.0';
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

function buildDirectPortableLauncher() {
  const ver = getAppVersion();
  fs.mkdirSync(RELEASES_DIR, { recursive: true });

  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Mode 1: Direct Portable Launcher — Sutram v${ver}`);
  console.log('  (Drop next to your sutram/ folder & double-click to start)');
  console.log('═══════════════════════════════════════════════════════════');

  // Ensure sutram/dist/ exists for Tauri compile check (minimal check)
  if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    console.log('ℹ️  sutram/dist/ missing — building Angular UI first...');
    execSync('npx ng build', {
      cwd: path.join(ROOT, 'sutramUI'),
      stdio: 'inherit',
      env: { ...process.env, CI: 'true', NG_CLI_ANALYTICS: 'false' },
    });
  }

  let tauriBin = findTauriBinary();
  if (!args.has('--skip-tauri') || !tauriBin) {
    const cmd = isMac ? 'npx tauri build --bundles app' : 'npx tauri build --no-bundle';
    console.log(`\n🔨 Building Tauri native shell: ${cmd}`);
    execSync(cmd, { cwd: ROOT, stdio: 'inherit' });
    tauriBin = findTauriBinary();
  } else {
    console.log(`ℹ️  Reusing existing built shell (--skip-tauri): ${path.basename(tauriBin)}`);
  }

  if (!tauriBin) {
    throw new Error('Tauri binary not found after build.');
  }

  if (isWin) {
    const outExe = path.join(RELEASES_DIR, 'Sutram.exe');
    fs.copyFileSync(tauriBin, outExe);
    const mb = (fs.statSync(outExe).size / (1024 * 1024)).toFixed(1);
    console.log(`\n✅ Direct Portable Windows EXE ready (${mb} MB):\n   ${outExe}`);
    console.log('   Usage: Place Sutram.exe beside your `sutram/` folder and double-click to run!');
    return;
  }

  if (isMac) {
    const outApp = path.join(RELEASES_DIR, 'Sutram Dynamic ERP.app');
    if (fs.existsSync(outApp)) fs.rmSync(outApp, { recursive: true, force: true });
    const res = spawnSync('ditto', [tauriBin, outApp], { stdio: 'inherit' });
    if (res.status !== 0) throw new Error('ditto failed copying macOS .app bundle');

    console.log(`\n✅ Direct Portable macOS App ready:\n   ${outApp}`);
    console.log('   Usage: Place "Sutram Dynamic ERP.app" beside your `sutram/` folder and double-click to run!');

    if (args.has('--dmg')) {
      const outDmg = path.join(RELEASES_DIR, `Sutram-Launcher-v${ver}-mac-${arch}.dmg`);
      if (fs.existsSync(outDmg)) fs.unlinkSync(outDmg);
      const tmpSrc = path.join(RELEASES_DIR, '_mac_launcher_dmg');
      if (fs.existsSync(tmpSrc)) fs.rmSync(tmpSrc, { recursive: true, force: true });
      fs.mkdirSync(tmpSrc, { recursive: true });
      try {
        spawnSync('ditto', [outApp, path.join(tmpSrc, 'Sutram Dynamic ERP.app')], { stdio: 'inherit' });
        execSync(
          `hdiutil create -volname "Sutram Launcher v${ver}" -srcfolder "${tmpSrc}" -ov -format UDZO "${outDmg}"`,
          { stdio: 'inherit' }
        );
        const mb = (fs.statSync(outDmg).size / (1024 * 1024)).toFixed(1);
        console.log(`✅ Lightweight Launcher DMG created (${mb} MB):\n   ${outDmg}`);
      } finally {
        fs.rmSync(tmpSrc, { recursive: true, force: true });
      }
    }
    return;
  }

  throw new Error(`Unsupported platform: ${process.platform}`);
}

function buildFullPortableArchive() {
  if (args.has('--prepare') || !fs.existsSync(MANIFEST_PATH)) {
    console.log('ℹ️  Staging bundle not found (or --prepare specified). Running prepare-bundle.js...');
    execSync('node scripts/prepare-bundle.js', { cwd: ROOT, stdio: 'inherit' });
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const ver = manifest.version || getAppVersion();
  const targetArch = manifest.arch || arch;

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(`  Packaging Full Self-Contained Portable Bundle — Sutram v${ver}`);
  console.log('═══════════════════════════════════════════════════════════');

  if (isWin) {
    const outZip = path.join(RELEASES_DIR, `Sutram-Portable-Full-v${ver}-win-${targetArch}.zip`);
    if (fs.existsSync(outZip)) fs.unlinkSync(outZip);

    const tempWrap = path.join(RELEASES_DIR, '_portable_wrap');
    if (fs.existsSync(tempWrap)) fs.rmSync(tempWrap, { recursive: true, force: true });
    const innerDir = path.join(tempWrap, 'SutramPortable');
    fs.mkdirSync(tempWrap, { recursive: true });
    fs.cpSync(STAGING_DIR, innerDir, { recursive: true });

    try {
      console.log(`📦 Creating ${path.basename(outZip)}...`);
      const tarRes = spawnSync('tar.exe', ['-a', '-c', '-f', outZip, '-C', tempWrap, 'SutramPortable'], { stdio: 'inherit' });
      if (tarRes.status !== 0) {
        execSync(
          `powershell -NoProfile -Command "Compress-Archive -Path '${innerDir}' -DestinationPath '${outZip}' -Force"`,
          { stdio: 'inherit' }
        );
      }
      const mb = (fs.statSync(outZip).size / (1024 * 1024)).toFixed(1);
      console.log(`\n✅ Full Portable Windows ZIP created (${mb} MB):\n   ${outZip}`);
    } finally {
      fs.rmSync(tempWrap, { recursive: true, force: true });
    }
    return;
  }

  if (isMac) {
    const outDmg = path.join(RELEASES_DIR, `Sutram-Portable-Full-v${ver}-mac-${targetArch}.dmg`);
    if (fs.existsSync(outDmg)) fs.unlinkSync(outDmg);

    const dmgSrc = path.join(RELEASES_DIR, '_mac_dmg_src');
    if (fs.existsSync(dmgSrc)) fs.rmSync(dmgSrc, { recursive: true, force: true });
    const portableFolder = path.join(dmgSrc, 'SutramPortable');
    fs.mkdirSync(dmgSrc, { recursive: true });

    const dittoRes = spawnSync('ditto', [STAGING_DIR, portableFolder], { stdio: 'inherit' });
    if (dittoRes.status !== 0) throw new Error('ditto failed preparing macOS DMG source');

    fs.writeFileSync(
      path.join(dmgSrc, 'HOW_TO_USE.txt'),
      [
        `Sutram Dynamic ERP v${ver} — Full Portable macOS Bundle`,
        '=========================================================',
        '1. Copy the "SutramPortable" folder to your preferred location.',
        '2. Open "SutramPortable" and double-click "Sutram Dynamic ERP.app".',
        '3. All databases stay safely in SutramPortable/SutramData/.',
      ].join('\n'),
      'utf8'
    );

    const zipOnly = args.has('--zip-only');
    try {
      if (!zipOnly) {
        console.log(`📦 Creating ${path.basename(outDmg)}...`);
        execSync(
          `hdiutil create -volname "Sutram Portable v${ver}" -srcfolder "${dmgSrc}" -ov -format UDZO "${outDmg}"`,
          { stdio: 'inherit' }
        );
        const mb = (fs.statSync(outDmg).size / (1024 * 1024)).toFixed(1);
        console.log(`\n✅ Full Portable macOS DMG created (${mb} MB):\n   ${outDmg}`);
      }

      if (args.has('--zip') || zipOnly) {
        const outZip = path.join(RELEASES_DIR, `Sutram-Portable-Full-v${ver}-mac-${targetArch}.zip`);
        if (fs.existsSync(outZip)) fs.unlinkSync(outZip);
        console.log(`📦 Creating ${path.basename(outZip)}...`);
        const zipRes = spawnSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', portableFolder, outZip], { stdio: 'inherit' });
        if (zipRes.status !== 0) throw new Error('ditto zip creation failed');
        const zmb = (fs.statSync(outZip).size / (1024 * 1024)).toFixed(1);
        console.log(`✅ Full Portable macOS ZIP created (${zmb} MB):\n   ${outZip}`);
      }
    } finally {
      fs.rmSync(dmgSrc, { recursive: true, force: true });
    }
    return;
  }

  throw new Error(`Unsupported platform: ${process.platform}`);
}

try {
  if (args.has('--full')) {
    buildFullPortableArchive();
  } else {
    buildDirectPortableLauncher();
  }
} catch (err) {
  console.error('\n❌ build-portable failed:', err.message);
  process.exit(1);
}
