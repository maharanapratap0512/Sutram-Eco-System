@echo off
REM ─────────────────────────────────────────────────────────────
REM Sutram 2.0: Portable One-Click Zero-Install Launcher (Windows)
REM ─────────────────────────────────────────────────────────────
setlocal enabledelayedexpansion
title Sutram Dynamic ERP 2.0 (Portable)

set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

echo =======================================================
echo    SUTRAM DYNAMIC ERP 2.0 - PORTABLE EDITION (WINDOWS)
echo =======================================================
echo Portable Root: %SCRIPT_DIR%

REM 1. Determine Node binary (Embedded runtime vs System Node)
set "NODE_BIN=node"
if exist "%SCRIPT_DIR%runtime\node.exe" (
    set "NODE_BIN=%SCRIPT_DIR%runtime\node.exe"
    echo Using embedded portable node runtime: !NODE_BIN!
) else (
    echo Using system node runtime...
)

REM 2. Verify Node
where !NODE_BIN! >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is required to run Sutram.
    echo Please install Node.js or place portable node.exe in runtime\ folder.
    pause
    exit /b 1
)

REM 3. Launch Sutram Server
echo Starting Sutram Server with LAN Mesh on port 3300...
cd /d "%SCRIPT_DIR%sutramServer"
start "Sutram Server Engine" /min !NODE_BIN! server.js

REM 4. Wait for initialization
timeout /t 2 /nobreak >nul

REM 5. Open browser
echo Opening Sutram ERP...
start http://localhost:3300

exit /b 0
