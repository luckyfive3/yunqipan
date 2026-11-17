@echo off
rem =====================================================
rem  云栖盘 一键启动（双击运行，或: start.bat -ServerOnly 等）
rem  完整参数见 scripts\start.ps1 顶部注释
rem =====================================================
setlocal
chcp 65001 >nul
set "ROOT=%~dp0"
if not exist "%ROOT%logs" mkdir "%ROOT%logs"
set "LOG=%ROOT%logs\start.log"
echo [%date% %time%] 启动: start.bat %* >> "%LOG%"
powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\start.ps1" %* > "%LOG%" 2>&1
set "RC=%ERRORLEVEL%"
type "%LOG%"
echo.
echo [云栖盘] 退出码: %RC% （完整日志: %LOG%）
if not "%RC%"=="0" (
  echo [云栖盘] 启动未完全成功，请把上方日志或 %LOG% 发给维护者排查。
)
echo.
pause