@echo off
rem Save and close the simulation when the current week finishes.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\sim_control.ps1" -Action stop-after-week
echo.
pause
