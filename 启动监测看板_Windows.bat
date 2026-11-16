@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if %errorlevel% neq 0 (
  echo [提示] 未检测到 Node.js 环境！
  echo 请先前往 https://nodejs.org/ 下载并安装 LTS 版本（Node.js 20 或以上），或让电脑上的 WorkBuddy 自动帮你安装。
  pause
  exit /b 1
)

if "%PORT%"=="" set PORT=3688
echo 正在启动 A股实时股东人数监测台...
start "" cmd /c "timeout /t 2 /nobreak >nul && start http://127.0.0.1:%PORT%"
node src/server.mjs
pause
