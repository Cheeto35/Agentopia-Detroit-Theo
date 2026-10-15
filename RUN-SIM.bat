@echo off
setlocal
cd /d "%~dp0"
title Agentopia Simulation

set "MODEL=qwen2.5:3b"
set "WORLD=apartment"
rem 102 = every persona in the apartment world (100) plus the 2 faction leaders.
rem On this PC (RTX 2060 Super) that is about 110 minutes per simulated week.
set "MAX_AGENTS=102"

echo.
echo ======================================================
echo                 AGENTOPIA
echo              AI SOCIETY START
echo ======================================================
echo.

rem ------------------------------------------------------
rem Python environment
rem ------------------------------------------------------
if not exist ".venv\Scripts\python.exe" (
    echo Setting up the Python environment ^(first run only^)...
    python -m venv .venv || goto :failed
    ".venv\Scripts\python.exe" -m pip install -q -r requirements.txt || goto :failed
)

rem Only one simulation at a time - two runs fight over the GPU and both crawl.
powershell -NoProfile -Command "if (Get-CimInstance Win32_Process -Filter \"name='python.exe'\" | Where-Object { $_.CommandLine -like '*run_world.py*' }) { exit 1 }"
if errorlevel 1 (
    echo A simulation is already running. Close its window first, then try again.
    goto :done
)

if not exist "config.json" (
    echo ERROR: config.json is missing. Copy config.example.json to config.json and set a model.
    goto :done
)

rem ------------------------------------------------------
rem Ollama (local AI model server)
rem ------------------------------------------------------
set "OLLAMA=ollama"
where ollama >nul 2>nul || set "OLLAMA=%LOCALAPPDATA%\Programs\Ollama\ollama.exe"
if not "%OLLAMA%"=="ollama" if not exist "%OLLAMA%" (
    echo ERROR: Ollama is not installed. Get it from https://ollama.com/download
    goto :done
)

curl -fsS http://127.0.0.1:11434/api/tags >nul 2>nul
if errorlevel 1 (
    echo Starting Ollama...
    set "OLLAMA_CONTEXT_LENGTH=8192"
    set "OLLAMA_NUM_PARALLEL=4"
    start "Ollama" /min /belownormal "%OLLAMA%" serve
)

set /a TRIES=0
:wait_ollama
curl -fsS http://127.0.0.1:11434/api/tags >nul 2>nul
if not errorlevel 1 goto :ollama_ready
set /a TRIES+=1
if %TRIES% geq 30 (
    echo ERROR: Ollama is not responding. Start the Ollama app and try again.
    goto :done
)
ping -n 2 127.0.0.1 >nul
goto :wait_ollama

:ollama_ready
echo Ollama: ONLINE

rem Below-normal CPU priority keeps the AI from competing with other servers
rem on this PC. Model runners started later inherit it from Ollama.
powershell -NoProfile -Command "Get-Process ollama*, llama-server -ErrorAction SilentlyContinue | ForEach-Object { try { $_.PriorityClass = 'BelowNormal' } catch {} }"

"%OLLAMA%" list | findstr /c:"%MODEL%" >nul
if errorlevel 1 (
    echo Downloading the AI model %MODEL% ^(first run only, about 2 GB^)...
    "%OLLAMA%" pull %MODEL% || goto :failed
)

rem ------------------------------------------------------
rem Live World dashboard (web UI)
rem ------------------------------------------------------
curl -fsS http://127.0.0.1:8766/ >nul 2>nul
if errorlevel 1 (
    echo Starting the Live World dashboard...
    start "Agentopia Dashboard" /min ".venv\Scripts\python.exe" live_world\server.py --no-browser
    ping -n 4 127.0.0.1 >nul
)
start "" http://127.0.0.1:8766/
echo Dashboard: http://127.0.0.1:8766/

rem ------------------------------------------------------
rem Run the simulation
rem ------------------------------------------------------
echo.
echo Starting the Agentopia society ^(world: %WORLD%, up to %MAX_AGENTS% characters^)...
echo CTRL+C stops the simulation.
echo.
echo ------------------------------------------------------
echo.

set "PYTHONUTF8=1"
start "" /b /wait /belownormal ".venv\Scripts\python.exe" scripts\run_world.py --world %WORLD% --max-agents %MAX_AGENTS% %*

echo.
echo ------------------------------------------------------
echo Agentopia simulation stopped.
goto :done

:failed
echo.
echo Something went wrong - see the message above.

:done
echo.
pause
