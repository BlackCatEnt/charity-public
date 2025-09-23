# Clean old chunks so uploader never sees stale high indexes

param(
  [string]$NDISourceName = "GuildCast",
  # Devices on your box:
  [string]$VBIn  = "CABLE Input (VB-Audio Virtual Cable)",   # NDI plays into this
  [string]$VBOut = "CABLE Output (VB-Audio Virtual Cable)",  # ffmpeg captures from this
  [int]$ASRPort  = 8123,
  [int]$HallPort = 8130,
  [string]$Game = "Unknown",
  [string]$Scene = "Gameplay",
  [string]$Speaker = "bagotrix"
)

$chunkDir = "A:\Charity\temp\asr_chunks"
if (Test-Path $chunkDir) {
  Get-ChildItem $chunkDir -Filter *.wav -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
}

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location (Join-Path $root "..")

# Find NDI FreeAudio (handles both exe names on Windows)
$ndiExeCandidates = @(
  "C:\Program Files\NDI\NDI 6 Free Audio\x64\NDI FreeAudio.exe",
  "C:\Program Files\NDI\NDI 6 Free Audio\x64\NDI Free Audio.exe",
  "C:\Program Files\NDI\NDI Tools\x64\NDI FreeAudio.exe",
  "C:\Program Files\NDI\NDI Tools\x64\NDI Free Audio.exe"
)
$ndiExe = $ndiExeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $ndiExe) { throw "NDI FreeAudio.exe not found. Update path in script." }

# Folders
New-Item -ItemType Directory -Force "temp\asr_chunks" | Out-Null

# 1) Start/verify ASR service
try {
  Invoke-RestMethod "http://127.0.0.1:$ASRPort/health" -TimeoutSec 2 | Out-Null
} catch {
  Write-Host "Starting ASR service on port $ASRPort..."
  Start-Process -NoNewWindow powershell -ArgumentList "-NoProfile -ExecutionPolicy Bypass -Command `"cd A:\Charity\adapters\asr.service; .\.venv\Scripts\Activate.ps1; uvicorn main:app --host 127.0.0.1 --port $ASRPort`"" | Out-Null
  Start-Sleep -Seconds 2
}

# 2) Start the audio hall (env carries tags & port)
try {
  $null = Invoke-RestMethod "http://127.0.0.1:$HallPort/health" -TimeoutSec 2
  Write-Host "Audio hall is online at http://127.0.0.1:$HallPort"
} catch {
  throw "Audio hall not responding on port $HallPort. Start Charity first (npm start)."
}

# 3) NDI -> VB-Cable (receive OBS NDI into CABLE Input)
Write-Host ("NDI source '" + $NDISourceName + "' -> local device '" + $VBIn + "'")
# NOTE: quote the device *inside* the argument so spaces/() are preserved
Start-Process -NoNewWindow $ndiExe -ArgumentList @(
  '-output', "`"$VBIn`"",
  '-output_name', "`"$NDISourceName`""
) | Out-Null
Start-Sleep -Seconds 1

# --- Python resolver (robust) ---
$VenvPy = "A:\Charity\relics\vad_streamer\.venv311\Scripts\python.exe"
$PyExe = $null
$PyArgsPrefix = @()   # e.g., '-3.11' when using the py launcher

if (Test-Path $VenvPy) {
  $PyExe = $VenvPy
} elseif (Get-Command python -ErrorAction SilentlyContinue) {
  $PyExe = (Get-Command python).Source
} elseif (Get-Command py -ErrorAction SilentlyContinue) {
  $PyExe = "py"
  $PyArgsPrefix = @("-3.11")
} else {
  throw "No Python interpreter found. Install Python 3.11 or ensure your venv exists at $VenvPy"
}

# sanity log
Write-Host "[ingest] using python -> $PyExe $($PyArgsPrefix -join ' ')"

function Invoke-Python {
  param([string[]]$Args)
  if ($PyArgsPrefix.Count -gt 0) {
    & $PyExe @PyArgsPrefix @Args
  } else {
    & $PyExe @Args
  }
  if ($LASTEXITCODE -ne 0) {
    throw "Python exited with code $LASTEXITCODE"
  }
}

# --- VAD streamer (read from the VB-Cable monitor) ---
# --- config you already have/expect ---
$ASR     = "http://127.0.0.1:8123/transcribe"
$HALL    = "http://127.0.0.1:8130/asr"

# these should be set earlier in your script or passed in:
# $InputDevice  = "CABLE Output (VB-Audio Virtual Cable)"
# $Speaker, $Game, $Scene

# Build the arg list so PowerShell doesn't parse --flags
$argsVAD = @(
  $Streamer,
  "--input",     $InputDevice,
  "--sr",        "16000",
  "--frame_ms",  "20",
  "--vad",       "2",
  "--start_ms",  "240",
  "--end_ms",    "650",
  "--max_ms",    "12000",
  "--asr",       $ASR,
  "--hall",      $HALL,
  "--speaker",   $Speaker,
  "--game",      $Game,
  "--scene",     $Scene,
  "--origin",    "stream"
)

# Launch in the foreground (or use Start-Process if you want it detached)
Invoke-Python -Args $argsVAD


# 5) Uploader: WAV -> ASR -> audio hall (with tags)
$env:ASR_URL  = "http://127.0.0.1:$ASRPort/transcribe"
$env:HALL_URL = "http://127.0.0.1:$HallPort/asr"
Start-Process -NoNewWindow node -ArgumentList "relics\asr-chunk-uploader.mjs" | Out-Null

Write-Host ("OK: NDI '" + $NDISourceName + "' -> '" + $VBIn + "' -> '" + $VBOut + "' -> ASR:" + $ASRPort + " -> Hall:" + $HallPort)
