$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $MyInvocation.MyCommand.Path
$shim = Join-Path $repo 'node-userinfo-shim.cjs'
$screenshotDir = Join-Path (Split-Path -Parent $repo) 'screenshots'
$userDataDir = Join-Path $repo '.ui-tars-user-data'
$mutex = New-Object System.Threading.Mutex($false, 'Local\UI_TARS_DESKTOP_SINGLE_INSTANCE')
if (-not $mutex.WaitOne(0, $false)) {
  Write-Host 'Another UI-TARS instance is already running. Close it before starting a new one.'
  exit 1
}

Push-Location $repo
try {
  $env:NODE_OPTIONS = "--require=$shim"
  $env:UI_TARS_SCREENSHOT_DIR = $screenshotDir
  $env:UI_TARS_USER_DATA_DIR = $userDataDir
  $env:UI_TARS_REQUEST_TIMEOUT_MS = '120000'
  pnpm dev:ui-tars
}
finally {
  Pop-Location
  $mutex.ReleaseMutex()
  $mutex.Dispose()
}
