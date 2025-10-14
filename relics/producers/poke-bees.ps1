$pgw = "http://localhost:9091"
$job = "charity_sentry_aggregator"
$inst = "local"

function bump($metric, $service) {
  $url  = "$pgw/metrics/job/$job/instance/$inst/service/$service"
  $body = "$metric 1"
  Invoke-RestMethod -Method Post -Uri $url -Body $body
}

Write-Host "Poking keeper + scribe every 10s. Ctrl+C to stop."
while ($true) {
  bump "keeper_events_total" "keeper"
  bump "scribe_batches_total" "scribe"
  Start-Sleep -Seconds 10
}
