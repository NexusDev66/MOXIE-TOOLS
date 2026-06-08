#!/bin/sh
# MOXIE CLI 安装脚本
#
# 用法:
#   curl -fsSL https://latemai.com/install.sh | sh
#
# 这个脚本会:
#   1. 检查 node >= 18
#   2. 从 latemai.com 下载 cli/index.js (托管在 Vercel)
#   3. 装到 /usr/local/bin/moxie (mac/linux) 或 ~/bin/moxie (无权限时)

set -e

CLI_URL="https://latemai.com/cli/index.js"
INSTALL_DIR="/usr/local/bin"
BIN_NAME="moxie"

echo ""
echo "  📦 MOXIE CLI 安装"
echo ""

# 1. 检查 node
if ! command -v node >/dev/null 2>&1; then
  echo "  ❌ 未找到 node。先装 Node.js 18+:  https://nodejs.org"
  exit 1
fi
NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 18 ]; then
  echo "  ❌ Node.js 版本太低 (v$NODE_VER)，需要 v18+"
  exit 1
fi
echo "  ✓ Node.js $(node -v)"

# 2. 选安装路径（优先 /usr/local/bin，不行就 ~/bin）
if [ -w "$INSTALL_DIR" ]; then
  TARGET="$INSTALL_DIR/$BIN_NAME"
elif sudo -n true 2>/dev/null; then
  SUDO="sudo"
  TARGET="$INSTALL_DIR/$BIN_NAME"
else
  mkdir -p "$HOME/bin"
  TARGET="$HOME/bin/$BIN_NAME"
  case ":$PATH:" in
    *":$HOME/bin:"*) ;;
    *) echo "  ⚠ 把 \$HOME/bin 加到 PATH:  echo 'export PATH=\"\$HOME/bin:\$PATH\"' >> ~/.zshrc" ;;
  esac
fi

# 3. 下载 + chmod
echo "  ⬇  下载 CLI..."
TMP=$(mktemp)
if ! curl -fsSL "$CLI_URL" -o "$TMP"; then
  echo "  ❌ 下载失败 - 网络问题或仓库不可访问"
  rm -f "$TMP"
  exit 1
fi
${SUDO:-} mv "$TMP" "$TARGET"
${SUDO:-} chmod +x "$TARGET"

echo "  ✓ 安装到 $TARGET"
echo ""
echo "  开始使用:"
echo "    moxie list                # 本周编辑精选"
echo "    moxie search rag          # 搜 RAG 工具"
echo "    moxie get deepseek-v3     # 看单个产品"
echo "    moxie init                # 给 AI Agent 接入"
echo ""
echo "  Web: https://latemai.com"
echo "  Agent 接入指南: https://latemai.com/install/agent.md"
echo ""
