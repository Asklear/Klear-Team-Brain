#!/bin/sh
# 容器启动：备好 /data → 设 git 身份（真相库 commit 用）→ 没 token 就自举一个 → 起 server。
set -e

mkdir -p /data/config /data/truth

# 真相库是 git 仓，commit 需要身份；容器里 truth 属主可能与运行用户不一致 → 标 safe.directory。
git config --global user.email "brain@localhost" 2>/dev/null || true
git config --global user.name  "team-brain"      2>/dev/null || true
git config --global --add safe.directory /data/truth 2>/dev/null || true

# 卷上没 token（首启、或没先在宿主跑 quickstart）→ 现签一个单成员 + token 并打印出来，让这台机子开箱即用。
# 已有 tokens.yaml（绑定挂载/上次自举）则原样用，不覆盖。
if [ ! -f "$TOKENS_FILE" ]; then
  echo "[entrypoint] 首次启动：$TOKENS_FILE 不存在 → 自举一个本地成员 + token"
  node /app/scripts/quickstart.mjs --server-bootstrap --id "${BRAIN_ID:-owner}" --name "${BRAIN_NAME:-Owner}" || true
fi

exec node /app/server/server.mjs
