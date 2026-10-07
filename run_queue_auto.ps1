param(
    [string]$ProjectRoot = $PSScriptRoot,
    [string]$ListPath = (Join-Path $PSScriptRoot 'demo_名单.csv'),
    [string]$DatabasePath = (Join-Path $PSScriptRoot 'queue\auto-tasks.sqlite3'),
    [string]$OutputRoot = (Join-Path $PSScriptRoot 'medical_records\auto'),
    [string]$PromptFile = (Join-Path $PSScriptRoot 'queue\auto-current_task.md'),
    [string]$OcrConfig = (Join-Path $PSScriptRoot 'ocr_config.json'),
    [string]$ScreenshotSource = (Join-Path $PSScriptRoot 'screenshots'),
    [string]$SettingsPath = (Join-Path $env:APPDATA 'ui-tars-desktop\ui_tars.setting.json'),
    [int]$TimeoutSeconds = 1800,
    [switch]$DemoMode
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $ProjectRoot

$pythonCommand = Get-Command python -ErrorAction SilentlyContinue
if ($null -eq $pythonCommand) {
    throw 'Python was not found.'
}
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $nodeCommand) {
    throw 'Node.js was not found.'
}
if (-not (Test-Path -LiteralPath $SettingsPath)) {
    throw "UI-TARS settings were not found: $SettingsPath"
}

$demoSystemProcess = $null
$startedDemoSystem = $false
$exitCode = 1
try {
    if ($DemoMode) {
        $demoReady = Test-NetConnection -ComputerName 127.0.0.1 -Port 8765 -InformationLevel Quiet -WarningAction SilentlyContinue
        $correctDemo = $false
        if ($demoReady) {
            try {
                $demoPage = Invoke-WebRequest -Uri 'http://127.0.0.1:8765/' -UseBasicParsing -TimeoutSec 5
                $correctDemo = $demoPage.StatusCode -eq 200 -and $demoPage.Content -match 'demo-type.*screenshot-batch' -and $demoPage.Content -match 'login-form'
            } catch {
                $correctDemo = $false
            }
        }
        if (-not $correctDemo) {
            if ($demoReady) {
                $connection = Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
                if ($null -ne $connection) {
                    Write-Host "Replacing the incorrect local service on port 8765 (PID $($connection.OwningProcess))." -ForegroundColor Yellow
                    Stop-Process -Id $connection.OwningProcess -Force -ErrorAction SilentlyContinue
                    Start-Sleep -Milliseconds 500
                }
            }
            $demoSystemProcess = Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -PassThru -ArgumentList @(
                '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $ProjectRoot 'start_demo_system.ps1')
            )
            $startedDemoSystem = $true
            $demoReady = $false
            for ($attempt = 0; $attempt -lt 20; $attempt++) {
                Start-Sleep -Milliseconds 500
                try {
                    $demoPage = Invoke-WebRequest -Uri 'http://127.0.0.1:8765/' -UseBasicParsing -TimeoutSec 3
                    if ($demoPage.StatusCode -eq 200 -and $demoPage.Content -match 'demo-type.*screenshot-batch' -and $demoPage.Content -match 'login-form') {
                        $demoReady = $true
                        break
                    }
                } catch {}
            }
            if (-not $demoReady) { throw 'The correct local screenshot demo did not become ready on port 8765.' }
        }
        Start-Process 'http://127.0.0.1:8765' | Out-Null
    }

    $autoArguments = @(
        '--project-root', $ProjectRoot,
        '--csv', $ListPath,
        '--db', $DatabasePath,
        '--output-root', $OutputRoot,
        '--prompt-file', $PromptFile,
        '--ocr-config', $OcrConfig,
        '--screenshot-source', $ScreenshotSource,
        '--settings', $SettingsPath,
        '--agent-runner', (Join-Path $ProjectRoot 'ui_tars_agent_runner.mjs'),
        '--node', $nodeCommand.Source,
        '--timeout-seconds', $TimeoutSeconds
    )
    if ($DemoMode) { $autoArguments += '--demo-mode' }

    & $pythonCommand.Source (Join-Path $ProjectRoot 'auto_queue.py') @autoArguments
    $exitCode = $LASTEXITCODE
}
finally {
    if ($startedDemoSystem -and $null -ne $demoSystemProcess -and -not $demoSystemProcess.HasExited) {
        Stop-Process -Id $demoSystemProcess.Id -Force -ErrorAction SilentlyContinue
    }
}
exit $exitCode
