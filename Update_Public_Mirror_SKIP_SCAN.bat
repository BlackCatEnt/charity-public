@echo off
setlocal
cd /d "%~dp0"

REM ====== EDIT THESE IF YOUR PATHS CHANGE ======
set "SRC=C:\twitch-bot\Charity"
set "DEST=C:\repos\charity-public"
set "REPO=https://github.com/BlackCatEnt/charity-public.git"
set "BRANCH=main"
REM =============================================

where pwsh >nul 2>&1
if %errorlevel%==0 (
  set "PS=pwsh"
) else (
  set "PS=powershell"
)

echo [mirror] Staging + pushing public mirror (skip secret scan)...
"%PS%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\mirror-publish.ps1" ^
  -Source "%SRC%" -Dest "%DEST%" -RepoUrl "%REPO%" -Branch "%BRANCH%" -SkipScan

set "ERR=%ERRORLEVEL%"
if "%ERR%"=="0" (
  echo [mirror] ✅ Completed successfully.
) else (
  echo [mirror] ❌ Exited with code %ERR%.
)

echo.
pause
endlocal
