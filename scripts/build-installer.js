#!/usr/bin/env node
/**
 * build-installer.js — Windows Full Installable Setup Wizard Builder (Inno Setup 6)
 * ──────────────────────────────────────────────────────────────────────────────
 * Compiles sutram/installer/sutram-setup.iss using Inno Setup (ISCC.exe) to produce:
 *   sutram/releases/Sutram-Setup-v<ver>-win-<arch>.exe
 *
 * Features of the generated installer:
 *   - Prompts user for Installation Folder Path (default: C:\Sutram — fully writable!)
 *   - Places Sutram.exe, SutramData/ (safe on upgrade/uninstall), and sutram/ in that folder
 *   - Checks system Node.js version & ABI compatibility automatically:
 *       • If compatible Node (matching better-sqlite3 ABI) exists -> uses system Node
 *       • If missing or incompatible version -> automatically extracts bundled sutram/runtime/node.exe
 *   - Creates Desktop + Start Menu shortcuts & clean Uninstaller (preserves SutramData/)
 *
 * Note: macOS uses Portable DMG only (skipped cleanly on macOS).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RELEASES_DIR = path.join(ROOT, 'releases');
const STAGING_DIR = path.join(RELEASES_DIR, 'staging');
const MANIFEST_PATH = path.join(STAGING_DIR, 'bundle-manifest.json');
const ISS_SCRIPT = path.join(ROOT, 'installer', 'sutram-setup.iss');

if (process.platform !== 'win32') {
  console.log('\nℹ️  build:installer is for Windows Setup (.exe) only.');
  console.log('   • On macOS, use Portable DMG: `npm run build:portable`');
  console.log('   • To build Windows Installer (.exe) from macOS, trigger GitHub Actions workflow:');
  console.log('     Actions → "Build Windows Desktop Shell & Installers" → Run workflow (build_mode: installer or both)\n');
  process.exit(0);
}

function findIscc() {
  const candidates = [
    process.env.INNO_SETUP_ISCC,
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Inno Setup 6', 'ISCC.exe'),
    'C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe',
    'C:\\Program Files\\Inno Setup 6\\ISCC.exe',
    'ISCC.exe',
  ].filter(Boolean);

  for (const c of candidates) {
    if (c === 'ISCC.exe') {
      const check = spawnSync('where', ['ISCC.exe'], { encoding: 'utf8' });
      if (check.status === 0 && check.stdout.trim()) {
        return check.stdout.trim().split(/\r?\n/)[0];
      }
    } else if (fs.existsSync(c)) {
      return c;
    }
  }
  return null;
}

function main() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    console.log('ℹ️  Staging bundle not found. Running prepare-bundle.js first...');
    execSync('node scripts/prepare-bundle.js', { cwd: ROOT, stdio: 'inherit' });
  }

  const iscc = findIscc();
  if (!iscc) {
    console.error('❌ Inno Setup 6 (ISCC.exe) not found!');
    console.error('   Install Inno Setup 6 from: https://jrsoftware.org/isdl.php');
    console.error('   Or via winget: winget install JRSoftware.InnoSetup');
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const ver = manifest.version || '2.0.0';
  const arch = manifest.arch || 'x64';
  const nodeMajor = manifest.nodeMajor || '20';

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(`  Building Windows Setup Wizard — Sutram v${ver}`);
  console.log(`  Required Node ABI Major: v${nodeMajor} | Compiler: ${iscc}`);
  console.log('═══════════════════════════════════════════════════════════');

  const iconPath = path.join(ROOT, 'src-tauri', 'icons', 'icon.ico');
  const args = [
    `/DAppVersion=${ver}`,
    `/DAppArch=${arch}`,
    `/DRequiredNodeMajor=${nodeMajor}`,
    `/DStagingDir=${STAGING_DIR}`,
    `/DOutputDir=${RELEASES_DIR}`,
    `/DAppIcon=${iconPath}`,
    ISS_SCRIPT,
  ];

  const res = spawnSync(iscc, args, { cwd: ROOT, stdio: 'inherit' });
  if (res.status !== 0) {
    throw new Error(`ISCC.exe exited with status ${res.status}`);
  }

  const outExe = path.join(RELEASES_DIR, `Sutram-Setup-v${ver}-win-${arch}.exe`);
  if (fs.existsSync(outExe)) {
    const mb = (fs.statSync(outExe).size / (1024 * 1024)).toFixed(1);
    console.log(`\n✅ Windows Setup Installer created (${mb} MB):\n   ${outExe}`);
  }
}

try {
  main();
} catch (err) {
  console.error('\n❌ build-installer failed:', err.message);
  process.exit(1);
}
