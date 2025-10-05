
param(
  [ValidateSet('start','restart','status','logs','stop','delete','save')]
  [string]$Action = 'status',
  [string[]]$Args
)

# --- Settings (edit if your paths/names differ)
$CharityName = 'charity'
$RepoDir     = 'A:\Charity'
$EcoFile     = Join-Path $RepoDir 'ecosystem.config.cjs'
$PM2Home     = 'C:\ProgramData\pm2'   # pm2-installer service home

# --- Ensure we talk to the PM2 service instance
if (-not (Test-Path $PM2Home)) { New-Item -ItemType Directory -Path $PM2Home -Force | Out-Null }
$env:PM2_HOME = $PM2Home
if ($env:Path -notmatch [regex]::Escape('C:\ProgramData\npm')) {
  $env:Path = 'C:\ProgramData\npm;' + $env:Path
}

function Ensure-PM2 {
  if (-not (Get-Command pm2 -ErrorAction SilentlyContinue)) {
    throw "PM2 CLI not found in PATH. Install with: npm i -g pm2"
  }
}

function Get-CharityProc {
  Ensure-PM2
  $json = & pm2 jlist 2>$null
  if (-not $json) { return @() }
  try { ($json | ConvertFrom-Json) | Where-Object { $_.name -eq $CharityName } }
  catch { @() }
}

function Start-Charity {
  Ensure-PM2
  $existing = Get-CharityProc
  if ($existing) {
    Write-Host "[$CharityName] already registered in PM2 -> starting (or bringing online)..." -ForegroundColor Cyan
    & pm2 start $CharityName | Out-Host
  } else {
    if (Test-Path $EcoFile) {
      Push-Location $RepoDir
      Write-Host "Starting via ecosystem: $EcoFile" -ForegroundColor Cyan
      & pm2 start $EcoFile | Out-Host
      Pop-Location
    } else {
      Push-Location $RepoDir
      Write-Host "ecosystem.config.cjs not found; starting npm script 'start' under PM2..." -ForegroundColor Yellow
      & pm2 start npm --name $CharityName -- start | Out-Host
      Pop-Location
    }
  }
  & pm2 save | Out-Host
  Charity-Status
}

function Restart-Charity {
  Ensure-PM2
  if (Get-CharityProc) {
    Write-Host "Restarting [$CharityName]..." -ForegroundColor Cyan
    & pm2 restart $CharityName | Out-Host
  } else {
    Write-Host "[$CharityName] not found in PM2; starting instead..." -ForegroundColor Yellow
    Start-Charity
    return
  }
  Charity-Status
}

function Stop-Charity {
  Ensure-PM2
  & pm2 stop $CharityName | Out-Host
  Charity-Status
}

function Delete-Charity {
  Ensure-PM2
  & pm2 delete $CharityName | Out-Host
  & pm2 save | Out-Host
  pm2 ls
}

function Save-Charity {
  Ensure-PM2
  & pm2 save | Out-Host
}

function Charity-Logs {
  Ensure-PM2
  # Pass any extra pm2 logs args through (e.g., --lines 300)
  & pm2 logs $CharityName @Args
}

function Charity-Status {
  Ensure-PM2
  $p = Get-CharityProc
  if ($p) {
    $p | Select-Object `
      @{n='id';      e={$_.pm_id}},
      @{n='name';    e={$_.name}},
      @{n='status';  e={$_.pm2_env.status}},
      @{n='mode';    e={$_.pm2_env.exec_mode}},
      @{n='uptime';  e={
          if ($_.pm2_env.pm_uptime) {
            $start = [DateTimeOffset]::FromUnixTimeMilliseconds($_.pm2_env.pm_uptime).LocalDateTime
            ((Get-Date) - $start).ToString()
          }
        }},
      @{n='cpu%';    e={$_.monit.cpu}},
      @{n='mem(MB)'; e={[math]::Round($_.monit.memory / 1MB, 1)}}
    | Format-Table -AutoSize
  } else {
    Write-Host "No '$CharityName' app found under PM2 (service instance at $PM2Home)." -ForegroundColor Yellow
    pm2 ls
  }
}

# --- CLI entrypoint
switch ($Action) {
  'start'   { Start-Charity }
  'restart' { Restart-Charity }
  'status'  { Charity-Status }
  'logs'    { Charity-Logs }
  'stop'    { Stop-Charity }
  'delete'  { Delete-Charity }
  'save'    { Save-Charity }
}
