#!/usr/bin/env bash
# 一键启动脚本（Linux / macOS / Git Bash）
# 1) 安装依赖（腾讯镜像） 2) 启动账号服务端
set -euo pipefail

cd "$(dirname "$0")/../.."

export PATH="/c/Users/f2595/.workbuddy/binaries/PortableGit/versions/1.2.0/bin:/c/Windows/System32:/c/Windows:/usr/bin:/bin:$PATH"

NODE24="/c/Users/f2595/AppData/Local/Author Software/nvm/installs/v24.20.0/node.exe"
PNPM="$NODE24 C:/Users/f2595/AppData/Local/node/corepack/v1/pnpm/9.15.9/bin/pnpm.cjs"

echo "==> 安装依赖"
"$NODE24" "$PNPM" install --registry=https://mirrors.cloud.tencent.com/npm/ || {
  echo "pnpm 安装失败，请确认 Node 24 与 corepack 可用"
  exit 1
}

echo "==> 启动账号服务端（services/account）"
"$NODE24" services/account/src/server.ts
