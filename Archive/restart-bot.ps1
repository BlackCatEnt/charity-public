# check-bot-status.ps1 — Quick health check for twitch-bot-charity

$AppRoot = 'C:\twitch-bot\Charity'
$EnvFile = Join-Path $AppRoot '.env'
$Proc    = 'twitch-bot-charity'
$Service = 'PM2'

Write-Host "=== Service & PM2 ===" -ForegroundColor Cyan
try { Get-Service $Service | Format-Table -AutoSize } catch { Write-Host "PM2 service not found." -ForegroundColor Yellow }
pm2 status $Proc

Write-Host "`n=== Recent Logs ($Proc) ===" -ForegroundColor Cyan
pm2 logs $Proc --lines 60 --nostream

Write-Host "`n=== .env sanity ===" -ForegroundColor Cyan
if (Test-Path $EnvFile) {
  $envContent = Get-Content $EnvFile | Where-Object { $_ -match '^(TWITCH_CHANNEL|TWITCH_BOT_USERNAME|TWITCH_OAUTH|TWITCH_REFRESH|TWITCH_CLIENT_ID|TWITCH_CLIENT_SECRET)=' }
  $envContent | ForEach-Object {
    if ($_ -match '^TWITCH_OAUTH=') { $_ -replace '=(.*)$','=<redacted>' } else { $_ }
  }
} else {
  Write-Host ".env not found at $EnvFile" -ForegroundColor Yellow
}

Write-Host "`n=== Token validate (expires/scopes) ===" -ForegroundColor Cyan
if (Test-Path $EnvFile) {
  $tokenLine = (Select-String -Path $EnvFile -Pattern '^TWITCH_OAUTH=' | Select-Object -First 1).Line
  if ($tokenLine) {
    $raw = $tokenLine -replace '^TWITCH_OAUTH=',''
    if ($raw) {
      try {
        curl.exe -s -H "Authorization: OAuth $raw" https://id.twitch.tv/oauth2/validate | Out-String | Write-Output
      } catch {
        Write-Host "Token validate call failed: $_" -ForegroundColor Yellow
      }
    } else { Write-Host "TWITCH_OAUTH not set." -ForegroundColor Yellow }
  } else { Write-Host "TWITCH_OAUTH not found in .env." -ForegroundColor Yellow }
}

Write-Host "`n=== Network quick test ===" -ForegroundColor Cyan
# Twitch IRC uses secure WebSocket over 443 (tmi.js). Ensure outbound 443 is open.
try { Test-NetConnection -ComputerName id.twitch.tv -Port 443 | Format-List } catch {}
