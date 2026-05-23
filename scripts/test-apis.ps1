# Quick smoke tests for rowing-app APIs (run from repo root).
$Base = if ($env:ROWING_BASE) { $env:ROWING_BASE } else { 'https://rowing-app-recorder-pwa.vercel.app' }
$Token = $env:INGEST_TOKEN

function Headers {
    $h = @{ Accept = 'application/json' }
    if ($Token) { $h.Authorization = "Bearer $Token" }
    return $h
}

function Test-Url($Name, $Path, $Method = 'GET', $Body = $null) {
    $uri = "$Base$Path"
    Write-Host "`n=== $Name ===" -ForegroundColor Cyan
    Write-Host $uri
    try {
        $params = @{
            Uri = $uri
            Method = $Method
            Headers = (Headers)
            TimeoutSec = 25
        }
        if ($Body) {
            $params.Body = ($Body | ConvertTo-Json -Compress)
            $params.ContentType = 'application/json'
        }
        $r = Invoke-WebRequest @params
        $preview = $r.Content
        if ($preview.Length -gt 400) { $preview = $preview.Substring(0, 400) + '…' }
        Write-Host "OK $($r.StatusCode)" -ForegroundColor Green
        Write-Host $preview
    } catch {
        $status = $_.Exception.Response.StatusCode.value__
        Write-Host "FAIL $status" -ForegroundColor Red
        Write-Host $_.Exception.Message
    }
}

Test-Url 'Ping' '/api/ping'
Test-Url 'Devices' '/api/devices'
Test-Url 'Snapshot' '/api/snapshot?onlineSec=120'
Test-Url 'Ingest sample' '/api/ingest' 'POST' @{
    sessionId = "test-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    deviceId = 'TEST-SMOKE-01'
    samples = @(
        @{
            t = [int][double]::Parse((Get-Date -UFormat %s)) * 1000
            gps = @{ lat = -37.93; lon = 175.55; acc = 5 }
        }
    )
}
