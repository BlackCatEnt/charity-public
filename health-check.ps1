Set-Location C:\twitch-bot\Charity
$pm2 = pm2 jlist | ConvertFrom-Json
$proc = $pm2 | Where-Object { $_.name -eq 'charity' }
if (-not $proc) { Write-Host "❌ charity not in PM2"; exit 1 }
if ($proc.pm2_env.status -ne 'online') { Write-Host "❌ charity status: $($proc.pm2_env.status)"; exit 1 }
Write-Host "✅ charity online (pid $($proc.pid))"
exit 0
