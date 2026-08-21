@echo off
setlocal
rem One-click browser console (no Electron, no BLE hardware, mock devices).
cd /d "%~dp0"

rem Keep corepack/pnpm state inside this repository so the script works
rem without touching %LOCALAPPDATA% (and inside sandboxed environments).
set "COREPACK_HOME=%~dp0.cache\corepack"
set "COREPACK_ENABLE_DOWNLOAD_PROMPT=0"
rem pnpm refuses destructive actions without a TTY; CI mode skips the prompt.
set "CI=true"

echo.
echo ============================================
echo   Embodied Console (browser / headless)
echo ============================================
echo.

call corepack prepare pnpm@10.32.1 --activate >nul 2>&1
set PREPARE_ERROR=%errorlevel%
if not "%PREPARE_ERROR%"=="0" (
  echo [embodied] corepack unavailable - is Node.js 22+ installed?
  exit /b 1
)

echo [1/2] Building dev server...
call corepack pnpm --filter @embodied/desktop build:dev 2>nul
set BUILD_ERROR=%errorlevel%
if not "%BUILD_ERROR%"=="0" (
  echo [embodied] build failed
  exit /b 1
)

echo [2/2] Starting (the browser will open automatically)...
set EMBODIED_OPEN_BROWSER=1
call corepack pnpm --filter @embodied/desktop exec node dist\dev-server.mjs

echo.
echo [embodied] exited.
