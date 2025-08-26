# remove-service.ps1 — Stops and removes PM2 service installed via NSSM
# Run in elevated PowerShell

$Service = 'PM2'

Write-Host "Stopping PM2 service..." -ForegroundColor Yellow
try { nssm stop $Service | Out-Null } catch { Write-Host "Service already stopped." }

Write-Host "Removing PM2 service..." -ForegroundColor Yellow
try { nssm remove $Service confirm | Out-Null } catch { Write-Host "Service already removed." }

Write-Host "PM2 service removed. Your bot will no longer auto-start." -ForegroundColor Green
