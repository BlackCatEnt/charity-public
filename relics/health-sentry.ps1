$uri = "http://127.0.0.1:8150/metrics"
try { (Invoke-WebRequest -UseBasicParsing $uri).StatusCode; Write-Host "OK: $uri" }
catch { Write-Error "Sentry down: $uri"; exit 1 }