# Pause / resume / stop-after-week controls for the Agentopia simulation on Windows.
# Used by PAUSE-SIM.bat, RESUME-SIM.bat and STOP-AFTER-WEEK.bat.
param([Parameter(Mandatory)][ValidateSet('pause', 'resume', 'stop-after-week')][string]$Action)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$model = 'qwen2.5:3b'

Add-Type -Namespace Win32 -Name Proc -MemberDefinition @'
[DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr h);
[DllImport("ntdll.dll")] public static extern int NtResumeProcess(IntPtr h);
'@

function Get-SimProcesses {
    @(Get-CimInstance Win32_Process -Filter "name='python.exe'" |
        Where-Object { $_.CommandLine -like '*run_world.py*' } |
        ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue } |
        Where-Object { $_ })
}

function Test-Suspended($p) {
    $p.Refresh()
    $threads = @($p.Threads)
    $threads.Count -gt 0 -and -not ($threads | Where-Object { $_.ThreadState -ne 'Wait' -or $_.WaitReason -ne 'Suspended' })
}

function Get-LatestRun {
    Get-ChildItem (Join-Path $root 'data') -Directory |
        Where-Object { Test-Path (Join-Path $_.FullName 'checkpoint.json') } |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
}

switch ($Action) {
    'pause' {
        $procs = Get-SimProcesses
        if (-not $procs) { Write-Host 'No simulation is running.'; exit 0 }
        # Windows counts suspends, so never suspend twice (one resume must undo a pause).
        foreach ($p in $procs) { if (-not (Test-Suspended $p)) { [void][Win32.Proc]::NtSuspendProcess($p.Handle) } }
        Write-Host 'Simulation frozen. Nothing is lost - it continues exactly where it stopped.'

        # Let AI calls already in progress finish (their answers wait for the
        # frozen sim), then unload the model to free GPU memory and RAM.
        Write-Host 'Waiting for the AI to finish its current answers...'
        $quiet = 0
        for ($i = 0; $i -lt 90 -and $quiet -lt 3; $i++) {
            Start-Sleep 2
            $util = [int](& nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits 2>$null | Select-Object -First 1)
            if ($util -lt 10) { $quiet++ } else { $quiet = 0 }
        }
        try {
            # keep_alive 0 asks Ollama to unload the model right away.
            Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:11434/api/generate' -ContentType 'application/json' `
                -Body (@{ model = $model; keep_alive = 0 } | ConvertTo-Json) -TimeoutSec 30 | Out-Null
            Write-Host 'AI model unloaded: GPU and memory are free.'
        } catch {
            Write-Host 'Could not reach Ollama to unload the model; it unloads by itself after 5 idle minutes.'
        }
        Write-Host ''
        Write-Host 'Run RESUME-SIM.bat to continue.'
        Write-Host 'Sleep mode is fine. Restarting or shutting down the PC loses the'
        Write-Host 'unfinished week - use STOP-AFTER-WEEK.bat before doing that.'
    }
    'resume' {
        $procs = Get-SimProcesses
        if ($procs) {
            foreach ($p in $procs) {
                # Resume until no thread is left suspended (covers repeated pauses).
                for ($i = 0; $i -lt 10; $i++) {
                    [void][Win32.Proc]::NtResumeProcess($p.Handle)
                    if (-not (Test-Suspended $p)) { break }
                }
            }
            Write-Host 'Simulation resumed. The AI model reloads on its next request (a few seconds).'
            exit 0
        }
        $run = Get-LatestRun
        if (-not $run) { Write-Host 'No saved run found. Start a new one with RUN-SIM.bat.'; exit 0 }
        $cp = Get-Content (Join-Path $run.FullName 'checkpoint.json') -Raw | ConvertFrom-Json
        Write-Host ("No simulation is running. Continuing run {0} after year {1}, week {2} in a new window..." -f $run.Name, $cp.year, $cp.week)
        Start-Process -FilePath (Join-Path $root 'RUN-SIM.bat') -ArgumentList '--resume', $run.Name -WorkingDirectory $root
    }
    'stop-after-week' {
        $run = Get-LatestRun
        if (-not (Get-SimProcesses)) { Write-Host 'No simulation is running.'; exit 0 }
        New-Item -ItemType File -Force (Join-Path $run.FullName 'STOP_AFTER_WEEK') | Out-Null
        Write-Host ("The simulation ({0}) will save and close when the current week finishes." -f $run.Name)
        Write-Host 'That can take up to ~2 hours at 102 agents. Watch the dashboard or the sim window.'
        Write-Host 'Afterwards, RESUME-SIM.bat continues from the next week.'
    }
}
