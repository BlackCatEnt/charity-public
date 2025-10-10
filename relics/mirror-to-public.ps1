param(
  [string]$SourceBranch = "v0.3-next",
  [string]$DestBranch   = "v0.3-next",
  [string]$SourceRemote = "origin",
  [string]$PublicRemote = "public",
  [string]$WorktreePath = ".public-mirror",
  [switch]$DryRun
)


$ErrorActionPreference = "Stop"

function Require-CleanTree {
  $status = (git status --porcelain)
  if ($status) {
    throw "Working tree is dirty. Commit or stash before mirroring."
  }
}

function Require-Remotes {
  param([string]$Src,[string]$Dst)
  $remotes = (git remote)
  if ($remotes -notmatch $Src) { throw "Missing '$Src' remote." }
  if ($remotes -notmatch $Dst) { throw "Missing '$Dst' remote." }
}

function Ensure-BranchUpToDate {
  param([string]$Src,[string]$Branch)
  git fetch $Src
  git fetch $PublicRemote
  git checkout $Branch
  git pull --ff-only $Src $Branch
}

function New-PublicWorktree {
  param([string]$WorktreePath,[string]$DstRemote,[string]$DstBranch)

  git worktree remove $WorktreePath --force 2>$null
  if (Test-Path $WorktreePath) { Remove-Item -Recurse -Force $WorktreePath }

  git fetch $DstRemote --prune

  # Create a detached worktree (no branch conflicts with main repo)
  git worktree add --detach $WorktreePath

  pushd $WorktreePath | Out-Null
  # If the dest branch exists on the public remote, anchor HEAD there so diffs are minimal
  if (git rev-parse --verify --quiet "refs/remotes/$DstRemote/$DstBranch") {
    git reset --hard "$DstRemote/$DstBranch"
  } else {
    # orphan start: empty tree for first publish
    git checkout --orphan $DstBranch
    git rm -r --cached . 2>$null
    if (Test-Path .) {
      Get-ChildItem -Force | Where-Object { $_.Name -ne ".git" } | Remove-Item -Recurse -Force
    }
    # leave HEAD on the new orphan branch; still safe because main worktree owns the same name
    # (we're in a separate worktree, so it's allowed)
  }
  popd | Out-Null
}


function Copy-Curated {
  param([string]$Src, [string]$Dst, [switch]$ListOnly)

  # Robocopy options:
  # /MIR mirror (careful: deletes stray files in Dst)
  # /XD exclude directories, /XF exclude files
  # /NFL /NDL less noise; /NP no progress; /NJH /NJS no headers/summary
  # /R:1 /W:1 quick retry
  # /L  list only (dry-run)
  $flags = @("/MIR","/NFL","/NDL","/NP","/NJH","/NJS","/R:1","/W:1")
  if ($ListOnly) { $flags += "/L" }

  $excludeDirs = @(
    ".git",".github","node_modules",".vscode",".idea",
    "relics\.runtime","relics\.runtime\logs","relics\.runtime\cache",
    "sentry","logs",".cache"
  )
  $excludeFiles = @(
    ".env",".env.*","*.log","*.tmp","npm-debug.log","yarn-error.log"
  )

  # Build /XD and /XF lists
  $xd = @(); $xf = @()
  foreach($d in $excludeDirs){ $xd += @("/XD", (Join-Path $Src $d)) }
  foreach($f in $excludeFiles){ $xf += @("/XF", (Join-Path $Src $f)) }

  robocopy $Src $Dst *.* $flags $xd $xf | Out-Null
}

function Commit-And-Push {
  param([string]$WorktreePath)

  Push-Location $WorktreePath
  try {
    git checkout -B $Branch
    git add -A
    $changes = (git status --porcelain)
    if (-not $changes) {
      Write-Host "No changes to publish."
      return
    }
    $srcHash = (git -C (Split-Path -Parent $WorktreePath) rev-parse --short=12 HEAD)
    git commit -m "mirror: sync curated files from private @ $srcHash"
    git push $PublicRemote $Branch --force-with-lease
    Write-Host "Pushed to '$PublicRemote' $Branch."
  }
  finally { Pop-Location }
}

# ----- main -----
Require-Remotes -Src $SourceRemote -Dst $PublicRemote
Require-CleanTree
Ensure-BranchUpToDate -Src $SourceRemote -Branch $SourceBranch
Require-Remotes -Src $SourceRemote -Dst $PublicRemote
Ensure-BranchUpToDate -Src $SourceRemote -Branch $SourceBranch

New-PublicWorktree -WorktreePath $WorktreePath -DstRemote $PublicRemote -DstBranch $DestBranch
Sync-Contents -SrcPath "." -DstPath $WorktreePath -WhatIf:$DryRun
Push-Public  -WorktreePath $WorktreePath -DstRemote $PublicRemote -DstBranch $DestBranch -WhatIf:$DryRun

$worktree = ".public-mirror"
Write-Host "Preparing worktree at $worktree for '$PublicRemote/$Branch'…"

try {
  $src = (Get-Location).Path
  $dst = (Resolve-Path $worktree).Path

  Write-Host ("{0} curated copy private → public worktree…" -f ($DryRun ? "DRY-RUN:" : "Starting"))
  Copy-Curated -Src $src -Dst $dst -ListOnly:$DryRun

  if ($DryRun) {
    Write-Host "Dry-run complete. No files written. Rerun without -DryRun to publish."
    return
  }

  Commit-And-Push -WorktreePath $dst
  git checkout -B $DestBranch
  git push $PublicRemote $DestBranch --force-with-lease
}
finally {
  # Detach and clean the worktree safely
  try { git worktree remove $worktree --force } catch { }
}
