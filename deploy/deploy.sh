#!/usr/bin/env bash
# 在本机执行：把源码同步到服务器并重新构建启动。
#   ./deploy/deploy.sh root@101.201.125.231
set -euo pipefail

TARGET="${1:-${DEPLOY_TARGET:-}}"
REMOTE_DIR="${REMOTE_DIR:-/opt/kanzheban}"
[ -n "$TARGET" ] || { echo "用法：$0 user@host" >&2; exit 1; }

# 指定部署专用私钥：SSH_KEY=~/.ssh/kanzheban_deploy ./deploy/deploy.sh root@主机
SSH_KEY="${SSH_KEY:-}"
SSH_OPTS=()
[ -n "$SSH_KEY" ] && SSH_OPTS=(-i "$SSH_KEY")

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
[ -f .env.deploy ] || { echo "缺少 .env.deploy，请先 cp .env.deploy.example .env.deploy 并填写" >&2; exit 1; }

echo "== 同步源码到 ${TARGET}:${REMOTE_DIR} =="
ssh "${SSH_OPTS[@]}" "$TARGET" "mkdir -p '$REMOTE_DIR'"
rsync -az --delete -e "ssh ${SSH_KEY:+-i $SSH_KEY}" \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude '.data' \
  --exclude '.pnpm-store' \
  --exclude '.artifacts' \
  --exclude 'release' \
  --exclude 'downloads' \
  --exclude 'promo' \
  --exclude 'node_modules/' \
  ./ "$TARGET:$REMOTE_DIR/"

echo "== 远端构建并启动 =="
# compose 读同目录的 .env，这里把部署配置对过去。
ssh "${SSH_OPTS[@]}" "$TARGET" "cd '$REMOTE_DIR' && cp .env.deploy .env && docker compose up -d --build && docker compose ps"

PUBLIC_HOST="$(grep -E '^PUBLIC_HOST=' .env.deploy | cut -d= -f2-)"
echo
echo "部署完成：http://${PUBLIC_HOST}"
echo "查看日志：ssh ${SSH_KEY:+-i $SSH_KEY} $TARGET 'cd $REMOTE_DIR && docker compose logs -f --tail=100'"
