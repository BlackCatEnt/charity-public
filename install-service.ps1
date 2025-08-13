# install-service.ps1 — PM2 + NSSM service for twitch-bot-charity
# Run this in an elevated PowerShell window.

$ErrorActionPreference = 'Stop'

# --- SETTINGS (edit if your paths differ) ---
$AppRoot   = 'C:\twitch-bot\Charity'
$EntryJS   = Join-Path $AppRoot 'data\index.js'
$Service   = 'PM2'                           # Windows service name
$PM2Home   = Join-Path $AppRoot '.pm2'       # PM2 state for this service
$LogsDir   = Join-Path $AppRoot 'logs'       # Where PM2/NSSM logs will go

# --- Ensure folders ---
New-Item -ItemType Directory -Path $AppRoot,$LogsDir,$PM2Home -Force | Out-Null

# --- Ensure Scoop + NSSM ---
if (-not (Get-Command scoop -ErrorAction SilentlyContinue)) {
  Set-ExecutionPolicy RemoteSigned -Scope CurrentUser -Force
  Invoke-RestMethod -Uri https://get.scoop.sh | Invoke-Expression
}
if (-not (Get-Command nssm -ErrorAction SilentlyContinue)) {
  scoop install nssm
}

# --- Ensure Node and PM2 ---
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js is not on PATH. Install Node LTS first and re-run."
}
if (-not (Get-Command pm2 -ErrorAction SilentlyContinue)) {
  npm i -g pm2
}

# Resolve paths we’ll need inside the service context
$NodePath = (Get-Command node).Source
$PM2Cmd   = (Get-Command pm2).Source  # typically ...\AppData\Roaming\npm\pm2.cmd
Write-Host "NodePath: $NodePath"
Write-Host "PM2Cmd:   $PM2Cmd"

# --- Prime PM2 process list (so it resurrects at boot) ---
Push-Location $AppRoot
try {
  # Start (or restart) the bot under PM2 for the current user
  if ((pm2 jlist | Out-String) -notmatch 'twitch-bot-charity') {
    pm2 start $EntryJS --name twitch-bot-charity
  } else {
    pm2 restart twitch-bot-charity
  }
  pm2 save
} finally {
  Pop-Location
}

# --- Install PM2 as a Windows service via NSSM ---
# If the service exists already, remove it first
try { nssm stop  $Service  | Out-Null } catch {}
try { nssm remove $Service confirm | Out-Null } catch {}

# Install service: run pm2.cmd (so it loads your saved process list)
nssm install $Service $PM2Cmd

# App parameters (none needed for pm2.cmd)
nssm set $Service AppDirectory $AppRoot

# Redirect service logs (useful for debugging service startup)
nssm set $Service AppStdout (Join-Path $LogsDir 'pm2-out.log')
nssm set $Service AppStderr (Join-Path $LogsDir 'pm2-err.log')

# Environment for the service:
# - PM2_HOME: where PM2 stores dump + logs (under your project)
# - PATH: make sure Node and npm global bin are visible to the service
$npmGlobalBin = Split-Path $PM2Cmd -Parent
$NodeDir      = Split-Path $NodePath -Parent
$envExtra = @(
  "PM2_HOME=$PM2Home",
  "PATH=$NodeDir;$npmGlobalBin;%PATH%"
) -join '|'
nssm set $Service AppEnvironmentExtra $envExtra

# Start automatically on boot
nssm set $Service Start SERVICE_AUTO_START

# Start the service now
nssm start $Service

Write-Host "PM2 service installed and started as '$Service'."
Write-Host "Use 'pm2 status' and 'pm2 logs twitch-bot-charity' to inspect your bot."

