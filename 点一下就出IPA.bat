@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title 点一下授权，自动出 IPA

echo.
echo   马上会打开一个网页，你只要在那里点一下绿色的「允许」按钮。
echo   不用注册别的东西，不用复制任何长串字符，剩下的我自动做完。
echo.
where python >nul 2>nul
if errorlevel 1 (
  echo   没找到 Python，请先装 Python 3： https://www.python.org/downloads/
  pause
  exit /b 1
)
start "" "https://github.com/login/device"
echo.
python "%~dp0auto-ipa.py"
echo.
pause
