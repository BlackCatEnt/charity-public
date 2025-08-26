@echo off
setlocal
REM ----- Run from the folder where this .bat lives -----
cd /d "%~dp0"

REM ----- Prefer PowerShell 7 (pwsh), fall back to Windows PowerShell -----
where pwsh >nul 2>&1
if %errorlevel%==0 (
  set "PS=pwsh"
) else (
  set "PS=powershell"
)

echo [mirror] Starting public mirror update via tools\mirror-update.ps1...
"%PS%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\mirror-update.ps1"
set "ERR=%ERRORLEVEL%"

if "%ERR%"=="0" (
  echo [mirror] ✅ Completed successfully.
) else (
  echo [mirror] ❌ Exited with code %ERR%.
)

echo.
pause
endlocal
