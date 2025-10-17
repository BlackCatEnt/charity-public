param(
  [string]$Hall = "tavern",
  [string]$Kind = "ping"
)

$root   = Split-Path -Parent (Split-Path -Parent $PSScriptRoot) # repo root
$inbox  = Join-Path $root "relics\.queue\incoming"
New-Item -ItemType Directory -Force -Path $inbox | Out-Null

# Use a fixed ts so Keeper's event_id hash is identical on both lines
$ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

$rec = @{
  hall = $Hall
  kind = $Kind
  ts   = $ts
  body = @{ hello = "world"; smoke = "dup" }
}

$line = ($rec | ConvertTo-Json -Compress)

$stamp = Get-Date -Format "yyyyMMdd-HHmmss-ffff"
$out   = Join-Path $inbox "dup-$stamp.jsonl"

# Write the SAME line twice → same event_id → Scribe should drop second
$line | Out-File -FilePath $out -Encoding utf8
$line | Out-File -FilePath $out -Encoding utf8 -Append

Write-Host "wrote $out"
