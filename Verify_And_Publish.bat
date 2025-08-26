@echo off
setlocal
cd /d "%~dp0"
where pwsh >nul 2>&1 && (set "PS=pwsh") || (set "PS=powershell")

echo [health] Running repo checks...
"%PS%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File ".\tools\repo-health.ps1"
if errorlevel 1 (
  echo [health] ❌ Issues found. Not publishing. Fix and rerun.
  echo.
  pause
  exit /b 1
)

echo [mirror] Health OK — updating public mirror...
"%PS%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File ".\tools\mirror-update.ps1"
set ERR=%ERRORLEVEL%

if "%ERR%"=="0" (echo [mirror] ✅ Published) else (echo [mirror] ❌ Publish failed (%ERR%))
echo.
pause
endlocal
