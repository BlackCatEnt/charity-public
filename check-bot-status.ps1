# check-bot-status.ps1 — Health check for twitch-bot-charity (Windows, ASCII-only)

$ErrorActionPreference = 'SilentlyContinue'

function Write-Ok   ($m){ Write-Host "[ OK ] $m"   -ForegroundColor Green }
function Write-Warn ($m){ Write-Host "[WARN] $m"   -ForegroundColor Yellow }
function Write-Err  ($m){ Write-Host "[FAIL] $m"   -ForegroundColor Red }
function Write-Sec  ($m){ Write-Host ""; Write-Host "=== $m ===" -ForegroundColor Cyan }

# -------- Config --------
$AppRoot = 'C:\twitch-bot\Charity'
$EnvPaths = @("$AppRoot\.env", "$AppRoot\data\.env")
$ProcName = 'twitch-bot-charity'
$ServiceName = 'PM2'
$KbIndex = Join-Path $AppRoot 'data\kb_index.json'
$TokenFile = Join-Path $AppRoot 'data\token.json'

$fail = 0; $warn = 0

# -------- Helpers --------
function Get-FirstExistingFile([string[]]$paths){
  foreach($p in $paths){ if(Test-Path $p){ return $p } }
  return $null
}

function Get-EnvVal([string]$key){
  $path = Get-FirstExistingFile $EnvPaths
  if($path){
    $line = (Select-String -Path $path -Pattern ("^$key=") -ErrorAction SilentlyContinue | Select-Object -First 1).Line
    if($line){
      return @{
        source = "env:$([System.IO.Path]::GetFileName($path))"
        value  = ($line -replace "^$key=",'').Trim()
      }
    }
  }
  return @{ source="env:missing"; value=$null }
}

function Get-TokenJson(){
  if(Test-Path $TokenFile){
    try {
      $obj = Get-Content $TokenFile -Raw | ConvertFrom-Json
      return $obj
    } catch {}
  }
  return $null
}

function Validate-Token([string]$access){
  if(-not $access){ return @{ ok=$false; error="empty_token" } }
  try{
    $raw = (curl.exe -s -H "Authorization: OAuth $access" https://id.twitch.tv/oauth2/validate) | Out-String
    if(-not $raw){ return @{ ok=$false; error="empty_response" } }
    $j = $raw | ConvertFrom-Json
    if(-not $j){ return @{ ok=$false; error="json_parse_failed" } }
    return @{
      ok = $true
      login = $j.login
      client_id = $j.client_id
      scopes = @($j.scopes)
      expires_in = [int]$j.expires_in
      minutes = [int]([double]$j.expires_in/60)
      expires_at = (Get-Date).AddSeconds([int]$j.expires_in).ToString("o")
    }
  } catch {
    return @{ ok=$false; error=$_.Exception.Message }
  }
}

# -------- Service & PM2 --------
Write-Sec "Service & PM2"

# Detect common PM2 service names (prefer the configured $ServiceName but fall back to common aliases)
$svcCandidates = @($ServiceName,'pm2','PM2Service','PM2-Startup') | Select-Object -Unique
$svcFound = $null
foreach($n in $svcCandidates){
  $s = Get-Service -Name $n -ErrorAction SilentlyContinue
  if($s){ $svcFound = $s; break }
}

if($svcFound){
  if($svcFound.Status -eq 'Running'){
    Write-Ok ("Windows service '{0}' is running." -f $svcFound.Name)
  } else {
    Write-Err ("Windows service '{0}' is {1}." -f $svcFound.Name,$svcFound.Status); $fail++
  }
} else {
  Write-Warn "No PM2 Windows service installed (optional; used for auto-start at boot)."
}

if(Get-Command pm2 -ErrorAction SilentlyContinue){
  Write-Ok "pm2 is on PATH."
} else {
  Write-Err "pm2 not found on PATH. Try: npm i -g pm2"; $fail++
}

# PM2 process status (robust with fallbacks to avoid ConvertFrom-Json duplicate-keys bug)
$pm2Ok = $false
try {
  $jsonText = pm2 jlist | Out-String
  try {
    $list = $jsonText | ConvertFrom-Json
    $proc = $list | Where-Object { $_.name -eq $ProcName } | Select-Object -First 1
    if($proc -and $proc.pm2_env.status -eq 'online'){ $pm2Ok = $true }
  } catch {
    # Fallback 1: smaller JSON for this process only
    $desc = (pm2 describe $ProcName --json) 2>$null | Out-String
    if($desc -match '"status"\s*:\s*"online"'){ $pm2Ok = $true }
    elseif(-not $desc){
      # Fallback 2: plain table
      $stat = (pm2 status $ProcName) 2>$null
      if($stat -match '\bonline\b'){ $pm2Ok = $true }
    }
  }
} catch {
  $stat = (pm2 status $ProcName) 2>$null
  if($stat -match '\bonline\b'){ $pm2Ok = $true }
}

if($pm2Ok){
  Write-Ok "PM2 process '$ProcName' is online."
} else {
  Write-Err "PM2 process '$ProcName' not online. (pm2 start .\data\index.js --name $ProcName)"; $fail++
}

# -------- .env and token.json --------
Write-Sec ".env and token.json"
$envPath = Get-FirstExistingFile $EnvPaths
if($envPath){ Write-Ok ".env found at $envPath" } else { Write-Err ".env not found at $($EnvPaths -join ', ')" ; $fail++ }

$need = @('TWITCH_CHANNEL','TWITCH_BOT_USERNAME','TWITCH_OAUTH','TWITCH_CLIENT_ID','TWITCH_CLIENT_SECRET')
$present = @{}
foreach($k in $need){
  $kv = Get-EnvVal $k
  if($kv.value){
    $present[$k] = $kv
    Write-Ok "$k present ($($kv.source))"
  }else{
    $present[$k] = @{source='env:missing'; value=$null}
    Write-Warn "$k missing in env"
    $warn++
  }
}

# Look in token.json for fallbacks
$tokJson = Get-TokenJson
if($tokJson){
  if(-not $present['TWITCH_OAUTH'].value -and $tokJson.access_token){
    Write-Ok "Found access token in token.json"
    $present['TWITCH_OAUTH'] = @{ source='token.json'; value = ($tokJson.access_token -replace '^oauth:','') }
  }
  if(-not $present['TWITCH_CLIENT_ID'].value -and $tokJson.client_id){
    Write-Ok "Found client_id in token.json"
    $present['TWITCH_CLIENT_ID'] = @{ source='token.json'; value = $tokJson.client_id }
  }
  if(-not $present['TWITCH_CLIENT_SECRET'].value -and $tokJson.client_secret){
    Write-Ok "Found client_secret in token.json"
    $present['TWITCH_CLIENT_SECRET'] = @{ source='token.json'; value = $tokJson.client_secret }
  }
  if($tokJson.refresh_token){
    Write-Ok "Refresh token present in token.json"
  }
}else{
  Write-Warn "token.json not found or unreadable at $TokenFile"
}

# If client id/secret still missing anywhere, escalate from WARN to FAIL (refresh needs them)
if(-not $present['TWITCH_CLIENT_ID'].value){ Write-Err "TWITCH_CLIENT_ID missing (not in env or token.json)"; $fail++; $warn = [Math]::Max(0,$warn-1) }
if(-not $present['TWITCH_CLIENT_SECRET'].value){ Write-Err "TWITCH_CLIENT_SECRET missing (not in env or token.json)"; $fail++; $warn = [Math]::Max(0,$warn-1) }

# -------- Token validate --------
Write-Sec "Token validate (expires/scopes)"
$access = $present['TWITCH_OAUTH'].value
if($access){
  $v = Validate-Token $access
  if($v.ok){
    Write-Ok ("Token valid for ~{0} min. Login: {1}" -f $v.minutes, ($v.login | ForEach-Object { $_ } ))
    if(($v.scopes -contains 'chat:read') -and ($v.scopes -contains 'chat:edit')){
      Write-Ok "Scopes OK: chat:read, chat:edit"
    } else {
      Write-Err "Missing required IRC scopes (need chat:read and chat:edit)."; $fail++
      Write-Host ("Scopes: " + (($v.scopes -join ', '))) -ForegroundColor DarkYellow
    }
    if($v.minutes -le 60){ Write-Warn "Token expires in 60 minutes or less."; $warn++ }
  }else{
    Write-Err ("Token validate failed: {0}" -f $v.error); $fail++
  }
}else{
  Write-Err "No access token found in env or token.json"; $fail++
}

# -------- Network test --------
Write-Sec "Network test (id.twitch.tv:443)"
try{
  $tnc = Test-NetConnection -ComputerName id.twitch.tv -Port 443
  if($tnc.TcpTestSucceeded){ Write-Ok "Outbound 443 reachable to id.twitch.tv" }
  else { Write-Err "Cannot reach id.twitch.tv:443 (check firewall/proxy)"; $fail++ }
}catch{
  Write-Warn ("Test-NetConnection failed: {0}" -f $_.Exception.Message); $warn++
}

# -------- KB presence --------
Write-Sec "KB index presence (for !ask)"
if(Test-Path $KbIndex){ Write-Ok "KB index found: $KbIndex" }
else { Write-Warn "KB index missing. Run: npm run index-kb"; $warn++ }

# -------- Summary --------
Write-Sec "Summary"
if($fail -eq 0 -and $warn -eq 0){
  Write-Host "All checks passed." -ForegroundColor Green
}elseif($fail -eq 0){
  Write-Host ("{0} warning(s), no failures." -f $warn) -ForegroundColor Yellow
}else{
  Write-Host ("{0} failure(s), {1} warning(s). See items marked [FAIL]." -f $fail, $warn) -ForegroundColor Red
}

Write-Host ""
Write-Host "Tip: In chat, test: !rules   |   Mods/Broadcaster: !tokenstatus" -ForegroundColor DarkCyan
Write-Host "Press any key to close..."
[void][System.Console]::ReadKey($true)
