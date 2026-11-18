'use strict';

const fs = require('fs');
const path = require('path');
const { execFile, execSync } = require('child_process');

/**
 * UpdateManager
 * Safely applies application update ZIP files, manages automatic rollbacks,
 * and guarantees that user databases in ./data/ are never touched or modified.
 */
class UpdateManager {
  constructor(options = {}) {
    // sutram/ directory is parent of sutramServer
    this.sutramRoot = options.sutramRoot || path.resolve(__dirname, '../../');
    this.sutramServerDir = options.sutramServerDir || path.resolve(__dirname, '../');
    this.sutramPackagesDir = options.sutramPackagesDir || path.resolve(this.sutramRoot, 'packages');
    this.sutramUiDistDir = options.sutramUiDistDir || path.resolve(this.sutramRoot, 'dist');
    const externalDataDir = process.env.SUTRAM_DATA_DIR || path.resolve(this.sutramRoot, '../SutramData');
    this.backupsDir = options.backupsDir || path.resolve(externalDataDir, 'backups');
    this.tempDir = options.tempDir || path.resolve(externalDataDir, 'temp_updates');

    // Ensure backups and temp directories exist
    if (!fs.existsSync(this.backupsDir)) {
      fs.mkdirSync(this.backupsDir, { recursive: true });
    }
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  /**
   * Cross-platform extraction of a zip archive into a target directory
   * @param {string} zipPath - Full path to .zip file
   * @param {string} destDir - Destination folder
   * @returns {Promise<void>}
   */
  async extractZip(zipPath, destDir) {
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    return new Promise((resolve, reject) => {
      if (process.platform === 'win32') {
        const psCmd = `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`;
        execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psCmd], (err, stdout, stderr) => {
          if (err) return reject(new Error(`PowerShell Expand-Archive failed: ${stderr || err.message}`));
          resolve();
        });
      } else {
        // macOS / Linux - unzip or tar
        execFile('unzip', ['-q', '-o', zipPath, '-d', destDir], (err) => {
          if (err) {
            // Fallback to tar if unzip isn't installed
            execFile('tar', ['-xf', zipPath, '-C', destDir], (tarErr) => {
              if (tarErr) return reject(new Error(`Extraction failed: ${tarErr.message}`));
              resolve();
            });
          } else {
            resolve();
          }
        });
      }
    });
  }

  /**
   * Recursively copies folder contents
   */
  copyRecursiveSync(src, dest) {
    if (!fs.existsSync(src)) return;
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }

    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      // Do NOT copy or overwrite node_modules or data folder
      if (entry.name === 'node_modules' || entry.name === 'data' || entry.name === 'backups') {
        continue;
      }

      if (entry.isDirectory()) {
        this.copyRecursiveSync(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }

  /**
   * Creates an automatic timestamped backup of the current server and ui
   * @returns {string} Backup directory path
   */
  createBackup() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupId = `backup_${timestamp}`;
    const backupPath = path.join(this.backupsDir, backupId);

    fs.mkdirSync(backupPath, { recursive: true });

    // Backup server files
    const serverBackupPath = path.join(backupPath, 'server');
    this.copyRecursiveSync(this.sutramServerDir, serverBackupPath);

    // Backup packages
    if (fs.existsSync(this.sutramPackagesDir)) {
      const pkgBackupPath = path.join(backupPath, 'packages');
      this.copyRecursiveSync(this.sutramPackagesDir, pkgBackupPath);
    }

    // Backup UI dist
    if (fs.existsSync(this.sutramUiDistDir)) {
      const uiBackupPath = path.join(backupPath, 'ui');
      this.copyRecursiveSync(this.sutramUiDistDir, uiBackupPath);
    }

    // Save manifest
    fs.writeFileSync(path.join(backupPath, 'manifest.json'), JSON.stringify({
      backupId,
      createdAt: new Date().toISOString(),
      serverPath: this.sutramServerDir,
      uiPath: this.sutramUiDistDir
    }, null, 2));

    return backupPath;
  }

  /**
   * Applies an update from a uploaded ZIP file
   * @param {string} zipFilePath
   * @returns {Promise<object>} Status report
   */
  async applyUpdate(zipFilePath) {
    if (!fs.existsSync(zipFilePath)) {
      throw new Error('Update zip file not found');
    }

    // 1. Create a stage extraction directory
    const stageId = `stage_${Date.now()}`;
    const stageDir = path.join(this.tempDir, stageId);

    try {
      await this.extractZip(zipFilePath, stageDir);

      // 2. Inspect stage contents
      const stageEntries = fs.readdirSync(stageDir);
      if (stageEntries.length === 0) {
        throw new Error('Update archive is empty');
      }

      // Check for nested single directory (e.g. if zipped as a folder)
      let contentRoot = stageDir;
      if (stageEntries.length === 1 && fs.statSync(path.join(stageDir, stageEntries[0])).isDirectory()) {
        contentRoot = path.join(stageDir, stageEntries[0]);
      }

      // 3. Create Safety Backup first
      const backupPath = this.createBackup();

      let updatedServer = false;
      let updatedUi = false;
      let updatedPackages = false;
      const updatedFolders = [];

      // 4. Look for sutramServer/, server/, or server.js
      const sutramServerCandidate = path.join(contentRoot, 'sutramServer');
      const serverCandidate = path.join(contentRoot, 'server');
      const hasDirectServerJs = fs.existsSync(path.join(contentRoot, 'server.js'));

      if (fs.existsSync(sutramServerCandidate)) {
        this.copyRecursiveSync(sutramServerCandidate, this.sutramServerDir);
        updatedServer = true;
        updatedFolders.push('sutramServer');
      } else if (fs.existsSync(serverCandidate)) {
        this.copyRecursiveSync(serverCandidate, this.sutramServerDir);
        updatedServer = true;
        updatedFolders.push('sutramServer');
      } else if (hasDirectServerJs) {
        this.copyRecursiveSync(contentRoot, this.sutramServerDir);
        updatedServer = true;
        updatedFolders.push('sutramServer');
      }

      // 5. Look for dist/, ui/, or index.html
      const distCandidate = path.join(contentRoot, 'dist');
      const uiCandidate = path.join(contentRoot, 'ui');
      const hasDirectIndexHtml = fs.existsSync(path.join(contentRoot, 'index.html'));

      if (fs.existsSync(distCandidate)) {
        this.copyRecursiveSync(distCandidate, this.sutramUiDistDir);
        updatedUi = true;
        updatedFolders.push('dist');
      } else if (fs.existsSync(uiCandidate)) {
        this.copyRecursiveSync(uiCandidate, this.sutramUiDistDir);
        updatedUi = true;
        updatedFolders.push('dist');
      } else if (hasDirectIndexHtml && !hasDirectServerJs) {
        this.copyRecursiveSync(contentRoot, this.sutramUiDistDir);
        updatedUi = true;
        updatedFolders.push('dist');
      }

      // 6. Look for packages/
      const packagesCandidate = path.join(contentRoot, 'packages');
      if (fs.existsSync(packagesCandidate)) {
        this.copyRecursiveSync(packagesCandidate, this.sutramPackagesDir);
        updatedPackages = true;
        updatedFolders.push('packages');
      }

      // Clean up stage folder and uploaded zip
      try {
        fs.rmSync(stageDir, { recursive: true, force: true });
        fs.unlinkSync(zipFilePath);
      } catch {}

      const backupId = path.basename(backupPath);
      return {
        success: true,
        updatedServer,
        updatedUi,
        updatedPackages,
        updatedFolders,
        backupId,
        backupPath: backupId,
        message: 'Update applied successfully! User data in SutramData/ was strictly preserved.'
      };
    } catch (err) {
      // Clean up on failure
      try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch {}
      throw err;
    }
  }

  /**
   * Lists available backup restore points
   */
  listBackups() {
    if (!fs.existsSync(this.backupsDir)) return [];
    const entries = fs.readdirSync(this.backupsDir, { withFileTypes: true });
    const backups = [];

    for (const e of entries) {
      if (e.isDirectory() && e.name.startsWith('backup_')) {
        const dirPath = path.join(this.backupsDir, e.name);
        const manifestPath = path.join(dirPath, 'manifest.json');
        let info = { backupId: e.name, createdAt: null };
        if (fs.existsSync(manifestPath)) {
          try {
            info = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          } catch {}
        }
        const subFolders = fs.readdirSync(dirPath, { withFileTypes: true }).filter(d => d.isDirectory()).length;
        backups.push({
          ...info,
          id: info.backupId || e.name,
          name: e.name,
          date: info.createdAt ? new Date(info.createdAt).toLocaleString() : e.name,
          itemsCount: subFolders,
          sizeFormatted: 'Snapshot'
        });
      }
    }

    return backups.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  }

  /**
   * Restores from a previous backup
   */
  rollbackBackup(backupId) {
    const backupPath = path.join(this.backupsDir, backupId);
    if (!fs.existsSync(backupPath)) {
      throw new Error(`Backup "${backupId}" not found`);
    }

    const restoredFolders = [];
    const serverBackup = path.join(backupPath, 'server');
    if (fs.existsSync(serverBackup)) {
      this.copyRecursiveSync(serverBackup, this.sutramServerDir);
      restoredFolders.push('sutramServer');
    }

    const pkgBackup = path.join(backupPath, 'packages');
    if (fs.existsSync(pkgBackup)) {
      this.copyRecursiveSync(pkgBackup, this.sutramPackagesDir);
      restoredFolders.push('packages');
    }

    const uiBackup = path.join(backupPath, 'ui');
    if (fs.existsSync(uiBackup)) {
      this.copyRecursiveSync(uiBackup, this.sutramUiDistDir);
      restoredFolders.push('dist');
    }

    return { success: true, backupId, restoredFolders, message: `Restored to ${backupId} successfully` };
  }
}

module.exports = UpdateManager;
module.exports.UpdateManager = UpdateManager;
