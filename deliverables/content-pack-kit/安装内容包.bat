@echo off
rem Content-pack installer launcher.
rem ASCII-only on purpose: cmd.exe parses .bat files in the OEM code page, and
rem UTF-8 Chinese text inside batch statements breaks parsing. Usage is printed
rem in English; the Chinese guide is content-pack-kit/README.md.
chcp 65001 >nul
set NODE_NO_WARNINGS=1
if not "%~1"=="" goto run
echo Usage: drag a content-pack folder onto this file, or run:
echo   this-file.bat templates/freeform
echo.
echo Options: --list  list installed packs;  --data-dir ^<path^>  data directory;
echo          --url ^<url^> --token ^<token^>  point at a console;
echo          --zip ^<out.zip^>  only build the zip (no console needed).
echo See content-pack-kit/README.md (Chinese guide) for details.
pause
exit /b 2
:run
node --experimental-transform-types "%~dp0tools/install-pack.mjs" %*
set "CODE=%errorlevel%"
if not "%CODE%"=="0" pause
exit /b %CODE%
