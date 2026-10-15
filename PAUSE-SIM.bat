@echo off
rem Pause the Agentopia simulation and free the GPU and memory.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\sim_control.ps1" -Action pause
echo.
pause
