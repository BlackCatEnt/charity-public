param(
  [string]$Source  = "C:\twitch-bot\Charity",
  [string]$Dest    = "C:\repos\charity-public",
  [string]$RepoUrl = "https://github.com/BlackCatEnt/charity-public.git",
  [string]$Branch  = "main",
  [switch]$SkipScan
)

$ErrorActionPreference = "Stop"

# --- helpers ---
function Copy-SafeTree {
  param($Src, $Dst)

  $include = @(
    "docs","modular_phase2","tools","config","package.json","package-lock.json","README.md","README_PUBLISHING.md","PROJECT_MAP.json"
  )
  $excludeDirs  = @("node_modules","data","logs",".git",".github",".vscode","models","Archive")
  $excludeFiles = @(
  "*.log","*.sqlite","*.db","*.pem","*.pfx","*.crt","*.key",".env","token*.json","*.onnx","*.pt","*.bin","*.gguf",
  "install-service.ps1","remove-service.ps1","restart-bot.ps1","update-bot.ps1","check-bot-status.ps1","health-check.ps1"
  )

  if (!(Test-Path $Dst)) { New-Item -ItemType Directory -Path $Dst | Out-Null }

  # clear existing contents except .git
  Get-ChildItem -Force $Dst | Where-Object { $_.Name -ne ".git" } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

  foreach ($i in $include) {
    $srcPath = Join-Path $Src $i
    if (Test-Path $srcPath) {
      robocopy $srcPath (Join-Path $Dst $i) /E /NFL /NDL /NJH /NJS /XD $excludeDirs /XF $excludeFiles | Out-Null
    }
  }

  # remove excluded globs that may have slipped in
  foreach ($pattern in $excludeFiles) {
    Get-ChildItem -Path $Dst -Recurse -Force -File -Include $pattern | Remove-Item -Force -ErrorAction SilentlyContinue
  }
}

function Ensure-ExampleConfig {
  param($Src, $Dst)
  $example = Join-Path $Src "config\charity-config.example.json"
  $out     = Join-Path $Dst "config\charity-config.json"
  if (Test-Path $example) {
    New-Item -ItemType Directory -Force -Path (Split-Path $out) | Out-Null
    Copy-Item $example $out -Force
  }
}

function Write-ProjectMap {
  param($Dst)
  $map = @()
  Get-ChildItem -Path $Dst -Recurse -File -Force | ForEach-Object {
    $rel = Resolve-Path $_.FullName -Relative
    $sha = (Get-FileHash $_.FullName -Algorithm SHA1).Hash
    $map += [PSCustomObject]@{ path = $rel; sha1 = $sha }
  }
  $map | ConvertTo-Json -Depth 4 | Out-File -Encoding UTF8 (Join-Path $Dst "PROJECT_MAP.json")
}

# --- stage sanitized copy ---
Write-Host "Staging sanitized copy..."
Copy-SafeTree -Src $Source -Dst $Dest
Ensure-ExampleConfig -Src $Source -Dst $Dest
Write-ProjectMap -Dst $Dest

# --- secret scan (trufflehog) ---
if (-not $SkipScan) {
  $th = Get-Command trufflehog -ErrorAction SilentlyContinue
  if ($th) {
    Write-Host "Running trufflehog scan..."
    Push-Location $Dest
    trufflehog git file://$Dest --no-update
    $exit = $LASTEXITCODE
    Pop-Location
    if ($exit -ne 0) {
      Write-Warning "Trufflehog reported findings. Review output and fix/redact before pushing. (Use -SkipScan to bypass.)"
      exit 2
    }
  } else {
    Write-Warning "trufflehog not found; skipping scan."
  }
}

# --- git init/commit/push ---
Push-Location $Dest
if (!(Test-Path ".git")) { git init | Out-Null }

# set default branch
git rev-parse --abbrev-ref HEAD 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { git branch -M $Branch }

# set remote
$hasRemote = (git remote 2>$null) -contains "origin"
if (-not $hasRemote) { git remote add origin $RepoUrl }

git add -A
# commit only if changes
if ((git status --porcelain).Length -gt 0) {
  git commit -m "mirror: update public snapshot"
} else {
  Write-Host "No changes to commit."
}

git push -u origin $Branch
Pop-Location
Write-Host "✅ Public mirror updated & pushed."
