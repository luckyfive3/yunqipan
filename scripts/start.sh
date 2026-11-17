#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
#  云栖盘 · 一键启动脚本（macOS / Linux）
#  用法:
#    ./scripts/start.sh               完整启动（Docker 依赖 + 服务端 + 客户端[macOS]）
#    ./scripts/start.sh --server-only 只启动 Docker 依赖 + 服务端
#    ./scripts/start.sh --client-only 只启动客户端
#    ./scripts/start.sh --skip-deps   跳过 Docker 依赖（自行准备 PG/Redis/MinIO）
#    ./scripts/start.sh --no-docker   不使用 Docker（依赖自行准备，服务端需本机 Go）
#    ./scripts/start.sh --skip-install 跳过 go mod tidy / npm install
#    ./scripts/start.sh --use-mirror  使用国内镜像（goproxy.cn / npmmirror）
#    ./scripts/start.sh --stop        停止全部
#    ./scripts/start.sh --status      查看状态
#    ./scripts/start.sh --check       只做环境体检
# ═══════════════════════════════════════════════════════════════════
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_DIR="$ROOT/server"
CLIENT_DIR="$ROOT/client"
COMPOSE="$SERVER_DIR/docker-compose.dev.yml"
PROJECT="wangpan"
PORT="${PORT:-0}"     # 0 = 自动探测（8080 起）
HEALTH="http://127.0.0.1:8080/healthz"
CONTAINER="wangpan-server"

SERVER_ONLY=false; CLIENT_ONLY=false; SKIP_DEPS=false; NO_DOCKER=false
SKIP_INSTALL=false; USE_MIRROR=false; WIPE=false
STOP=false; STATUS=false; CHECK=false
SERVER_PID=0

for a in "$@"; do
  case "$a" in
    --server-only)   SERVER_ONLY=true ;;
    --client-only)   CLIENT_ONLY=true ;;
    --skip-deps)     SKIP_DEPS=true ;;
    --no-docker)     NO_DOCKER=true; SKIP_DEPS=true ;;
    --skip-install)  SKIP_INSTALL=true ;;
    --use-mirror)    USE_MIRROR=true ;;
    --wipe)          WIPE=true ;;
    --stop)          STOP=true ;;
    --status)        STATUS=true ;;
    --check)         CHECK=true ;;
    -h|--help)       grep '^#' "$0" | head -20; exit 0 ;;
    *) echo "未知参数: $a"; exit 2 ;;
  esac
done

say()  { printf '\n\033[36m[云栖盘]\033[0m %s\n' "$*"; }
ok()   { printf '   \033[32mOK\033[0m  %s\n' "$*"; }
warn() { printf '   \033[33mWARN\033[0m %s\n' "$*"; }
err()  { printf '   \033[31mERR\033[0m %s\n' "$*"; }

have() { command -v "$1" >/dev/null 2>&1; }
docker_up() { have docker && docker info >/dev/null 2>&1; }

wait_http() {
  local url="$1" secs="${2:-300}"
  local i
  for i in $(seq 1 $((secs / 2))); do
    if curl -fs -o /dev/null --max-time 3 "$url" 2>/dev/null; then return 0; fi
    sleep 2
  done
  return 1
}

check_env() {
  say "环境体检"
  if have node;  then ok "Node.js $(node --version)";  else err "未找到 node（客户端必需）"; fi
  if have npm;   then ok "npm $(npm --version)";       else err "未找到 npm"; fi
  if have go;    then ok "Go $(go version)";           else warn "未找到 Go（可用 Docker 容器方式跑服务端）"; fi
  if have docker && docker_up; then ok "Docker 守护进程已就绪"
  elif have docker;            then warn "Docker 已安装但守护进程未运行（请先启动 Docker Desktop）"
  else                              warn "未安装 Docker（可 --skip-deps 自建依赖）"; fi
  if have aria2c; then ok "aria2c（可选加速内核）"; else warn "未安装 aria2c（可选）"; fi
}

start_deps() {
  say "启动依赖容器（PostgreSQL + Redis + S3 对象存储）"
  if ! docker_up; then err "Docker 不可用。请启动 Docker Desktop，或 --skip-deps 自备依赖。"; exit 1; fi
  docker compose -p "$PROJECT" -f "$COMPOSE" up -d
  local -a bad
  local i st
  for i in $(seq 1 60); do
    bad=()
    for pair in "postgres wangpan-postgres" "redis wangpan-redis" "s3mock wangpan-s3mock"; do
      set -- $pair
      st="$(docker inspect --format '{{.State.Health.Status}}' "$2" 2>/dev/null || true)"
      [ "$st" = "healthy" ] || bad+=("$1")
    done
    if [ ${#bad[@]} -eq 0 ]; then ok "三个依赖容器全部健康"; return 0; fi
    warn "等待依赖容器健康: ${bad[*]} ..."
    sleep 5
  done
  warn "容器健康检查超时，继续尝试启动服务端"
}

start_server() {
  say "启动 Go 服务端"
  if have go && [ "$NO_DOCKER" != "true" -o ! docker_up ]; then
    if [ "$SKIP_INSTALL" != "true" ]; then
      printf '   ·   go mod tidy（首次拉取依赖）...\n'
      (cd "$SERVER_DIR" && ${USE_MIRROR:+GOPROXY=https://goproxy.cn,direct} go mod tidy)
    fi
    (cd "$SERVER_DIR" && SERVER_ADDR="127.0.0.1:$PORT" exec go run ./cmd/server) &
    SERVER_PID=$!
    if wait_http "$HEALTH" 300; then
      ok "服务端已就绪: http://127.0.0.1:$PORT（本机 Go，PID $SERVER_PID）"
    else
      err "服务端未就绪，请检查上方日志"; kill "$SERVER_PID" 2>/dev/null || true; exit 1
    fi
  elif docker_up; then
    warn "本机没有 Go，使用 Docker 容器运行服务端（首次需拉取镜像与依赖，可能较慢）"
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    docker run -d --name "$CONTAINER" --network "${PROJECT}_default" -p "$PORT:8080" --restart unless-stopped \
      -v wangpan-gocache:/go -v "$SERVER_DIR:/app" -w /app \
      -e SERVER_ADDR=:8080 \
      -e DATABASE_URL='postgres://wangpan:wangpan@postgres:5432/wangpan?sslmode=disable' \
      -e MINIO_ENDPOINT='s3mock:9090' -e MINIO_ACCESS_KEY='minioadmin' -e MINIO_SECRET_KEY='minioadmin' \
      -e MINIO_BUCKET='wangpan' -e MINIO_USE_SSL='false' -e REDIS_URL='redis://redis:6379/0' \
      -e JWT_SECRET='dev-jwt-change-me' -e PREVIEW_TOKEN_SECRET='dev-preview-change-me' -e DEFAULT_QUOTA_GB=10 \
      ${USE_MIRROR:+-e GOPROXY=https://goproxy.cn,direct} \
      golang:1.22-alpine sh -c 'go mod download && go build -o /tmp/wp-server ./cmd/server && /tmp/wp-server'
    if wait_http "$HEALTH" 600; then
      ok "服务端已就绪（容器方式，docker logs -f $CONTAINER 查看日志）"
    else
      err "服务端未就绪：docker logs -f $CONTAINER"; exit 1
    fi
  else
    err "本机既无 Go 也无 Docker，无法启动服务端。"; exit 1
  fi
}

start_client() {
  say "启动 Electron 客户端"
  if ! have node; then err "未找到 Node.js，无法启动客户端。"; exit 1; fi
  local electron=""
  [ -f "$CLIENT_DIR/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" ] && \
    electron="$CLIENT_DIR/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
  [ -f "$CLIENT_DIR/node_modules/electron/dist/electron" ] && \
    electron="$CLIENT_DIR/node_modules/electron/dist/electron"
  if [ -z "$electron" ]; then
    [ "$SKIP_INSTALL" = "true" ] && { err "electron 未安装且指定了 --skip-install"; exit 1; }
    printf '   ·   首次运行：npm install 安装 electron（约 100MB）...\n'
    (cd "$CLIENT_DIR" && ${USE_MIRROR:+ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/} npm install --no-audit --no-fund)
    [ -f "$CLIENT_DIR/node_modules/electron/dist/electron" ] && electron="$CLIENT_DIR/node_modules/electron/dist/electron"
    [ -z "$electron" ] && [ -f "$CLIENT_DIR/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" ] && \
      electron="$CLIENT_DIR/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
  fi
  [ -z "$electron" ] && { err "electron 安装未完成"; exit 1; }
  ok "客户端启动中..."
  (cd "$CLIENT_DIR" && "$electron" "$CLIENT_DIR" >/dev/null 2>&1 &)
}

stop_all() {
  say "停止云栖盘"
  if docker_up; then
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    if [ "$WIPE" = "true" ]; then docker compose -p "$PROJECT" -f "$COMPOSE" down -v
    else docker compose -p "$PROJECT" -f "$COMPOSE" down; fi
    ok "依赖容器已停止（数据卷保留；--wipe 删除数据卷）"
  fi
  pkill -f "$SERVER_DIR" >/dev/null 2>&1 || true
  if [ "$(uname)" = "Darwin" ]; then pkill -f "$CLIENT_DIR" >/dev/null 2>&1 || true; fi
  ok "服务端/客户端进程已停止"
}

show_status() {
  say "运行状态"
  if curl -fs -o /dev/null --max-time 3 "$HEALTH" 2>/dev/null; then ok "服务端运行中: $HEALTH"; else err "服务端未响应: $HEALTH"; fi
  if docker_up; then docker compose -p "$PROJECT" -f "$COMPOSE" ps; fi
}

# ── 主流程 ──
if [ "$PORT" = "0" ]; then
  PORT=8080
  port_busy() {
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 ||
    ss -ltn 2>/dev/null | grep -q ":$PORT "
  }
  while port_busy; do PORT=$((PORT+1)); done
fi
HEALTH="http://127.0.0.1:$PORT/healthz"

check_env
[ "$CHECK"  = "true" ] && exit 0
[ "$STOP"   = "true" ] && { stop_all; exit 0; }
[ "$STATUS" = "true" ] && { show_status; exit 0; }

trap 'if [ "$SERVER_PID" != "0" ]; then kill $SERVER_PID 2>/dev/null || true; fi' EXIT

if [ "$CLIENT_ONLY" != "true" ]; then
  [ "$SKIP_DEPS" = "true" ] || start_deps
  start_server
fi
[ "$SERVER_ONLY" = "true" ] || start_client

say "启动完成"
printf '   ·   服务端 API : http://127.0.0.1:%s（客户端免登录自动连接，打开即用）\n' "$PORT"
printf '   ·   对象存储 S3 : http://127.0.0.1:19000（开发用 s3mock，生产可接 MinIO 企业版等 S3 存储）\n'
printf '   ·   健康检查   : %s\n' "$HEALTH"
printf '   ·   提示：可选安装 aria2c 并在客户端「设置」中启用加速内核。\n'
