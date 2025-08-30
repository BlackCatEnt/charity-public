param(
  [string]$Source  = "A:\Charity",
  [string]$Dest    = "A:\repos\charity-public",
  [string]$RepoUrl = "https://github.com/BlackCatEnt/charity-public.git",
  [string]$Branch  = "main",
  [switch]$SkipScan,   # skip TruffleHog scan
  [switch]$Strict      # fail if verified secrets are found
)

$ErrorActionPreference = "Stop"

# --------------------------- Helpers ----------------------------------------
function Copy-SafeTree {
  param($Src, $Dst)

  $include = @(
    "docs","modular_phase2","tools","config",
    "package.json","package-lock.json","README.md","README_PUBLISHING.md","PROJECT_MAP.json"
  )

  # Exclude sensitive/huge content + archive
  $excludeDirs  = @("node_modules","data","logs",".git",".github",".vscode","models","Archive")
  $excludeFiles = @(
    "*.log","*.sqlite","*.db","*.pem","*.pfx","*.crt","*.key",".env","token*.json",
    "*.onnx","*.pt","*.bin","*.gguf",
    # service/admin scripts we don’t want mirrored
    "install-service.ps1","remove-service.ps1","restart-bot.ps1","update-bot.ps1",
    "check-bot-status.ps1","health-check.ps1"
  )

  if (!(Test-Path $Dst)) { New-Item -ItemType Directory -Path $Dst | Out-Null }

  # Clear everything except .git (keep mirror repo history)
  Get-ChildItem -Force $Dst | Where-Object { $_.Name -ne ".git" } |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

  foreach ($i in $include) {
    $srcPath = Join-Path $Src $i
    if (Test-Path $srcPath) {
      robocopy $srcPath (Join-Path $Dst $i) /E /NFL /NDL /NJH /NJS /XD $excludeDirs /XF $excludeFiles | Out-Null
    }
  }

  # Safety sweep: remove any excluded files/dirs that slipped in
  foreach ($pattern in $excludeFiles) {
    Get-ChildItem -Path $Dst -Recurse -Force -File -Include $pattern |
      Remove-Item -Force -ErrorAction SilentlyContinue
  }
  Get-ChildItem -Path $Dst -Recurse -Force -Directory |
    Where-Object { $excludeDirs -contains $_.Name } |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
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
  Push-Location $Dst
  try {
    $map = @()
    Get-ChildItem -Path . -Recurse -File -Force | ForEach-Object {
      $rel = Resolve-Path $_.FullName -Relative
      $sha = (Get-FileHash $_.FullName -Algorithm SHA1).Hash
      $map += [PSCustomObject]@{ path = $rel; sha1 = $sha }
    }
    $map | ConvertTo-Json -Depth 4 | Out-File -Encoding UTF8 (Join-Path $Dst "PROJECT_MAP.json")
  } finally {
    Pop-Location
  }
}

# ----------------------- Stage sanitized copy --------------------------------
Write-Host "Staging sanitized copy..."
Copy-SafeTree -Src $Source -Dst $Dest
Ensure-ExampleConfig -Src $Source -Dst $Dest
Write-ProjectMap -Dst $Dest

# ----------------------- TruffleHog secret scan ------------------------------
if (-not $SkipScan) {
  $th = Get-Command trufflehog -ErrorAction SilentlyContinue
  if ($th) {
    Write-Host "Running TruffleHog..."
    Push-Location $Dest
    try {
      $reportDir = Join-Path $Dest "reports"
      New-Item -ItemType Directory -Path $reportDir -Force | Out-Null
      $ts        = Get-Date -Format "yyyyMMdd-HHmmss"
      $gitReport = Join-Path $reportDir "trufflehog-git-$ts.json"
      $fsReport  = Join-Path $reportDir "trufflehog-fs-$ts.json"

      # Windows-safe file:// URI for the current repo (e.g., file:///A:/repos/charity-public)
      $repoUri = [System.Uri]::new((Resolve-Path ".")).AbsoluteUri

      # Prefer git scanner (examines history)
      $gitOut = & trufflehog git $repoUri --only-verified --json --no-update 2>&1 `
                | Tee-Object -FilePath $gitReport
      $gitCode = $LASTEXITCODE
      $gitTxt  = (Get-Content $gitReport -Raw -ErrorAction SilentlyContinue)

      $needFallback = ($gitCode -ne 0) -or
                      ($gitOut | Out-String) -match 'failed to clone|error preparing repo|fatal:' -or
                      ($gitTxt -match '"encountered errors during scan"')

      if ($needFallback) {
        Write-Warning "TruffleHog git scan failed or unreliable; falling back to filesystem scan."
        $fsOut  = & trufflehog filesystem --directory "." --only-verified --json 2>&1 `
                   | Tee-Object -FilePath $fsReport
        $code   = $LASTEXITCODE
        $report = $fsReport
        $txt    = (Get-Content $fsReport -Raw -ErrorAction SilentlyContinue)
      } else {
        $code   = $gitCode
        $report = $gitReport
        $txt    = $gitTxt
      }

      # Determine if verified secrets exist (independent of exit code quirks)
      $hasVerified = $false
      if ($txt) {
        if ($txt -match '"verified_secrets"\s*:\s*(\d+)') {
          if ([int]$Matches[1] -gt 0) { $hasVerified = $true }
        } elseif ($txt -match '"verified"\s*:\s*true') {
          $hasVerified = $true
        }
      }

      if ($Strict -and $hasVerified) {
        Write-Error "TruffleHog reported VERIFIED findings. See: $report"
        exit 2
      } elseif ($hasVerified) {
        Write-Warning "TruffleHog reported findings (non-blocking). See: $report"
      } else {
        Write-Host "TruffleHog: no verified findings."
      }
    } finally {
      Pop-Location
    }
  } else {
    Write-Warning "trufflehog not found; skipping scan."
  }
} else {
  Write-Host "Skipping TruffleHog scan (-SkipScan)."
}

# ----------------------- Git init / commit / push ----------------------------
Push-Location $Dest
try {
  if (!(Test-Path ".git")) { git init | Out-Null }

  # ensure branch
  $head = (git rev-parse --abbrev-ref HEAD 2>$null)
  if (-not $head -or $head -eq "HEAD") { git branch -M $Branch }

  # ensure remote
  $hasRemote = (git remote 2>$null) -contains "origin"
  if (-not $hasRemote) { git remote add origin $RepoUrl }

  git add -A
  if ((git status --porcelain).Length -gt 0) {
    git commit -m "mirror: update public snapshot"
  } else {
    Write-Host "No changes to commit."
  }

  git push -u origin $Branch
  $pushCode = $LASTEXITCODE
  if ($pushCode -ne 0) {
    Write-Warning "Initial push failed (likely non-fast-forward). Fetch + retrying with --force-with-lease..."
    git fetch origin
    git push -u origin $Branch --force-with-lease
    if ($LASTEXITCODE -ne 0) {
      Write-Error "Push failed after retry. Try: git pull --ff-only, or check remote branch protections."
      exit 4
    }
  }
} finally {
  Pop-Location
}
Write-Host "✅ Public mirror updated & pushed."
