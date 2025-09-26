param(
  [string]$Branch = "v0.3-next",
  [string]$Msg = "chore: publish $(Get-Date -Format s)"
)

$ErrorActionPreference = "Stop"

function Step($text) { Write-Host "▸ $text" -ForegroundColor Cyan }
function Ok($text)   { Write-Host "✓ $text" -ForegroundColor Green }
function Run($cmd)   { Write-Host "→ $cmd" -ForegroundColor DarkGray; iex $cmd }

try {
  Step "Preflight"
  Run "npm run preflight"

  Step "Git sanity"
  Run "git rev-parse --is-inside-work-tree"
  $remotes = git remote -v
  if (-not $remotes) { throw "No git remotes configured. Add 'origin' first (git remote add origin <url>)." }
  Ok "Repo & remotes OK"

  Step "Commit"
  $changes = git status --porcelain
  if ($changes) {
    Run "git add -A"
    # commit can still fail if author is not set
    Run "git commit -m `"$Msg`""
    Ok "Committed changes"
  } else {
    Ok "No changes to commit"
  }

  Step "Branch"
  Run "git branch -M $Branch"

  Step "Push to origin"
  Run "git push -u origin $Branch"

  Step "Push to public (if configured)"
  $hasPublic = (git remote | Select-String -Quiet "^public$")
  if ($hasPublic) {
    Run "git push -u public $Branch"
  } else {
    Write-Host "(no 'public' remote; skipping)" -ForegroundColor Yellow
  }

  Ok "Published to $Branch"
}
catch {
  Write-Host "✗ Error: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "   (Re-run with -Verbose to see more PowerShell details.)"
  exit 1
}
