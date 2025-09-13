# A:\Charity\relics\publish-public.ps1
param(
  [string]$Source = "A:\Charity",
  [string]$Public = "A:\repos\charity-public",
  [string]$Branch = "v0.3-next",
  [string]$Msg    = "chore: publish $(Get-Date -Format s)"
)

$ErrorActionPreference = "Stop"
function Step($t){ Write-Host "▸ $t" -ForegroundColor Cyan }
function Ok($t){ Write-Host "✓ $t" -ForegroundColor Green }
function Run($cmd){ Write-Host "→ $cmd" -ForegroundColor DarkGray; iex $cmd }

# 1) Preflight in Source
Step "Preflight in $Source"
Push-Location $Source
try {
  Run "npm run preflight"
  Run "git rev-parse --is-inside-work-tree"
  $changes = git status --porcelain
  if ($changes) {
    Run "git add -A"
    Run "git commit -m `"$Msg`""
    Ok "Committed in source"
  } else {
    Ok "No changes to commit in source"
  }
} finally { Pop-Location }

# 2) Export tracked files from Source
$zip = Join-Path $env:TEMP "charity_public_export.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Step "Export tracked files from source → $zip"
Push-Location $Source
try {
  Run "git rev-parse HEAD"
  Run "git archive -o `"$zip`" --format=zip HEAD"
  Ok "Archive created"
} finally { Pop-Location }

# 3) Prepare Public repo
Step "Prepare public repo at $Public"
Push-Location $Public
try {
  Run "git rev-parse --is-inside-work-tree"
  Run "git checkout -B $Branch"

  # clean everything except .git
  Get-ChildItem -Force | Where-Object { $_.Name -ne '.git' } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

  # 4) Unpack export
  Expand-Archive -Path "$zip" -DestinationPath . -Force

  # 5) Commit & push
  Run "git add -A"
  $status = git status --porcelain
  if ($status) {
    Run "git commit -m `"$Msg`""
    Ok "Committed changes in public mirror"
  } else {
    Ok "No changes to commit in public mirror"
  }

  Run "git push -u origin $Branch"
  Ok "Pushed to public origin/$Branch"
} finally { Pop-Location }
Ok "Public mirror updated"
