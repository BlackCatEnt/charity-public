cd A:\repos\charity-public

$files = @(
  'rituals\feedback\2025-09\feedback.jsonl',
  'soul\kb\charity-bio.jsonl',
  'soul\kb\charity-northstar.jsonl',
  'soul\kb\games.jsonl'
)

foreach ($f in $files) {
  if (-not (Test-Path $f)) { Write-Host "Missing: $f"; continue }
  Write-Host "Checking $f"
  $ln = 0
  Get-Content $f | ForEach-Object {
    $ln++
    $line = $_.Trim()
    if ($line -eq '') { return }
    try { $null = $line | ConvertFrom-Json } catch {
      Write-Host "$f:$ln -> $($_.Exception.Message)"
      Write-Host ("  > " + ($line.Substring(0, [Math]::Min($line.Length, 200))))
    }
  }
}
