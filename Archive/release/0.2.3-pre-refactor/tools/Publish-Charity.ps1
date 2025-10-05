param(
  [string]$RepoPath = 'A:\Charity',
  [string]$Branch   = $env:CHARITY_BRANCH  # e.g., release/0.2.3; if empty we auto-detect
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Write-Host "[publish] starting at $(Get-Date -Format o)"
if (-not (Test-Path $RepoPath)) { throw "Repo path not found: $RepoPath" }
Set-Location $RepoPath

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Warning "[publish] git not found; skipping fetch/reset"
} else {
  git fetch --all --prune
  if (-not $Branch) {
    $candidates = git for-each-ref --sort=-committerdate --format="%(refname:short)" refs/remotes/origin/release/*
    $Branch = if ($candidates) { ($candidates | Select-Object -First 1).Replace('refs/remotes/','') } else { 'origin/main' }
    Write-Host "[publish] auto-branch => $Branch"
  } elseif ($Branch -notmatch '^(origin/|release/)') {
    # Allow passing 'release/0.x' without origin/
    $Branch = "origin/$Branch"
  }
  git reset --hard $Branch
}

if (Get-Command npm -ErrorAction SilentlyContinue) {
  if (Test-Path package.json) {
    npm ci
    if (Test-Path package.json) { npm run build 2>$null }
  }
} else {
  Write-Warning "[publish] npm not found; skipping build"
}

$mirror = Join-Path $RepoPath 'tools\mirror-publish.ps1'
if (Test-Path $mirror) { & $mirror }

Write-Host "[publish] done"
