#!/usr/bin/env bash
# 一键安装：装依赖 + 注册全局 brain 命令。目标：clone → ./install.sh → brain setup → brain service install
set -euo pipefail
cd "$(dirname "$0")"

command -v node >/dev/null || { echo "✗ 需要先装 Node 22+：https://nodejs.org"; exit 1; }
node -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)' \
  || { echo "✗ Node 版本太低（当前 $(node -v)），需要 22+：https://nodejs.org"; exit 1; }
echo "[brain] Node $(node -v) ✓"

echo "[brain] 装依赖…"
npm install --silent

chmod +x cli/brain.mjs

echo "[brain] 注册全局 brain 命令…"
if npm link >/dev/null 2>&1; then
  echo "[brain] ✓ 已注册（npm link）"
else
  # 回退：软链到用户 PATH 目录（避免 sudo）
  TARGET="$HOME/.local/bin"
  mkdir -p "$TARGET"
  ln -sf "$PWD/cli/brain.mjs" "$TARGET/brain"
  echo "[brain] ✓ 已软链到 $TARGET/brain"
  case ":$PATH:" in
    *":$TARGET:"*) ;;
    *) echo "[brain] ⚠ $TARGET 不在 PATH，加一行到你的 ~/.zshrc：  export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
  esac
fi

echo
echo "下一步："
echo "  brain setup             # 填 token / 工作空间，接上 MCP"
echo "  brain service install   # 装后台常驻（开机自启）"
echo "  brain status            # 看状态"
