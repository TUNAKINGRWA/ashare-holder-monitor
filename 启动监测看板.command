#!/bin/zsh
cd "$(dirname "$0")" || exit 1

# 自动加载常见 Node 安装路径（Homebrew / nvm / fnm / Volta / 官方安装包）
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.volta/bin:$PATH"
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  source "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "❌ 未检测到 Node.js 运行环境！"
  echo "👉 请先打开 https://nodejs.org/ 下载安装 LTS 版本（需 >= 20），或把这个文件夹发给 WorkBuddy 帮你自动安装。"
  read -k 1 "?按任意键退出..."
  exit 1
fi

PORT=${PORT:-3688}
echo "🚀 正在启动 A股实时股东人数监测台（已开启防休眠守护与手机公网穿透）..."
(sleep 1.5 && open "http://127.0.0.1:${PORT}") &
caffeinate -i node src/server.mjs
