param(
  [string]$Source  = "A:\Charity",
  [string]$Dest    = "A:\repos\charity-public",
  [string]$RepoUrl = "https://github.com/BlackCatEnt/charity-public.git",
  [string]$Branch  = "main",
  [switch]$SkipScan,
  [switch]$Strict
)

$ErrorActionPreference = "Stop"
$me = Split-Path -Parent $MyInvocation.MyCommand.Path
$mirror = Join-Path $me "mirror-publish.ps1"

if (!(Test-Path $mirror)) {
  throw "mirror-publish.ps1 not found at $mirror"
}

Write-Host ">> Publishing sanitized mirror..."
& pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File $mirror `
  -Source $Source -Dest $Dest -RepoUrl $RepoUrl -Branch $Branch `
  @($SkipScan ? "-SkipScan" : $null) @($Strict ? "-Strict" : $null)
