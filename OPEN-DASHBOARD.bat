@echo off
setlocal
cd /d "%~dp0"

rem Opens the Live World dashboard without starting a new simulation.
curl -fsS http://127.0.0.1:8766/ >nul 2>nul
if errorlevel 1 (
    if not exist ".venv\Scripts\python.exe" (
        echo ERROR: Run RUN-SIM.bat once first to set up Python.
        pause
        exit /b 1
    )
    echo Starting the Live World dashboard...
    start "Agentopia Dashboard" /min ".venv\Scripts\python.exe" live_world\server.py --no-browser
    ping -n 4 127.0.0.1 >nul
)
start "" http://127.0.0.1:8766/
