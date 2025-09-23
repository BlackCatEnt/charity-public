[CmdletBinding()]
param(
  [switch]$Bot = $true,
  [switch]$Broadcaster = $true,

  # Default scopes (edit if you change Charity’s needs)
  [string]$ScopesBot = 'chat:read chat:edit moderator:read:followers user:manage:whispers',
  [string]$ScopesBroadcaster = 'bits:read channel:read:subscriptions moderator:read:followers',

  # Paths
  [string]$RepoRoot = 'A:\Charity',
  [string]$DotEnvPath = 'A:\Charity\.env'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Read-DotEnv($path) {
  $m = @{}
  if (Test-Path $path) {
    Get-Content $path -Raw -EA Ignore | ForEach-Object {
      $_ -split "`r?`n" | ForEach-Object {
        if ($_ -match '^\s*#') { return }
        if ($_ -match '^\s*$') { return }
        if ($_ -match '^\s*([^=]+)=(.*)$') {
          $m[$matches[1].Trim()] = $matches[2]
        }
      }
    }
  }
  return $m
}

function Set-EnvLine($path,$key,$value) {
  $txt = (Test-Path $path) ? (Get-Content $path -Raw) : ''
  if ($txt -match "(?m)^$([regex]::Escape($key))=.*$") {
    $txt = [regex]::Replace($txt, "(?m)^$([regex]::Escape($key))=.*$", "$key=$value")
  } else {
    if ($txt.Length -gt 0 -and -not $txt.EndsWith("`n")) { $txt += "`r`n" }
    $txt += "$key=$value"
  }
  $txt | Set-Content $path -NoNewline
}

function Ensure-TwitchCLI($clientId, $clientSecret) {
  Write-Host "Configuring Twitch CLI with the provided Client ID/Secret…" -ForegroundColor Cyan
  & twitch configure -i $clientId -s $clientSecret | Out-Null
}

function Acquire-UserToken([string]$Scopes,[string]$Who) {
  Write-Host ""
  Write-Host "==> A browser will open. Please log in as: $Who" -ForegroundColor Yellow
  Write-Host "    Scopes: $Scopes"
  Write-Host ""

  # Twitch CLI prints human-readable lines; capture stdout+stderr.
  $lines = & twitch token -u -s $Scopes 2>&1 | Out-String -Width 4096
  if (-not $lines) { throw "No output from twitch CLI. Is it installed/in PATH?" }

  # Extract tokens via regex
  $access = $null; $refresh = $null; $expires = $null; $scopes = @()

  foreach ($line in ($lines -split "`r?`n")) {
    if ($line -match 'User Access Token:\s*(\S+)') { $access = $matches[1] }
    elseif ($line -match 'Refresh Token:\s*(\S+)') { $refresh = $matches[1] }
    elseif ($line -match 'Expires At:\s*(.+)$')   { $expires = $matches[1].Trim() }
    elseif ($line -match 'Scopes:\s*\[(.+)\]')    { $scopes = $matches[1].Split(' ') }
  }

  if (-not $access -or -not $refresh) {
    Write-Host "----- Twitch CLI output -----" -ForegroundColor DarkGray
    Write-Host $lines
    throw "Failed to parse tokens from Twitch CLI output."
  }

  return [pscustomobject]@{
    Access  = "oauth:$access"
    Refresh = $refresh
    Expires = $expires
    Scopes  = $scopes
  }
}

function StripOAuthPrefix($s) {
  if ($null -eq $s) { return $null }
  return ($s -replace '^(oauth:|OAuth\s+)', '')
}

function Validate-Token($access) {
  $raw = StripOAuthPrefix $access
  try {
    $resp = Invoke-RestMethod -Method GET -Uri 'https://id.twitch.tv/oauth2/validate' -Headers @{
      Authorization = "OAuth $raw"
    }
    return $resp
  } catch {
    return $null
  }
}

# --- main ---
Push-Location $RepoRoot
try {
  $envMap = Read-DotEnv $DotEnvPath
  $clientId = $envMap['TWITCH_CLIENT_ID']
  $clientSecret = $envMap['TWITCH_CLIENT_SECRET']

  if (-not $clientId -or -not $clientSecret) {
    Write-Host "TWITCH_CLIENT_ID/SECRET not found in .env; prompting…" -ForegroundColor Yellow
    if (-not $clientId)   { $clientId   = Read-Host "Enter TWITCH_CLIENT_ID" }
    if (-not $clientSecret){ $clientSecret = Read-Host "Enter TWITCH_CLIENT_SECRET" }
    Set-EnvLine $DotEnvPath 'TWITCH_CLIENT_ID' $clientId
    Set-EnvLine $DotEnvPath 'TWITCH_CLIENT_SECRET' $clientSecret
  }

  Ensure-TwitchCLI $clientId $clientSecret

  $botTok = $null
  if ($Bot) {
    $botTok = Acquire-UserToken -Scopes $ScopesBot -Who 'BOT (charity_the_adventurer)'
    Set-EnvLine $DotEnvPath 'TWITCH_OAUTH'   $botTok.Access
    Set-EnvLine $DotEnvPath 'TWITCH_REFRESH' $botTok.Refresh
  }

  $broadTok = $null
  if ($Broadcaster) {
    $broadTok = Acquire-UserToken -Scopes $ScopesBroadcaster -Who 'BROADCASTER (bagotrix)'
    Set-EnvLine $DotEnvPath 'TWITCH_OAUTH_BROADCASTER'   $broadTok.Access
    Set-EnvLine $DotEnvPath 'TWITCH_REFRESH_BROADCASTER' $broadTok.Refresh
  }

  # Validate and print summary
  $botVal   = if ($botTok)   { Validate-Token $botTok.Access }   else { $null }
  $broadVal = if ($broadTok) { Validate-Token $broadTok.Access } else { $null }

  $summary = [pscustomobject]@{
    bot = if ($botVal) {
      [pscustomobject]@{
        login = $botVal.login; user_id = $botVal.user_id; scopes = $botVal.scopes; expires_in_s = $botVal.expires_in
      }
    } else { $null }
    broadcaster = if ($broadVal) {
      [pscustomobject]@{
        login = $broadVal.login; user_id = $broadVal.user_id; scopes = $broadVal.scopes; expires_in_s = $broadVal.expires_in
      }
    } else { $null }
  }

  Write-Host ""
  Write-Host "New token summary:" -ForegroundColor Green
  $summary | ConvertTo-Json -Depth 10

  Write-Host ""
  Write-Host "✔ .env updated at $DotEnvPath" -ForegroundColor Green
  Write-Host "Tip: run  node tools/token-status.mjs  to double-check Charity's view."
}
finally {
  Pop-Location
}
