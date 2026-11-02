@echo off
chcp 65001 >nul
set NODE_NO_WARNINGS=1
setlocal
if "%~1"=="" (
  echo 用法：把内容包目录拖到本文件上，或在命令行运行：
  echo   校验内容包.bat templatesreeform
  echo.
  echo 也可以直接用：node --experimental-transform-types toolsalidate-pack.mjs ^<目录^>
  pause
  exit /b 2
)
node --experimental-transform-types "%~dp0toolsalidate-pack.mjs" %*
set "CODE=%errorlevel%"
if not "%CODE%"=="0" pause
exit /b %CODE%
