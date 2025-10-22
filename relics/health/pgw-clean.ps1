param(
  [string]$Pgw = "http://127.0.0.1:9091",
  [string[]]$Jobs = @("charity","charity_sentry_aggregator"),
  [string[]]$Services = @("keeper","scribe")
)

function Invoke-PgwDelete {
  param([string]$Url)
  try {
    $r = Invoke-WebRequest -Uri $Url -Method DELETE -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
    Write-Host "[DEL] $($r.StatusCode) $Url"
  } catch {
    Write-Host "[DEL] fail $Url -> $($_.Exception.Message)"
  }
}

# discover instances for each job (best-effort)
$metrics = try { (Invoke-WebRequest -Uri "$Pgw/metrics" -UseBasicParsing -TimeoutSec 5).Content } catch { "" }

foreach ($job in $Jobs) {
  $instances = ($metrics -split "`n" | Select-String "job=`"$job`"" | ForEach-Object {
    if ($_ -match 'instance="([^"]+)"') { $matches[1] }
  }) | Sort-Object -Unique
  if (-not $instances) { $instances = @("") }

  foreach ($inst in $instances) {
    foreach ($svc in $Services) {
      if ($inst) { Invoke-PgwDelete "$Pgw/metrics/job/$job/instance/$inst/service/$svc" }
    }
    if ($inst) { Invoke-PgwDelete "$Pgw/metrics/job/$job/instance/$inst" }
  }
  Invoke-PgwDelete "$Pgw/metrics/job/$job"
}

Start-Sleep -Milliseconds 500

# Verify (filter only our series)
$left = (Invoke-WebRequest -Uri "$Pgw/metrics" -UseBasicParsing).Content |
  Select-String "keeper_events_total|scribe_batches_total|service="
if ($left) {
  Write-Host "`n[VERIFY] still found lines:" -ForegroundColor Yellow
  $left | ForEach-Object { Write-Host $_ }
} else {
  Write-Host "`n[VERIFY] no keeper/scribe series found. ✅" -ForegroundColor Green
}
