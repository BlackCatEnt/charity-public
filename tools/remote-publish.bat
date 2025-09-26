@echo off
setlocal EnableExtensions
set SERVER=192.168.0.49
set PORT=5985
set REMOTE_SCRIPT=A:\Charity\tools\Publish-Charity.ps1

for /f "tokens=1-3 delims=/- " %%a in ("%date%") do set D=%%c%%a%%b
for /f "tokens=1-3 delims=:." %%a in ("%time%") do set T=%%a%%b%%c
set LOG=%~dp0remote-publish-%D%_%T%.log

echo Starting remote publish... > "%LOG%"
powershell -NoLogo -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop';" ^
  "$cred = Get-Credential -Message 'Enter server creds';" ^
  "$s = New-PSSession -ComputerName %SERVER% -Port %PORT% -UseSSL:$false -Credential $cred;" ^
  "try { Invoke-Command -Session $s -ScriptBlock { param($p) & $p -Branch 'auto' } -ArgumentList '%REMOTE_SCRIPT%' -ErrorAction Stop }" ^
  "catch { Write-Host 'ERROR:' $_.Exception.Message; if ($_.ScriptStackTrace) { Write-Host $_.ScriptStackTrace } exit 1 }" ^
  "finally { if ($s) { Remove-PSSession $s } }" ^
  1>>\"%LOG%\" 2>>&1

set ERR=%ERRORLEVEL%
echo Exit code: %ERR% >> "%LOG%"
type "%LOG%"
echo.
echo Log saved to: %LOG%
pause
endlocal
