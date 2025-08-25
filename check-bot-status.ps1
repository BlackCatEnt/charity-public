<#  check-bot-status.ps1  - Full diagnostics for Charity (PM2), PS 5.1 safe

Usage:
  .\check-bot-status.ps1
  .\check-bot-status.ps1 -AutoStart
  .\check-bot-status.ps1 -RestartIfOutdated
  .\check-bot-status.ps1 -LogLines 50
#>

[CmdletBinding()]
param(
  [switch]$AutoStart,
  [switch]$RestartIfOutdated,
  [int]$LogLines = 20
)

# --- Config ---
$Root      = "C:\twitch-bot\Charity"
$ScriptRel = "data\index.js"
$Name      = "charity"
$EnvPath   = Join-Path $Root ".env"
$KbPath    = Join-Path $Root "data\kb_index.json"
$TokenPath = Join-Path $Root "data\token_state.json"

function Write-Title($t) { Write-Host ""; Write-Host "=== $t ===" -ForegroundColor Cyan }
function Short-Duration([TimeSpan]$ts) {
  if ($ts.TotalDays -ge 1) { "{0}d {1}h {2}m" -f [int]$ts.TotalDays, $ts.Hours, $ts.Minutes }
  elseif ($ts.TotalHours -ge 1) { "{0}h {1}m {2}s" -f [int]$ts.TotalHours, $ts.Minutes, $ts.Seconds }
  else { "{0}m {1}s" -f $ts.Minutes, $ts.Seconds }
}
function Def($v, $alt) { if ($null -eq $v -or "$v" -eq "") { $alt } else { $v } }

Set-Location $Root

if (-not (Get-Command pm2 -ErrorAction SilentlyContinue)) {
  Write-Error "PM2 not found on PATH."
  exit 1
}

# Quick presence check
$exists = (pm2 list | Select-String -SimpleMatch $Name) -ne $null
if (-not $exists -and $AutoStart) {
  Write-Host "Process '$Name' not registered. Starting..." -ForegroundColor Yellow
  pm2 start $ScriptRel --name $Name --update-env | Out-Null
  Start-Sleep -Seconds 2
}

Write-Title "Charity Process Status"

# Use 'pm2 show' to avoid ConvertFrom-Json duplicate-key issues
$show = pm2 show $Name 2>$null
if (-not $show) {
  Write-Host "X '$Name' not found in PM2." -ForegroundColor Red
  exit 1
}

# Extract a value from a line like: " status  │ online "
# Split on [ |, U+2502 (box vertical), U+00A6 (broken bar) ] to avoid encoding troubles
function Get-ShowVal([string]$label) {
  $pattern = "^\s*" + [regex]::Escape($label) + "\s*[\|\u2502\u00A6]"
  $line = $show | Select-String -Pattern $pattern
  if ($line) {
    $clean = ($line -replace '^\s+', '')
    $parts = [regex]::Split($clean, '[\|\u2502\u00A6]')
    if ($parts.Length -ge 2) { return ($parts[1].Trim()) }
  }
  return $null
}

$status     = Get-ShowVal 'status'
$pm2Id      = Get-ShowVal 'id'
$pm2Pid     = Get-ShowVal 'pid'          # (avoid $PID)
$restarts   = Get-ShowVal 'restarts'
$uptimeText = Get-ShowVal 'uptime'
$cpu        = Get-ShowVal 'cpu'
$mem        = Get-ShowVal 'memory'
$scriptPath = Get-ShowVal 'script path'

"{0,-12} {1}" -f "Status:",   (Def $status "unknown")
"{0,-12} {1}" -f "PM2 ID:",   (Def $pm2Id "unknown")
"{0,-12} {1}" -f "PID:",      (Def $pm2Pid "unknown")
"{0,-12} {1}" -f "Uptime:",   (Def $uptimeText "-")
"{0,-12} {1}" -f "Restarts:", (Def $restarts "0")
"{0,-12} {1}" -f "CPU:",      (Def $cpu "-")
"{0,-12} {1}" -f "Memory:",   (Def $mem "-")
"{0,-12} {1}" -f "Script:",   (Def $scriptPath "-")

# --- Staleness checks ---
Write-Title "Staleness Checks"
$scriptFull = Join-Path $Root $ScriptRel
$envInfo    = Get-Item $EnvPath -ErrorAction SilentlyContinue
$codeInfo   = Get-Item $scriptFull -ErrorAction SilentlyContinue

if ($envInfo)  { "{0,-20} {1}" -f ".env last write:",     $envInfo.LastWriteTime } else { Write-Host "Warning: .env not found at $EnvPath" -ForegroundColor Yellow }
if ($codeInfo) { "{0,-20} {1}" -f "index.js last write:", $codeInfo.LastWriteTime }

$needsRestart = $false
if ((Def $status "") -eq "online") {
  $recentCutoff = (Get-Date).AddMinutes(-10)
  if ($envInfo  -and $envInfo.LastWriteTime  -gt $recentCutoff) { Write-Host ".env changed recently -> consider: pm2 restart $Name --update-env" -ForegroundColor Yellow; $needsRestart = $true }
  if ($codeInfo -and $codeInfo.LastWriteTime -gt $recentCutoff) { Write-Host "index.js changed recently -> consider: pm2 restart $Name --update-env" -ForegroundColor Yellow; $needsRestart = $true }
}

if ($RestartIfOutdated -and $needsRestart -and ((Def $status "") -eq "online")) {
  Write-Host "Restarting '$Name' to load latest env/code..." -ForegroundColor Yellow
  pm2 restart $Name --update-env | Out-Null
  Start-Sleep -Seconds 2
  $show    = pm2 show $Name
  $status  = Get-ShowVal 'status'
  Write-Host "New status: $status"
}

# --- KB index status ---
Write-Title "KB Index"
if (Test-Path $KbPath) {
  try {
    $kb = Get-Content $KbPath -Raw | ConvertFrom-Json
    $count = ($kb.docs | Measure-Object).Count
    "kb_index.json: present, docs: $count"
  } catch {
    Write-Host "kb_index.json present but unreadable (invalid JSON?)" -ForegroundColor Yellow
  }
} else {
  Write-Host "kb_index.json not found. To build: npm run index-kb" -ForegroundColor Yellow
}

# --- Token status ---
Write-Title "Token Status"
if (Test-Path $TokenPath) {
  try {
    $tok = Get-Content $TokenPath -Raw | ConvertFrom-Json
    $mins = $null
    if ($tok.expires_at) {
      $expiresAt = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$tok.expires_at).UtcDateTime
      $mins = [math]::Round(($expiresAt - (Get-Date).ToUniversalTime()).TotalMinutes)
    }
    "{0,-20} {1}" -f "Has access token:",  ([bool]$tok.access_token)
    "{0,-20} {1}" -f "Has refresh token:", ([bool]$tok.refresh_token)
    if ($mins -ne $null) { "{0,-20} ~{1} min" -f "Minutes remaining:", $mins }
    if ($tok.last_refresh_attempt) {
      $lastRef = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$tok.last_refresh_attempt).UtcDateTime
      "{0,-20} {1}" -f "Last refresh try:", $lastRef
    }
  } catch {
    Write-Host "Unable to read token_state.json" -ForegroundColor Yellow
  }
} else {
  Write-Host "token_state.json not found yet." -ForegroundColor Yellow
}

# --- Final Status and Logs ---
Write-Title "Final Status and Logs"
"{0,-12} {1}" -f "Online:", (((Def $status "") -eq "online"))
if (((Def $status "") -ne "online") -and $AutoStart) {
  Write-Host "Attempting to (re)start '$Name'..." -ForegroundColor Yellow
  pm2 start $ScriptRel --name $Name --update-env | Out-Null
}

pm2 logs $Name --lines $LogLines
