param([string]$Root = "$PSScriptRoot\..")

$ErrorActionPreference = "Stop"
Set-Location $Root
Write-Host "== Repo Health =="

# ------------ 1) JSON validity (use System.Text.Json to avoid PS quirks) ------------
Write-Host "`n[1/4] JSON validity"
$badJson = @()
$jsonFiles = Get-ChildItem -Recurse -File -Filter *.json |
  Where-Object { $_.FullName -notmatch '\\(node_modules|\.git|Archive)\\' }

foreach ($f in $jsonFiles) {
  try {
    [System.Text.Json.JsonDocument]::Parse([System.IO.File]::ReadAllText($f.FullName)) | Out-Null
  } catch {
    Write-Warning "JSON parse failed: $($f.FullName) -> $($_.Exception.Message)"
    $badJson += $f.FullName
  }
}
if (-not $badJson) { Write-Host "OK: all JSON parsed." }

# ------------ 2) JS syntax (node --check) ------------
Write-Host "`n[2/4] JS syntax check"
$badJs = @()
$jsFiles = Get-ChildItem -Recurse -File -Include *.js |
  Where-Object { $_.FullName -notmatch '\\(node_modules|\.git|Archive)\\' }

foreach ($f in $jsFiles) {
  node --check $f.FullName *> $null
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "Syntax error: $($f.FullName)"
    $badJs += $f.FullName
  }
}
if (-not $badJs) { Write-Host "OK: no JS parse errors." }

# ------------ 3) Import resolution (use Node helper, suppress duplicate output) ------------
Write-Host "`n[3/4] Import resolution"
node .\tools\audit_imports.js $Root *> $null
$importExit = $LASTEXITCODE
if ($importExit -eq 0) { Write-Host "OK: imports look resolvable." }
else { Write-Warning "Import resolution reported issues (see tools/audit_imports.js output if run directly)." }

# ------------ 4) Legacy references (scan only text-like files) ------------
Write-Host "`n[4/4] Legacy references"
$legacyPats = @(
  'kb/','scripts/','Check Status\.bat','check-bot-status\.ps1',
  'health-check\.ps1','install-service\.ps1','remove-service\.ps1',
  'restart-bot\.ps1','update-bot\.ps1','README_PHASE2\.md'
)

# Text extensions to scan
$textExts = @(
  '.js','.json','.md','.ps1','.psm1','.bat','.cmd',
  '.yml','.yaml','.ts','.tsx','.css','.html','.mdx','.txt','.ini','.config'
)

# Files that deliberately contain legacy names (e.g., exclusion lists)
$skipNames = @(
  'repo-health.ps1',
  'mirror-publish.ps1',
  'mirror-update.ps1',
  'Update_Public_Mirror.bat',
  'Update_Public_Mirror_SKIP_SCAN.bat'
)

$legacyHits = @()
$scanFiles = Get-ChildItem -Recurse -File |
  Where-Object {
    $_.FullName -notmatch '\\(node_modules|\.git|Archive)\\' -and
    ($textExts -contains $_.Extension.ToLower()) -and
    ($skipNames -notcontains $_.Name)
  }

foreach ($f in $scanFiles) {
  try {
    $txt = Get-Content $f.FullName -Raw -ErrorAction Stop
    foreach ($pat in $legacyPats) {
      if ([regex]::IsMatch($txt, $pat)) {
        $legacyHits += "$($f.FullName): $pat"
      }
    }
  } catch {
    # Non-text or unreadable file; skip
    continue
  }
}
if ($legacyHits) {
  $legacyHits | Sort-Object | Get-Unique | ForEach-Object { Write-Warning $_ }
} else {
  Write-Host "OK: no legacy refs."
}

# ------------ Summary / exit code ------------
$fail = ($badJson.Count -gt 0) -or ($badJs.Count -gt 0) -or ($importExit -ne 0) -or ($legacyHits.Count -gt 0)
if ($fail) { Write-Error "Repo health: issues found."; exit 1 }
else { Write-Host "`n✅ Repo health: all checks passed."; exit 0 }
