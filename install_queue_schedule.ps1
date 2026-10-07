param(
    [string]$TaskName = 'UI-TARS Medical Queue',
    [string]$RunAt = '09:00',
    [string]$ProjectRoot = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'
$runner = Join-Path $ProjectRoot 'run_queue.ps1'
if (-not (Test-Path -LiteralPath $runner)) {
    throw "Queue runner was not found: $runner"
}

$parsedTime = [DateTime]::ParseExact($RunAt, 'HH:mm', [Globalization.CultureInfo]::InvariantCulture)
$action = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$runner`""
$trigger = New-ScheduledTaskTrigger -Daily -At $parsedTime
$principal = New-ScheduledTaskPrincipal `
    -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive `
    -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description 'Starts the UI-TARS queue on the current interactive desktop. Does not store passwords or captchas.' `
    -Force | Out-Null

Write-Host "Scheduled task created: $TaskName, daily at $RunAt."
Write-Host 'The task uses the current interactive desktop. It cannot reliably operate a hospital web page while locked, logged out, or without a desktop.'
