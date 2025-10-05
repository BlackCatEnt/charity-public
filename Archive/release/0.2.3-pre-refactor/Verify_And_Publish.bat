@echo off
setlocal
cd /d "A:\Charity"
where pwsh >nul 2>&1 && (set "PS=pwsh") || (set "PS=powershell")

echo [health] Running repo checks...
"%PS%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File ".\tools\repo-health.ps1" || (
  echo [health] ❌ Issues found. Not publishing.
  echo.
  pause
  exit /b 1
)

echo [scan] Strict TruffleHog (will block on verified secrets)...
"%PS%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File ".\tools\publish.ps1" ^
  -Source "A:\Charity" ^
  -Dest   "A:\repos\charity-public" ^
  -RepoUrl "https://github.com/BlackCatEnt/charity-public.git" ^
  -Branch "main" -Strict

set ERR=%ERRORLEVEL%
if "%ERR%"=="0" (echo [mirror] ✅ Published) else (echo [mirror] ❌ Publish failed (%ERR%))
echo.
pause
endlocal
