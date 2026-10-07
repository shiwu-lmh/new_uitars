param(
    [string]$ProjectRoot = $PSScriptRoot,
    [string]$ListPath = (Join-Path $PSScriptRoot 'list.csv'),
    [string]$DatabasePath = (Join-Path $PSScriptRoot 'queue\tasks.sqlite3'),
    [string]$OutputRoot = (Join-Path $PSScriptRoot 'medical_records'),
    [string]$PromptFile = (Join-Path $PSScriptRoot 'queue\current_task.md'),
    [string]$OcrConfig = (Join-Path $PSScriptRoot 'ocr_config.json'),
    [string]$ScreenshotSource = (Join-Path $PSScriptRoot 'screenshots'),
    [int]$PollSeconds = 2,
    [bool]$StartUiTars = $true,
    [switch]$Once
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $ProjectRoot

if (-not (Test-Path -LiteralPath $ListPath)) {
    throw "List file was not found: $ListPath. Copy the example CSV to a local list.csv and fill in only authorized records."
}

$python = Join-Path $ProjectRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) {
    $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
    if ($null -eq $pythonCommand) {
        throw 'Python was not found. Install Python 3.10+ or create the project .venv.'
    }
    $python = $pythonCommand.Source
}

$queueScript = Join-Path $ProjectRoot 'task_queue.py'
$syncScript = Join-Path $ProjectRoot 'sync_windows_screenshots.py'
$ocrScript = Join-Path $ProjectRoot 'watch_ocr.py'
$uiTarsDirectory = Join-Path $ProjectRoot 'UI-TARS-desktop-0.3.0'
$uiTarsScript = Get-ChildItem -LiteralPath $uiTarsDirectory -Filter '*.ps1' -File |
    Where-Object { $_.Name -like '*UI-TARS*.ps1' } |
    Select-Object -First 1 -ExpandProperty FullName
$queueDirectory = Split-Path -Parent $DatabasePath
$taskIdFile = Join-Path $queueDirectory 'current_task.id'

New-Item -ItemType Directory -Force -Path $queueDirectory, $OutputRoot | Out-Null

# A named mutex prevents two Task Scheduler invocations from driving the same browser.
$mutex = New-Object System.Threading.Mutex($false, 'Local\UI_TARS_MEDICAL_QUEUE_SINGLE_INSTANCE')
if (-not $mutex.WaitOne(0, $false)) {
    Write-Host 'Another queue instance is already running. Exiting.'
    exit 0
}

$syncProcess = $null
$ocrProcess = $null

function Invoke-QueueCommand {
    param([string[]]$Arguments)
    $output = & $python $queueScript @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw (($output | Out-String).Trim())
    }
    return $output
}

function Stop-ChildProcess {
    param([System.Diagnostics.Process]$Process)
    if ($null -ne $Process -and -not $Process.HasExited) {
        Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
        $Process.WaitForExit(5000)
    }
}

try {
    Invoke-QueueCommand @('init', '--csv', $ListPath, '--db', $DatabasePath) | Out-Null
    Invoke-QueueCommand @('reset-running', '--db', $DatabasePath) | Out-Null

    $uiStarted = $false
    while ($true) {
        Remove-Item -LiteralPath $taskIdFile -Force -ErrorAction SilentlyContinue
        $nextOutput = & $python $queueScript next --db $DatabasePath --output-root $OutputRoot --prompt-file $PromptFile --task-id-file $taskIdFile 2>&1
        $nextExitCode = $LASTEXITCODE
        if ($nextExitCode -eq 2) {
            Write-Host 'No pending tasks remain in the list.'
            break
        }
        if ($nextExitCode -ne 0) {
            throw (($nextOutput | Out-String).Trim())
        }

        if (-not (Test-Path -LiteralPath $taskIdFile)) {
            throw 'The queue did not create a task_id file after claiming a task.'
        }
        $taskId = (Get-Content -LiteralPath $taskIdFile -Raw -Encoding ASCII).Trim()
        if ($taskId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') {
            throw 'The queue returned an unsafe task_id.'
        }
        $taskDirectory = Join-Path $OutputRoot $taskId

        # Ignore old screenshots from the previous person; only screenshots captured
        # after this person is claimed can enter this person's OCR directory.
        $syncProcess = Start-Process -FilePath $python -WorkingDirectory $ProjectRoot -PassThru -WindowStyle Hidden -ArgumentList @(
            $syncScript, '--source', $ScreenshotSource, '--target', $taskDirectory, '--skip-existing', '--interval', '1'
        )
        $ocrProcess = Start-Process -FilePath $python -WorkingDirectory $ProjectRoot -PassThru -WindowStyle Hidden -ArgumentList @(
            $ocrScript, $taskDirectory, '--output', (Join-Path $taskDirectory 'OCR.md'), '--config', $OcrConfig
        )

        if ($StartUiTars -and -not $uiStarted) {
            if (-not (Test-Path -LiteralPath $uiTarsScript)) {
                throw "UI-TARS startup script was not found in: $uiTarsDirectory"
            }
            Start-Process -FilePath 'powershell.exe' -WorkingDirectory (Split-Path -Parent $uiTarsScript) -WindowStyle Normal -ArgumentList @(
                '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $uiTarsScript
            ) | Out-Null
            $uiStarted = $true
        }

        Write-Host "Current task ID: $taskId"
        Write-Host "Open and copy the task prompt: $PromptFile"
        Write-Host 'After all records are processed and checked, enter done.'
        Write-Host 'For manual handling or an anomaly enter manual; for failure enter failed; to stop and resume later enter pause.'
        $decision = (Read-Host 'Task result [done/manual/failed/pause]').Trim().ToLowerInvariant()

        switch ($decision) {
            'done' {
                Invoke-QueueCommand @('mark', '--db', $DatabasePath, '--task-id', $taskId, '--status', 'done') | Out-Null
            }
            'manual' {
                Invoke-QueueCommand @('mark', '--db', $DatabasePath, '--task-id', $taskId, '--status', 'waiting_manual') | Out-Null
            }
            'failed' {
                Invoke-QueueCommand @('mark', '--db', $DatabasePath, '--task-id', $taskId, '--status', 'failed', '--error', 'Marked failed by operator') | Out-Null
            }
            default {
                Invoke-QueueCommand @('mark', '--db', $DatabasePath, '--task-id', $taskId, '--status', 'waiting_manual') | Out-Null
            }
        }

        Stop-ChildProcess $syncProcess
        Stop-ChildProcess $ocrProcess
        $syncProcess = $null
        $ocrProcess = $null

        if ($Once -or $decision -eq 'pause' -or $decision -eq 'manual' -or $decision -eq 'failed') {
            break
        }
        Start-Sleep -Seconds ([Math]::Max($PollSeconds, 1))
    }
}
finally {
    Stop-ChildProcess $syncProcess
    Stop-ChildProcess $ocrProcess
    if ($null -ne $mutex) {
        $mutex.ReleaseMutex()
        $mutex.Dispose()
    }
}
