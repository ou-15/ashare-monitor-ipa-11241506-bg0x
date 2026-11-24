@echo off
chcp 65001 >nul
title A-Share Sentiment Monitor
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo Python 3 was not found. Install it from https://www.python.org/downloads/
  echo Then run this file again.
  pause
  exit /b 1
)

if exist runtime_port.txt del runtime_port.txt
start "Data Service" /MIN python server.py

set "APPPORT="
set "TRY=0"
:waitport
if defined APPPORT goto gotport
set /a TRY+=1
if %TRY% GEQ 25 goto noport
timeout /t 1 >nul
if exist runtime_port.txt set /p APPPORT=<runtime_port.txt
goto waitport
:gotport
if not defined APPPORT set "APPPORT=8765"
:noport
if not defined APPPORT set "APPPORT=8765"
set "APPURL=http://127.0.0.1:%APPPORT%"
set "EDGE="

if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not defined EDGE if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not defined EDGE if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "EDGE=%LocalAppData%\Google\Chrome\Application\chrome.exe"

if defined EDGE (
  start "" "%EDGE%" --app=%APPURL% --window-size=1280,920 --no-first-run
) else (
  start "" %APPURL%
)

echo.
echo App window opened: %APPURL%
echo Fund estimator page: %APPURL%/fund
echo The minimized "Data Service" window is the live data server; close it to stop.
echo.
