$ErrorActionPreference = 'Stop'

$dataRoot = $PSScriptRoot
$appRoot = Join-Path $dataRoot 'UI-TARS-desktop-0.3.0'
$url = 'http://127.0.0.1:8765/'
$output = Join-Path $dataRoot 'screenshots\automated-medical-20261006'
$serverProcess = $null
$serverStartedHere = $false

function Test-DemoServer {
    try {
        $response = Invoke-WebRequest -Uri $url -TimeoutSec 2 -UseBasicParsing
        return $response.StatusCode -eq 200
    } catch {
        return $false
    }
}

$demoServerAvailable = Test-DemoServer
if (-not $demoServerAvailable) {
        Write-Host '[1/3] 启动本地演示病历系统…' -ForegroundColor Cyan
        $serverArgs = '-m http.server 8765 --bind 127.0.0.1 --directory "' + (Join-Path $dataRoot 'demo_medical_system') + '"'
        $serverProcess = Start-Process -FilePath 'python' -ArgumentList $serverArgs -WorkingDirectory $dataRoot -WindowStyle Hidden -PassThru
        $serverStartedHere = $true

        $ready = $false
        for ($attempt = 0; $attempt -lt 20; $attempt++) {
            Start-Sleep -Milliseconds 500
            $demoServerAvailable = Test-DemoServer
            if ($demoServerAvailable) { $ready = $true; break }
            if ($serverProcess.HasExited) { throw '本地演示服务器启动失败，请确认 Python 已加入 PATH。' }
        }
        if (-not $ready) { throw '等待演示系统启动超时（10 秒）。' }
}
if (-not $serverStartedHere) {
    Write-Host '[1/3] 检测到演示系统已运行，继续使用。' -ForegroundColor Cyan
}

    Write-Host '[2/3] 打开浏览器，执行名单检索、病历展开和截图…' -ForegroundColor Cyan
    Push-Location $appRoot
    try {
        & node automated_medical_ocr_e2e.mjs
        if ($LASTEXITCODE -ne 0) { throw "浏览器自动化失败，退出码：$LASTEXITCODE" }
    } finally {
        Pop-Location
    }

    Write-Host '[3/3] 调用真实 PaddleOCR 在线服务识别截图…' -ForegroundColor Cyan
    Push-Location $dataRoot
    try {
        & python ocr_screenshots.py 'screenshots/automated-medical-20261006' --output 'screenshots/automated-medical-20261006/ocr-result.md'
        if ($LASTEXITCODE -ne 0) { throw "PaddleOCR 识别失败，退出码：$LASTEXITCODE" }
    } finally {
        Pop-Location
    }

    Write-Host "全流程完成。报告：$output\workflow-result.json" -ForegroundColor Green
    Write-Host "OCR 结果：$output\ocr-result.md" -ForegroundColor Green
if ($serverStartedHere -and $serverProcess -and -not $serverProcess.HasExited) {
    Stop-Process -Id $serverProcess.Id -Force
    Write-Host '已关闭本次运行启动的演示服务器。' -ForegroundColor DarkGray
}
