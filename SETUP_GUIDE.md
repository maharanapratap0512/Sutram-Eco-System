# 🚀 Sutram Eco-System — New PC Setup, Tauri & Build Guide

Complete end-to-end guide for setting up **Sutram Dynamic ERP 2.0** on a brand-new PC (Windows or macOS) — from `git clone` to development, Tauri desktop `.exe`/`.app` builds, portable deployment, and one-click ZIP updates.

---

## 1. Prerequisites (One-Time System Installation)

### A. Required for All Setups (Backend + Web UI)
1. **Git**: [https://git-scm.com/downloads](https://git-scm.com/downloads)
2. **Node.js (v20 LTS recommended)**: [https://nodejs.org](https://nodejs.org)

Verify in terminal:
```bash
node -v    # v20.x.x
npm -v     # 10.x.x
git --version
```

### B. Required ONLY for Tauri Desktop Builds (`.exe` / `.app`)
> If you only want to run Sutram in the browser (`localhost:3300` or `localhost:4300`), you can skip Rust & C++ tools!

#### On Windows 10 / 11:
1. **Microsoft C++ Build Tools**:
   - Download [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/).
   - In the installer, check **"Desktop development with C++"** and install.
2. **Rust Toolchain**:
   - Download & run [`rustup-init.exe`](https://rustup.rs).
   - Press `1` + `Enter` for default installation.
   - Restart PowerShell / Terminal after installation.
3. **WebView2**: Already built into Windows 10/11.

#### On macOS:
1. **Xcode Command Line Tools**:
   ```bash
   xcode-select --install
   ```
2. **Rust Toolchain**:
   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   source "$HOME/.cargo/env"
   ```

Verify Rust:
```bash
rustc --version
cargo --version
```

---

## 2. Clone & Install Dependencies (Only 2 Places!)

You **only** need to run `npm install` in **2 folders** (root and `sutramUI`). You do **NOT** need to run `npm install` inside `sutramServer/` or `packages/*`.

```bash
# 1. Clone repository
git clone https://github.com/maharanapratap0512/Sutram-Eco-System.git
cd Sutram-Eco-System

# 2. Install root dependencies (Backend Server + all Sutram packages + Tauri CLI)
npm install --legacy-peer-deps

# 3. Install Angular UI dependencies
cd sutramUI
npm install --legacy-peer-deps
cd ..
```

> **Note on Tauri CLI**: `@tauri-apps/cli` (v2) is already included in root `package.json`, so step 2 installs it automatically. Verify with:
> ```bash
> npx tauri --version
> ```

---

## 3. Folder Architecture & External `SutramData/`

When you start the server for the first time, Sutram automatically creates **`../SutramData/`** **outside** the code repository folder:

```text
Parent-Folder/
├── SutramData/                 # All user databases & backups (100% outside Git/code!)
│   ├── sutram_master.db        # Master users & portable project registry
│   ├── projects/*.db           # Isolated SQLite workspace databases
│   ├── temp_uploads/           # Temporary uploads
│   └── backups/                # Automatic pre-update snapshots
│
└── Sutram-Eco-System/          # Pure code repository
    ├── dist/                   # Built Angular production UI (output of `npm run ui:build`)
    ├── sutramServer/           # Express backend server (port 3300)
    ├── packages/               # sutramcore, sutramEngine, sutramExcel, sutramLan, sutramVision
    ├── sutramUI/               # Angular dev source (port 4300)
    ├── src-tauri/              # Tauri v2 native desktop shell
    ├── scripts/make-update.js  # 1-click update ZIP generator
    ├── start-portable.bat      # Windows 1-click portable launcher
    └── start-portable.sh       # macOS/Linux 1-click portable launcher
```

> **Custom Data Folder (Optional)**: Set environment variable `SUTRAM_DATA_DIR=/your/custom/path` if you want databases stored elsewhere.

---

## 4. Running in Development Mode

### A. Browser Dev Mode (Fastest for Day-to-Day Coding)
Open **2 terminals** in `Sutram-Eco-System/`:

**Terminal 1 — Backend Server (Port 3300, auto-reloads on edit):**
```bash
npm run server:dev
```

**Terminal 2 — Angular Frontend (Port 4300, proxies `/api` to 3300):**
```bash
npm run ui
```
Open **`http://localhost:4300`** in your browser.
Default Master Login: **`admin`** / **`sutram`**

### B. Tauri Desktop Dev Mode
With Terminal 1 (`npm run server:dev`) and Terminal 2 (`npm run ui`) running, open **Terminal 3**:
```bash
npx tauri dev
```
This opens the native desktop window connected live to `http://localhost:4300`.

---

## 5. Production Builds (All Commands)

### A. Build Production Frontend UI (`dist/`)
```bash
npm run ui:build
```
Outputs production files directly into **`Sutram-Eco-System/dist/`**.

### B. Run Single-Port Production / Portable Server (No Angular Needed)
```bash
npm start
```
Open **`http://localhost:3300`** — serves both Backend APIs and Frontend UI from a single port!
Or use the 1-click portable launchers:
- **Windows**: Double-click `start-portable.bat`
- **macOS / Linux**: `./start-portable.sh`

### C. Build Native Desktop App (`.exe` / `.msi` / `.app` / `.dmg`)
Make sure `dist/` is built first, then run Tauri build:
```bash
npm run ui:build
npx tauri build
```

#### Build Outputs:
- **Windows**:
  - Standalone Portable EXE: `src-tauri\target\release\sutram-desktop.exe` *(rename to `Sutram.exe`)*
  - Setup Installer (NSIS): `src-tauri\target\release\bundle\nsis\Sutram Dynamic ERP_2.0.0_x64-setup.exe`
  - MSI Installer: `src-tauri\target\release\bundle\msi\Sutram Dynamic ERP_2.0.0_x64_en-US.msi`
- **macOS**:
  - App Bundle: `src-tauri/target/release/bundle/macos/Sutram Dynamic ERP.app`
  - Disk Image Installer: `src-tauri/target/release/bundle/dmg/Sutram Dynamic ERP_2.0.0_*.dmg`

> **Cloud Windows Build (No Windows PC Needed)**:
> Go to your GitHub Repo $\rightarrow$ **Actions** $\rightarrow$ **Build Windows Desktop Shell (.exe)** $\rightarrow$ click **Run workflow**. It also runs automatically whenever files in `src-tauri/` are updated.

---

## 6. Pushing Updates to Clients (Zero Re-Compilation!)

You do **NOT** need to rebuild `Sutram.exe` or `Sutram.app` for backend or UI updates! Because Tauri loads live UI from `http://localhost:3300` (`dist/`), you simply ship a lightweight ZIP:

### On Developer PC:
```bash
npm run make-update
```
*(Or `npm run make-update -- --skip-build` if `dist/` is already built.)*
This creates a ~1.5 MB ZIP at **`releases/sutram-update-v*.zip`** containing ONLY `sutramServer/`, `packages/`, and `dist/`.

### On Client PC:
1. Open Sutram App $\rightarrow$ click the **🔄 Updates** icon in the top header.
2. Select `sutram-update-*.zip` $\rightarrow$ click **Apply Update**.
3. Sutram automatically takes a backup snapshot into `../SutramData/backups/`, replaces code files safely, preserves `../SutramData/` 100%, and reloads with the new version!

---

## 7. Portable Pendrive Setup (For Client PCs)

For a client or brother's PC that doesn't have Git, Angular, or Rust:

```text
SutramPortable/
├── Sutram.exe            # (Windows) or Sutram Dynamic ERP.app (macOS) — 1-click launch!
├── SutramData/           # Databases & backups (100% safe outside code folder)
├── runtime/              # (Optional) Portable node.exe / node binary
└── sutram/               # Pure code folder (can be replaced wholesale anytime!)
    ├── start-portable.bat / .sh
    ├── dist/             # Built UI (~3.8 MB)
    ├── sutramServer/     # Backend code
    ├── packages/         # Sutram packages
    ├── node_modules/     # Installed once on target OS (Windows or macOS)
    └── package.json
```

> **OS Note**: `node_modules/better-sqlite3` contains OS-specific native binaries. Run `npm install --legacy-peer-deps` once on Windows when preparing a Windows pendrive, and once on macOS when preparing a macOS pendrive.

---

## 8. Quick Command Cheat Sheet

| Goal | Command (run inside `Sutram-Eco-System/`) |
| :--- | :--- |
| Install backend + packages + Tauri CLI | `npm install --legacy-peer-deps` |
| Install Angular UI deps | `cd sutramUI && npm install --legacy-peer-deps` |
| Start dev backend (port 3300) | `npm run server:dev` |
| Start dev UI (port 4300) | `npm run ui` |
| Start Tauri desktop in dev mode | `npx tauri dev` |
| Build production UI (`dist/`) | `npm run ui:build` |
| Run production single-port (3300) | `npm start` |
| Build native desktop `.exe` / `.dmg` | `npx tauri build` |
| Build lightweight client `update.zip` | `npm run make-update` |

---

## 9. Troubleshooting

1. **`better-sqlite3` ABI / module mismatch error after switching Node version or OS**:
   ```bash
   npm rebuild better-sqlite3
   ```
2. **macOS says "App is damaged" or "Unidentified Developer"**:
   ```bash
   xattr -cr "Sutram Dynamic ERP.app"
   ```
3. **LAN peers not visible on Windows**:
   - Allow Node.js / Sutram through **Windows Defender Firewall** on **Private Network** (UDP Port `43210` + TCP Port `3300`).
4. **Port 3300 already in use**:
   - Close any previous `node server.js` terminal before launching `Sutram.exe` / `Sutram.app`.
