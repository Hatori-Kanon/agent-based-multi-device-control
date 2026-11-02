@echo off
chcp 65001 >nul
set NODE_NO_WARNINGS=1
setlocal
if "%~1"=="" (
  echo 用法：把内容包目录拖到本文件上，或在命令行运行：
  echo   安装内容包.bat templatesreeform
  echo.
  echo 选项：--list  列出已安装包；--data-dir ^<路径^>  指定数据目录；
  echo       --url ^<地址^> --token ^<token^>  手动指定控制台。
  pause
  exit /b 2
)
node --experimental-transform-types "%~dp0tools\install-pack.mjs" %*
set "CODE=%errorlevel%"
if not "%CODE%"=="0" pause
exit /b %CODE%
