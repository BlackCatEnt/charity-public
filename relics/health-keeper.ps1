$hb = Join-Path $PSScriptRoot ".runtime/keeper.alive"
if (-not (Test-Path $hb)) { Write-Host "NO_HEARTBEAT"; exit 2 }
$raw = Get-Content $hb -Raw
$obj = $null
try { $obj = $raw | ConvertFrom-Json } catch { Write-Host "BAD_HEARTBEAT_JSON"; exit 3 }

$ts = [DateTimeOffset]::Parse($obj.ts)
$age = [DateTimeOffset]::UtcNow - $ts
if ($age.TotalSeconds -gt 15) { Write-Host "STALE_HEARTBEAT age=$([int]$age.TotalSeconds)s"; exit 4 }

Write-Host "OK pid=$($obj.pid) processed=$($obj.counters.processed) failed=$($obj.counters.failed)"
exit 0
