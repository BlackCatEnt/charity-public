param(
  [int]$Count = 1,
  [string]$Hall = "guildhall",
  [string]$Kind = "smoke"
)

$queue = "A:\Charity\relics\.queue\incoming"
New-Item -ItemType Directory -Force -Path $queue | Out-Null

for ($i=0; $i -lt $Count; $i++) {
  $rec = @{ hall=$Hall; kind=$Kind; msg="keeper test"; ts=[DateTime]::UtcNow.ToString("o") } | ConvertTo-Json -Compress
  $file = Join-Path $queue ("smoke-{0:yyyyMMdd-HHmmss}-{1}.jsonl" -f (Get-Date), [Guid]::NewGuid().ToString("N"))
  "$rec`n" | Out-File -FilePath $file -Encoding utf8
  Write-Host "wrote $file"
}
