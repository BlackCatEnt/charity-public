param(
  [string]$Root = (Resolve-Path ".").Path,
  [string]$Out  = ".\Folder & Module Skeleton.md"
)

$ignore = '\\node_modules\\|\\\.git\\|\\Archive\\|\\relics\\\.queue\\|\\relics\\\.runtime\\|\\soul\\memory\\episodes\\|\\soul\\kb\\index\\|\\soul\\cache\\'
$lines = @("A:\Charity\")

$dirs = Get-ChildItem -Path $Root -Recurse -Directory | Where-Object { $_.FullName -notmatch $ignore } | Sort-Object FullName
$files = Get-ChildItem -Path $Root -Recurse -File | Where-Object { $_.FullName -notmatch $ignore } | Sort-Object FullName

function Indent([string]$p) {
  $rel = $p.Substring($Root.Length).TrimStart('\')
  $depth = ($rel -split '\\').Count
  return ('  ' * ($depth - 1))
}

foreach ($d in $dirs) {
  $lines += ("{0}{1}\" -f (Indent $d.FullName), ($d.Name))
}

foreach ($f in $files) {
  $lines += ("{0}{1}" -f (Indent $f.FullName), ($f.Name))
}

$header = @"
# Folder & Module Skeleton

*(Auto-generated; annotate with comments beneath as needed.)*

"@

Set-Content -Encoding UTF8 -Path $Out -Value ($header + ($lines -join "`r`n"))
Write-Host "Updated: $Out"
