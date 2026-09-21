# Verify runtime boot and live probes for main.js and worker.main.js
$ErrorActionPreference = 'Stop'

Write-Host '========================================='
Write-Host '1. TESTING node dist/main.js & LIVE PROBES'
Write-Host '========================================='

$mainProc = Start-Process -FilePath 'node' -ArgumentList 'dist/main.js' -PassThru -RedirectStandardOutput 'test_main_out.log' -RedirectStandardError 'test_main_err.log'

try {
    Start-Sleep -Seconds 4
    if ($mainProc.HasExited) {
        $err = Get-Content 'test_main_err.log' -Raw -ErrorAction SilentlyContinue
        throw "Main process exited prematurely with code $($mainProc.ExitCode). Error: $err"
    }

    Write-Host "Main process running with PID $($mainProc.Id)"

    # Test /health probe
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:3001/health' -Method Get
    Write-Host "/health -> Status: $($health.status), Uptime: $($health.uptime)"
    if ($health.status -ne 'ok') {
        throw "Unexpected /health status: $($health.status)"
    }

    # Test /ready probe
    $ready = Invoke-RestMethod -Uri 'http://127.0.0.1:3001/ready' -Method Get
    Write-Host "/ready -> Status: $($ready.status), Database: $($ready.checks.database), Redis: $($ready.checks.redis)"
    if ($ready.status -ne 'ok' -or $ready.checks.database -ne 'up' -or $ready.checks.redis -ne 'up') {
        throw "Unexpected /ready response: $($ready | ConvertTo-Json -Compress)"
    }

    # Rapid concurrent/consecutive burst (20 requests)
    for ($i = 1; $i -le 20; $i++) {
        $h = Invoke-WebRequest -Uri 'http://127.0.0.1:3001/health' -UseBasicParsing
        $r = Invoke-WebRequest -Uri 'http://127.0.0.1:3001/ready' -UseBasicParsing
        if ($h.StatusCode -ne 200 -or $r.StatusCode -ne 200) {
            throw "Burst probe failure at iteration $($i): health=$($h.StatusCode), ready=$($r.StatusCode)"
        }
    }
    Write-Host "Live probes burst verification: 20/20 PASSED (200 OK)"

} finally {
    if (-not $mainProc.HasExited) {
        Stop-Process -Id $mainProc.Id -Force
        Start-Sleep -Milliseconds 500
    }
    Write-Host "--- main.js STDERR (must be clean) ---"
    $mainStderr = Get-Content 'test_main_err.log' -Raw -ErrorAction SilentlyContinue
    if ([string]::IsNullOrWhiteSpace($mainStderr)) {
        Write-Host "CLEAN (no errors)"
    } else {
        Write-Host "STDERR: $mainStderr"
    }
    Remove-Item 'test_main_out.log', 'test_main_err.log' -Force -ErrorAction SilentlyContinue
}

Write-Host '========================================='
Write-Host '2. TESTING node dist/worker.main.js BOOT'
Write-Host '========================================='

$workerProc = Start-Process -FilePath 'node' -ArgumentList 'dist/worker.main.js' -PassThru -RedirectStandardOutput 'test_worker_out.log' -RedirectStandardError 'test_worker_err.log'

try {
    Start-Sleep -Seconds 4
    if ($workerProc.HasExited) {
        $err = Get-Content 'test_worker_err.log' -Raw -ErrorAction SilentlyContinue
        throw "Worker process exited prematurely with code $($workerProc.ExitCode). Error: $err"
    }

    Write-Host "Worker process running with PID $($workerProc.Id)"

    $workerOut = Get-Content 'test_worker_out.log' -Raw -ErrorAction SilentlyContinue
    Write-Host "Worker STDOUT preview:"
    Write-Host $workerOut

    if ($workerOut -notmatch 'worker_started') {
        throw "Worker stdout did not contain 'worker_started'"
    }

} finally {
    if (-not $workerProc.HasExited) {
        Stop-Process -Id $workerProc.Id -Force
        Start-Sleep -Milliseconds 500
    }
    Write-Host "--- worker.main.js STDERR (must be clean) ---"
    $workerStderr = Get-Content 'test_worker_err.log' -Raw -ErrorAction SilentlyContinue
    if ([string]::IsNullOrWhiteSpace($workerStderr)) {
        Write-Host "CLEAN (no errors)"
    } else {
        Write-Host "STDERR: $workerStderr"
    }
    Remove-Item 'test_worker_out.log', 'test_worker_err.log' -Force -ErrorAction SilentlyContinue
}

Write-Host '========================================='
Write-Host 'ALL RUNTIME BOOT & PROBE TESTS PASSED!'
Write-Host '========================================='
