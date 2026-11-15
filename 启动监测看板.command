#!/bin/zsh
cd "$(dirname "$0")" || exit 1
PORT=${PORT:-3688}

echo "正在启动 A股实时股东人数监测台（已开启防休眠与手机双通道公网穿透）..."
(sleep 1.2 && open "http://127.0.0.1:${PORT}") &
caffeinate -i node src/server.mjs
