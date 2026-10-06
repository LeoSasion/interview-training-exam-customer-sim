#!/usr/bin/env sh
# 启动后端服务（零依赖，只用 Node 22 内置模块）
#   ./start-server.sh            普通启动（读 server/.env.json 里的模型配置）
#   PORT=9000 ./start-server.sh  换端口
set -e
cd "$(dirname "$0")"
exec node server/index.js
