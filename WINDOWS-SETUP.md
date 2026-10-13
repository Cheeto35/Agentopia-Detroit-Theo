# Windows Setup Guide (for AI assistants)

This file is written for an AI assistant (Claude, ChatGPT, Copilot, etc.) helping the owner of this fork set up and run Agentopia on **Windows**. The upstream README assumes macOS; this fork adds Windows launchers and one code fix. Follow this guide instead of the upstream install steps.

## What the owner wants

- Run the simulation **locally and for free** using **Ollama** — no paid API keys.
- Start everything by **double-clicking a `.bat` file**. The owner is new to Git and the terminal; give click-by-click instructions and do the command-line work for them where you can.
- Run the **`apartment` world**, capped at **50 characters**.
- Watch it in the **Live World web dashboard** at `http://127.0.0.1:8766/`.

## Repository layout

| Remote | URL | Purpose |
|---|---|---|
| `origin` | `https://github.com/Cheeto35/Agentopia-Detroit-Theo.git` | The owner's fork — push here |
| `upstream` | `https://github.com/tbates03/Agentopia-Detroit.git` | Original project — pull updates with `git pull upstream main` |

Files added or changed in this fork:

| File | What it does |
|---|---|
| `RUN-SIM.bat` | One-click launcher: creates `.venv` if missing, starts Ollama if not running, pulls the model if missing, starts the dashboard, opens the browser, runs `scripts/run_world.py --world apartment --max-agents 50`. Extra arguments are passed through (e.g. `RUN-SIM.bat --years 1 --weeks 1`). |
| `OPEN-DASHBOARD.bat` | Opens the dashboard without starting a new sim (starts the dashboard server if it isn't running). |
| `src/agents/data_manager.py` | Windows fix: `fcntl` (Unix-only) is replaced by a per-file thread lock on Windows. Behavior on macOS/Linux is unchanged. Without this the sim crashes on import with `ModuleNotFoundError: No module named 'fcntl'`. |

## Setup from scratch

Reference machine: Windows 11, 16 GB RAM, Intel i7-12650H, NVIDIA RTX 3050 Ti Laptop GPU (4 GB VRAM). Adjust the model choice if the hardware is very different.

### 1. Git

Install Git for Windows. On the reference machine `winget` was broken (`0x8a15000f : Data required by the source is missing`), so the installer was downloaded from the GitHub releases of `git-for-windows/git` and run with `/VERYSILENT /NORESTART`. Git lands at `C:\Program Files\Git\cmd\git.exe`; VS Code must be restarted before its terminals find `git` on PATH.

Clone the fork and add the original as `upstream`:

```
git clone https://github.com/Cheeto35/Agentopia-Detroit-Theo.git
cd Agentopia-Detroit-Theo
git remote add upstream https://github.com/tbates03/Agentopia-Detroit.git
```

### 2. Python

Python 3.13 works. `RUN-SIM.bat` creates `.venv` and installs `requirements.txt` on first run. To do it by hand:

```
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
```

### 3. Ollama and the model

1. Install Ollama from https://ollama.com/download, or from the `OllamaSetup.exe` asset in the `ollama/ollama` GitHub releases. The installer is about 1.5 GB.
2. Set the context length to 8192. The sim sends prompts close to 4,000 tokens, and Ollama defaults to 4096 on a 4 GB GPU, which truncates them:
   ```
   setx OLLAMA_CONTEXT_LENGTH 8192
   ```
   Ollama must be restarted after this. `RUN-SIM.bat` also sets this variable when it starts `ollama serve` itself.
3. Pull the model, about 1.9 GB. `RUN-SIM.bat` does this automatically if it's missing:
   ```
   ollama pull qwen2.5:3b
   ```

`qwen2.5:3b` was chosen because it supports tool/function calling, which the sim uses, and it fits fully in 4 GB of VRAM. It generates about 35 tokens/s on the reference GPU.

To check it is running with the right context:

```
curl http://127.0.0.1:11434/api/ps
```

`context_length` should be `8192`.

### 4. `config.json`

`config.json` is git-ignored, so it is **not** in the repo and must be recreated on each new machine. Create it from `config.example.json`, keeping everything except the model fields below:

```json
"role_model": "local-qwen",
"role_model_max_tokens": 2048,
"god_model": "local-qwen",
"god_model_max_tokens": 4096,
"fallback_model": "local-qwen",
"models": {
  "local-qwen": {
    "url": "http://127.0.0.1:11434/v1",
    "vllm_model_name": "qwen2.5:3b",
    "api_key": "ollama",
    "context_length": 8192
  }
},
"max_concurrency": 4,
```

Also set `"judge_model": "local-qwen"` inside `response_validation`. Any model entry with a `"url"` field is called through the OpenAI-compatible client in `src/utils.py`, and `vllm_model_name` is the model name sent to Ollama.

### 5. Run

Double-click `RUN-SIM.bat`. Ctrl+C in its window stops the sim. The dashboard keeps running in its own minimized window; close that window to stop it.

## What to expect

- **Speed:** slow. A simulated week involves many LLM calls; with 50 characters on the reference laptop, expect hours per simulated week. For a quick check, run `RUN-SIM.bat --max-agents 3 --years 1 --weeks 1`.
- **Console noise:** `cache miss` and `[SAMPLE CACHE MISS] key: (...)` lines that print whole prompts are normal debug output, not errors. `Scratchpad file is empty for create_timestate lookup` on the first week is also normal.
- **Output:** runs are written to `data\apartment_<MMDDHHMM>\`, logs to `logs\`, and the LLM cache to `llm_cache\`. All three are git-ignored.
- **Dashboard:** `live_world/server.py` is read-only and automatically follows the most recently updated run. Panels built for the Detroit world (factions, economy, healthcare, etc.) stay empty for `apartment`. Its `pgrep` call fails harmlessly on Windows.
- **Detroit world:** it does **not** run. `scripts/run_detroit_persistent.py` needs `data/detroit_persistent/`, which the upstream author deliberately left out of the public repo, along with the llama.cpp model pools on ports 8081/8082/8084 started by `scripts/start_detroit_llama.sh`, which is macOS-only. Don't try to make it run unless the owner obtains that data.
- **macOS files:** the `.command` and `.sh` files are macOS launchers and don't run on Windows. The `.bat` files replace the ones that matter.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `ModuleNotFoundError: No module named 'fcntl'` | The Windows fix in `src/agents/data_manager.py` is missing, e.g. after merging upstream changes over it. Re-apply the `try: import fcntl / except ImportError:` fallback at the top of that file. |
| `Ollama is not responding` | Start the Ollama app from the Start menu, or run `ollama serve`. If the tray app is open but the port is dead (its `app.log` repeats "ollama server not ready"), quit it from the tray and run `ollama serve` directly. This happened on the reference machine after force-restarting the app. |
| `ERROR: Input redirection is not supported` | `timeout` was used in a `.bat` run without a console. The launchers use `ping -n N 127.0.0.1 >nul` for delays instead; keep it that way. |
| Prompts truncated or odd output | Check `context_length` via `/api/ps`. It should be 8192, not 4096. |
| `git` not recognized | Restart VS Code or the terminal after installing Git, or call `C:\Program Files\Git\cmd\git.exe` directly. |

## Notes for AI assistants editing this repo on Windows

- The shell is often **Windows PowerShell 5.1**. It strips double quotes from arguments passed to native programs, so `python -c "..."` with embedded quotes breaks. Write a temp `.py` file instead. PS 5.1 also has no scriptblock `-replace`, so `-replace 'x', { ... }` corrupts files.
- Save `.bat` files with **CRLF** line endings. LF endings can break `goto` and labels in `cmd`.
- Don't commit `config.json`, `.venv`, `data/apartment_*`, `logs/` or `llm_cache/`.
- When pulling from `upstream`, check that the `fcntl` fallback in `src/agents/data_manager.py` survives the merge.
