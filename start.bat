@echo off
setlocal
rem One-click console launcher: prepare deps -> build -> start Electron window.
rem This file sits in the repository root.
cd /d "%~dp0"

rem Keep corepack/pnpm state inside this repository so the script works
rem without touching %LOCALAPPDATA% (and inside sandboxed environments).
set "COREPACK_HOME=%~dp0.cache\corepack"
set "COREPACK_ENABLE_DOWNLOAD_PROMPT=0"
rem pnpm refuses destructive actions without a TTY; CI mode skips the prompt,
rem and a one-click launcher should reconcile the lockfile when package.json
rem has changed. Postinstall scripts stay ENABLED: electron downloads its
rem binary there on first run.
set "CI=true"

echo.
echo ============================================
echo   Embodied Console (Electron)
echo ============================================
echo.

rem Download pnpm 10 on first run (corepack ships with Node 16+).
call corepack prepare pnpm@10.32.1 --activate >nul 2>&1
set PREPARE_ERROR=%errorlevel%
if not "%PREPARE_ERROR%"=="0" (
  echo [embodied] corepack unavailable - is Node.js 22+ installed?
  exit /b 1
)

echo [1/3] Checking dependencies...
call corepack pnpm install --no-frozen-lockfile 2>nul
set INSTALL_ERROR=%errorlevel%
if not "%INSTALL_ERROR%"=="0" (
  echo [embodied] warning: dependency install reported an error, continuing anyway
  echo            (the build step will catch anything that is actually missing)
)

echo [2/4] Checking Electron binary...
rem If the postinstall download was unavailable, restore the binary from the
rem local cache so the console still starts. A no-op when already installed.
call powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\restore-electron.ps1"
if errorlevel 1 (
  echo [embodied] warning: electron restore failed, continuing anyway
)

echo [3/4] Building...
call corepack pnpm --filter @embodied/desktop build
set BUILD_ERROR=%errorlevel%
if not "%BUILD_ERROR%"=="0" (
  echo [embodied] build failed
  exit /b 1
)
if not exist "%~dp0apps\desktop\dist\main.mjs" (
  echo [embodied] build produced no main.mjs - aborting
  exit /b 1
)

echo [4/4] Starting console...
echo.
echo   Data dir : %EMBODIED_DATA_DIR%  (unset = system default; set it first
echo              with: set EMBODIED_DATA_DIR=E:\embodied-data)
echo   No BLE hardware? Use start-dev.bat (add "mock" for demo devices).
echo.
call corepack pnpm --filter @embodied/desktop exec electron .

echo.
echo [embodied] exited.
