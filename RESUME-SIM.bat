@echo off
rem Resume a paused simulation, or continue the last saved run.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\sim_control.ps1" -Action resume
echo.
pause
