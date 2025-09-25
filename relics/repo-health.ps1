param(
  [string]$Root = (Resolve-Path ".").Path
)

$ErrorActionPreference = "Stop"
Set-Location $Root
Write-Host "== Repo Health =="

Write-Host "`n[1/4] JSON validity"

# Exclusions (runtime/vendor/archives)
$exclude = '\\node_modules\\|\\\.git\\|\\Archive\\|\\soul\\memory\\episodes\\|\\soul\\kb\\index\\|\\soul\\cache\\'

# Gather files
$JsonFiles  = Get-ChildItem -Path $Root -Recurse -File -Include *.json  | Where-Object { $_.FullName -notmatch $exclude }
$JsonlFiles = Get-ChildItem -Path $Root -Recurse -File -Include *.jsonl | Where-Object { $_.FullName -notmatch $exclude }

$JsonFailed  = @()
$JsonlFailed = @()

$Node = Get-Command node -ErrorAction SilentlyContinue

function Test-Json([string]$path) {
  if ($null -ne $Node) {
    $code = "try{const fs=require('fs');JSON.parse(fs.readFileSync(process.argv[1],'utf8'));}catch(e){process.exit(1)}"
    node -e $code $path 2>$null
    return $LASTEXITCODE -ne 0
  } else {
    try { Get-Content $path -Raw | ConvertFrom-Json | Out-Null; return $false } catch { return $true }
  }
}

function Test-Jsonl([string]$path) {
  try {
    $lines = Get-Content -LiteralPath $path
    $ln = 0
    foreach ($raw in $lines) {
      $ln++
      $line = $raw.Trim()
      if ($line -eq '') { continue }
      try { $null = $line | ConvertFrom-Json } catch { return ("{0}:{1}" -f $path,$ln) }
    }
    return $null
  } catch {
    return $path
  }
}

foreach ($f in $JsonFiles)  { if (Test-Json $f.FullName)  { $JsonFailed  += $f.FullName } }
foreach ($f in $JsonlFiles) { $bad = Test-Jsonl $f.FullName; if ($bad) { $JsonlFailed += $bad } }

if ($JsonFailed.Count -eq 0 -and $JsonlFailed.Count -eq 0) {
  Write-Host "OK: all JSON/JSONL parsed."
} else {
  Write-Warning ("JSON parse failed:`n" + (($JsonFailed + $JsonlFailed) -join "`n"))
}

# 2/4 JS syntax check
Write-Host "`n[2/4] JS syntax check"
$badJs = @()
$jsFiles = Get-ChildItem -Path $Root -Recurse -File -Include *.js,*.mjs | Where-Object { $_.FullName -notmatch $exclude }
foreach ($f in $jsFiles) {
  if ($null -ne $Node) {
    node --check $f.FullName *> $null
    if ($LASTEXITCODE -ne 0) { $badJs += $f.FullName }
  }
}
if (-not $badJs) { Write-Host "OK: no JS parse errors." } else { $badJs | ForEach-Object { Write-Warning "Syntax error: $_" } }

# 3/4 Import resolution
Write-Host "`n[3/4] Import resolution"
$auditor = Join-Path $PSScriptRoot "audit_imports.mjs"
$importExit = 0
if (Test-Path $auditor) {
  node $auditor $Root *> $null
  $importExit = $LASTEXITCODE
  if ($importExit -eq 0) { Write-Host "OK: imports resolved." }
  else { Write-Warning "Import resolution reported issues (see relics/audit_imports.mjs)" }
} else {
  Write-Host "NOTE: import audit skipped (no auditor at $auditor)."
}

# [4/4] Legacy references
Write-Host "`n[4/4] Legacy references"

# scan only source/docs we actually care about
$scan = Get-ChildItem -Recurse -File -Include *.mjs,*.js,*.json,*.md |
  Where-Object {
    $_.FullName -notmatch '\\node_modules\\' -and
    $_.Name -ne 'package-lock.json'
  }

$fail = $false

# --- kb/: flag only true legacy 'kb/' (NOT 'soul/kb')
$kbRaw  = Select-String -Path $scan.FullName -Pattern 'kb/' -ErrorAction SilentlyContinue
$kbHits = $kbRaw | Where-Object { $_.Line -notmatch 'soul/kb' }
foreach ($h in ($kbHits | Sort-Object Path -Unique)) {
  Write-Warning ("{0}: kb/" -f $h.Path); $fail = $true
}

# --- scripts/: flag only when 'scripts/' appears as a path token; ignore this script itself
$scanNoSelf = $scan | Where-Object { $_.Name -ne 'repo-health.ps1' }
$scriptsHits = Select-String -Path $scanNoSelf.FullName -Pattern '(^|[^A-Za-z0-9_])scripts/' -ErrorAction SilentlyContinue
foreach ($h in ($scriptsHits | Sort-Object Path -Unique)) {
  Write-Warning ("{0}: scripts/" -f $h.Path); $fail = $true
}

if (-not $fail) { Write-Host "OK: no legacy refs." }


# Summary
$fail = ($JsonFailed.Count -gt 0) -or ($JsonlFailed.Count -gt 0) -or ($badJs.Count -gt 0) -or ($importExit -ne 0) -or ($legacyHits.Count -gt 0)
if ($fail) { Write-Error "Repo health: issues found."; exit 1 } else { Write-Host "`n✅ Repo health: all checks passed."; exit 0 }
