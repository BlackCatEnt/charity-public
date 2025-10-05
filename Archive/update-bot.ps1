# update-bot.ps1 — Updates twitch-bot-charity and restarts it
# Run in elevated PowerShell if your PM2 service requires it

$AppRoot = 'C:\twitch-bot\Charity'

Write-Host "Updating bot in $AppRoot..." -ForegroundColor Cyan
Set-Location $AppRoot

# Pull latest changes from GitHub
git pull

# Install/update dependencies
npm install

# Restart PM2 process and save state
pm2 restart twitch-bot-charity
pm2 save

Write-Host "Bot updated and restarted." -ForegroundColor Green
