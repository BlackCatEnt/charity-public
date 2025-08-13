# scripts/patch-index-env.ps1
# Patches data\index.js to import ./env-bootstrap.js and assertRequiredEnv(),
# and removes any previous dotenv/path/url imports or dotenv.config() calls.
# Run from anywhere (paths are absolute).

$IndexPath = "C:\twitch-bot\Charity\data\index.js"
if (-not (Test-Path $IndexPath)) { Write-Error "index.js not found at $IndexPath"; exit 1 }

$js = Get-Content $IndexPath -Raw

# Remove old imports/configs that could conflict
$patterns = @(
  '^\s*import\s+path\s+from\s+["'']path["''];\s*\r?\n',
  '^\s*import\s+\{\s*fileURLToPath\s*\}\s+from\s+["'']url["''];\s*\r?\n',
  '^\s*import\s+dotenv\s+from\s+["'']dotenv["''];\s*\r?\n',
  '^\s*import\s+\{\s*assertRequiredEnv\s*\}\s+from\s+["'']\./env-bootstrap\.js["''];\s*\r?\n',
  '^\s*import\s+["'']\./env-bootstrap\.js["''];\s*\r?\n',
  'dotenv\.config\(\s*\{[\s\S]*?\}\s*\);\s*',
  '^\s*dotenv\.config\(\s*\);\s*\r?\n'
)

foreach ($p in $patterns) {
  $js = [regex]::Replace($js, $p, '', 'Multiline, IgnoreCase')
}

# Prepend clean header (simple and safe)
$header = "import './env-bootstrap.js';`r`nimport { assertRequiredEnv } from './env-bootstrap.js';`r`nassertRequiredEnv();`r`n"
$js = $header + $js

Set-Content -Path $IndexPath -Value $js -Encoding UTF8
Write-Host "Patched data\index.js to use env-bootstrap.js and assert required vars." -ForegroundColor Green
