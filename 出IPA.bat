@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title 情绪监测 + 基金估值 - 生成未签名 IPA

echo ============================================================
echo   生成 IPA 文件（高级选项，平时不需要）
echo ============================================================
echo.
echo  这个窗口不是 IPA 本体，它是「借云端苹果电脑帮忙编译」的
echo  启动器，所以要问你要一串 GitHub 账号的临时钥匙。
echo  没有这串钥匙很正常，直接关掉窗口就行。
echo.
echo  只是想在 iPhone 上用这个 App 的话：
echo    手机连同一个 WiFi，用 Safari 打开电脑地址，
echo    点「分享」-「添加到主屏幕」，桌面就有图标了。
echo    具体地址见聊天里的说明。
echo.
echo  确实要 IPA 文件才继续：用浏览器打开
echo    https://github.com/settings/tokens/new
echo  勾选 repo 和 workflow，生成后把那串字符粘进来。
echo  （钥匙不会保存、不会打印、不会上传）
echo.
echo ------------------------------------------------------------
echo  手机安装地址（手机连同一个 WiFi 时用）：
powershell -NoProfile -Command "Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | ForEach-Object { '    http://' + $_.IPAddress + ':8765' }" 2>nul
echo.
set "TOKEN="
set /p "TOKEN=粘贴钥匙后回车（没有就直接回车退出）: "
if "%TOKEN%"=="" (
  echo.
  echo  没关系，已退出。用上面的地址在 iPhone 的 Safari 里打开，
  echo  点「分享」-「添加到主屏幕」，就能像 App 一样用了。
  pause
  exit /b 0
)
echo.
where python >nul 2>nul
if errorlevel 1 (
  echo 未找到 Python，请先安装 Python 3： https://www.python.org/downloads/
  pause
  exit /b 1
)
python "%~dp0get-ipa.py" "%TOKEN%"
echo.
echo ============================================================
pause
