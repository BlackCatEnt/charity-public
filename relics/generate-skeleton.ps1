param(
  [string]$Root = (Resolve-Path ".").Path,
  [string]$Out  = ".\Folder & Module Skeleton.md",
  [int]$MaxDepth = 3
)

$ignore = '\\node_modules\\|\\\.git\\|\\Archive\\|\\relics\\\.queue\\|\\relics\\\.runtime\\|\\soul\\memory\\episodes\\|\\soul\\kb\\index\\|\\soul\\cache\\'
$exts = '(\.mjs|\.js|\.json|\.jsonl|\.md|\.ps1|\.yml|\.yaml)$'

function DepthOf([string]$abs) {
  $rel = $abs.Substring($Root.Length).TrimStart('\')
  if ($rel -eq '') { return 0 }
  return ($rel -split '\\').Count
}

$dirs = Get-ChildItem -Path $Root -Recurse -Directory |
  Where-Object { $_.FullName -notmatch $ignore -and (DepthOf $_.FullName) -le $MaxDepth } |
  Sort-Object FullName

$files = Get-ChildItem -Path $Root -Recurse -File |
  Where-Object { $_.FullName -notmatch $ignore -and $_.Name -match $exts -and (DepthOf $_.FullName) -le $MaxDepth } |
  Sort-Object FullName

function Indent([int]$d) { return '  ' * $d }

$lines = @()
$lines += "# Folder & Module Skeleton"
$lines += ""
$lines += "_(Auto-generated; depth = $MaxDepth)_"
$lines += ""
$lines += "A:\Charity\"

foreach ($d in $dirs) {
  $depth = DepthOf $d.FullName
  $lines += ("{0}{1}\" -f (Indent ($depth-1)), $d.Name)
  # list immediate files under this directory (within depth)
  $immediate = $files | Where-Object { (Split-Path $_.FullName -Parent) -eq $d.FullName }
  foreach ($f in $immediate) {
    $lines += ("{0}{1}" -f (Indent $depth), $f.Name)
  }
}

Set-Content -Encoding UTF8 -Path $Out -Value ($lines -join "`r`n")
Write-Host "Updated: $Out"
