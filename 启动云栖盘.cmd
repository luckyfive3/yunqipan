@echo off
rem =====================================================
rem  云栖盘 启动器：探测/启动服务端，然后启动桌面客户端
rem  双击本文件即可；过程日志见 logs\client-launch.log
rem =====================================================
setlocal
chcp 65001 >nul
set "ROOT=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\launch-client.ps1"
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" (
  echo [云栖盘] 启动器完成（客户端窗口应已出现）。
) else (
  echo [云栖盘] 启动器退出码 %RC%，请把上方输出发给维护者排查。
)
echo.
pause