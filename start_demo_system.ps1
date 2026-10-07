param(
    [int]$Port = 8765
)

$ErrorActionPreference = 'Stop'
$demoRoot = Join-Path $PSScriptRoot 'demo_medical_system'
$python = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) {
    $command = Get-Command python -ErrorAction SilentlyContinue
    if ($null -eq $command) { throw 'Python was not found.' }
    $python = $command.Source
}
if (-not (Test-Path -LiteralPath (Join-Path $demoRoot 'index.html'))) {
    throw "Demo system directory was not found: $demoRoot"
}

Write-Host "Local demo system: http://127.0.0.1:$Port"
Write-Host 'Username: demo    Password: demo'
Write-Host 'Press Ctrl+C to stop.'
& $python -m http.server $Port --bind 127.0.0.1 --directory $demoRoot
