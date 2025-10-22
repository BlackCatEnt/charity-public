# relics/helpers/pw-delete-job.ps1
[CmdletBinding()]
param(
  [Parameter(Position=0)]
  [string]$Job,
  [string]$PushUrl = $(if ($env:PUSHGATEWAY_URL) { $env:PUSHGATEWAY_URL } else { "http://localhost:9091" })
)

Set-StrictMode -Version Latest

if (![string]::IsNullOrWhiteSpace($env:SCRIBE_JOB) -and [string]::IsNullOrWhiteSpace($Job)) {
  $Job = $env:SCRIBE_JOB
}
if ([string]::IsNullOrWhiteSpace($Job)) {
  $Job = "scribe-smoke"
}

$endpoint = ("{0}/metrics/job/{1}" -f $PushUrl.TrimEnd('/'), [uri]::EscapeDataString($Job))
Write-Host ("Deleting Pushgateway job: {0}" -f $endpoint)

try {
  Invoke-RestMethod -Method DELETE -Uri $endpoint | Out-Null
  Write-Host ("OK: deleted {0}" -f $Job)
  exit 0
}
catch {
  # Use -f formatting or ${Job} so the colon isn’t mistaken as a scope qualifier
  Write-Warning ("Failed to delete {0}: {1}" -f $Job, $_.Exception.Message)
  exit 1
}
