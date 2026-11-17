#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
#  云栖盘 · 端到端冒烟测试（Linux / CI）
#  覆盖：健康检查 → 注册登录 → 建目录 → 分块上传(断点状态) → 列表 →
#        全量下载(sha256) → Range 下载(206) → 预览签名/白名单 →
#        重命名/移动 → 分享(提取码/次数限制/续传不计数) → 浏览器分享页 → 删除
#  依赖：curl / jq / sha256sum / dd（GitHub Actions ubuntu-latest 自带）
#  用法：SERVER_URL=http://127.0.0.1:8080 ./scripts/smoke.sh
# ═══════════════════════════════════════════════════════════════════
set -euo pipefail

BASE="${SERVER_URL:-http://127.0.0.1:8080}/api/v1"
HEALTH="${SERVER_URL:-http://127.0.0.1:8080}/healthz"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PASS=0
FAIL=0

ok()   { printf '  \033[32m✔\033[0m %s\n' "$*"; PASS=$((PASS+1)); }
fail() { printf '  \033[31m✘\033[0m %s\n' "$*"; FAIL=$((FAIL+1)); }
assert() { # assert <描述> <命令...>
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then ok "$desc"; else fail "$desc"; fi
}
assert_eq() { # assert_eq <描述> <期望> <实际>
  if [ "$2" = "$3" ]; then ok "$1"; else fail "$1（期望 $2，实际 $3）"; fi
}

echo "== 0. 等待服务端就绪 =="
for i in $(seq 1 60); do
  if curl -fs -o /dev/null --max-time 3 "$HEALTH" 2>/dev/null; then break; fi
  [ "$i" = "60" ] && { echo "服务端未就绪"; exit 1; }
  sleep 2
done
ok "healthz 通过"

echo "== 1. 注册 / 登录 =="
USER="smoke_$(date +%s)"
REG=$(curl -sf -X POST "$BASE/auth/register" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$USER\",\"password\":\"password123\"}")
TOKEN=$(echo "$REG" | jq -r .token)
assert "注册返回 JWT" test -n "$TOKEN"
AUTH="Authorization: Bearer $TOKEN"
LOGIN=$(curl -sf -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$USER\",\"password\":\"password123\"}")
assert_eq "登录成功" "$(echo "$LOGIN" | jq -r .user.username)" "$USER"
# 错误密码应 401
C401=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$USER\",\"password\":\"wrong-pass\"}")
assert_eq "错误密码 401" "$C401" "401"

echo "== 2. 目录与分块上传（10MiB / 两块 8MiB+2MiB）=="
DIR=$(curl -sf -X POST "$BASE/files/mkdir" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"parent_id":null,"name":"smoke-dir"}')
DIRID=$(echo "$DIR" | jq -r .file.id)
assert "创建目录" test -n "$DIRID"

dd if=/dev/urandom of="$TMP/f.bin" bs=1M count=10 2>/dev/null
SHA=$(sha256sum "$TMP/f.bin" | cut -d' ' -f1)
INIT=$(curl -sf -X POST "$BASE/files/upload/init" -H "$AUTH" -H 'Content-Type: application/json' \
  -d "{\"parent_id\":\"$DIRID\",\"name\":\"f.bin\",\"size\":10485760,\"mime\":\"application/octet-stream\",\"chunk_size\":8388608}")
UPID=$(echo "$INIT" | jq -r .upload_id)
assert "上传 init（默认 8MiB 分块）" test -n "$UPID"

head -c 8388608 "$TMP/f.bin" > "$TMP/c0.bin"
tail -c +8388609 "$TMP/f.bin" > "$TMP/c1.bin"
curl -sf -X PUT "$BASE/files/upload/$UPID/chunk/0" -H "$AUTH" --data-binary @"$TMP/c0.bin" >/dev/null
curl -sf -X PUT "$BASE/files/upload/$UPID/chunk/1" -H "$AUTH" --data-binary @"$TMP/c1.bin" >/dev/null
# 幂等重传块 0（断点续传核心：已传块可重复 PUT）
curl -sf -X PUT "$BASE/files/upload/$UPID/chunk/0" -H "$AUTH" --data-binary @"$TMP/c0.bin" >/dev/null
ST=$(curl -sf -X GET "$BASE/uploads/$UPID" -H "$AUTH")
assert_eq "断点状态 received=[0,1]" "$(echo "$ST" | jq -c '.received')" "[0,1]"

COMP=$(curl -sf -X POST "$BASE/files/upload/$UPID/complete" -H "$AUTH" -H 'Content-Type: application/json' \
  -d "{\"sha256\":\"$SHA\"}")
FID=$(echo "$COMP" | jq -r .file.id)
assert "complete 合并入库" test -n "$FID"

echo "== 3. 列表 / 下载 / Range =="
LS=$(curl -sf -X GET "$BASE/files?parent_id=$DIRID" -H "$AUTH")
assert_eq "目录列表含 10MiB 文件" "$(echo "$LS" | jq -r '.items[0].size')" "10485760"

curl -sf -X GET "$BASE/files/$FID/download?download=1" -H "$AUTH" -o "$TMP/d.bin"
echo "$SHA  $TMP/d.bin" | sha256sum -c --quiet 2>/dev/null
ok "全量下载 sha256 校验通过"

RCODE=$(curl -s -o "$TMP/r.bin" -w '%{http_code}' -X GET "$BASE/files/$FID/download" -H "$AUTH" -H 'Range: bytes=100-199')
assert_eq "Range 下载返回 206" "$RCODE" "206"
assert_eq "Range 分段长度 100" "$(stat -c%s "$TMP/r.bin")" "100"

echo "== 4. 预览：签名免 Bearer + 白名单 =="
# 上传一个文本文件（单分块）
printf '云栖盘预览冒烟内容\nsecond line\n' > "$TMP/t.txt"
TSIZE=$(stat -c%s "$TMP/t.txt")
TSHA=$(sha256sum "$TMP/t.txt" | cut -d' ' -f1)
INIT2=$(curl -sf -X POST "$BASE/files/upload/init" -H "$AUTH" -H 'Content-Type: application/json' \
  -d "{\"parent_id\":\"$DIRID\",\"name\":\"t.txt\",\"size\":$TSIZE,\"mime\":\"text/plain\",\"chunk_size\":8388608}")
UPID2=$(echo "$INIT2" | jq -r .upload_id)
curl -sf -X PUT "$BASE/files/upload/$UPID2/chunk/0" -H "$AUTH" --data-binary @"$TMP/t.txt" >/dev/null
TID=$(curl -sf -X POST "$BASE/files/upload/$UPID2/complete" -H "$AUTH" -H 'Content-Type: application/json' \
  -d "{\"sha256\":\"$TSHA\"}" | jq -r .file.id)

PT=$(curl -sf -X POST "$BASE/files/$TID/preview-token" -H "$AUTH" -H 'Content-Type: application/json' -d '{"ttl_seconds":300}')
PURL=$(echo "$PT" | jq -r .url)
PCODE=$(curl -s -o "$TMP/p.txt" -w '%{http_code}' "${SERVER_URL:-http://127.0.0.1:8080}${PURL}")
assert_eq "preview-token 免 Bearer 预览 200" "$PCODE" "200"
assert "预览内容与原文一致" cmp -s "$TMP/t.txt" "$TMP/p.txt"
BCODE=$(curl -s -o /dev/null -w '%{http_code}' -X GET "$BASE/files/$FID/preview" -H "$AUTH")
assert_eq "非白名单 mime 预览 415" "$BCODE" "415"

echo "== 5. 重命名 / 移动 =="
RN=$(curl -sf -X POST "$BASE/files/rename" -H "$AUTH" -H 'Content-Type: application/json' \
  -d "{\"id\":\"$FID\",\"name\":\"f2.bin\"}")
assert_eq "重命名 f.bin → f2.bin" "$(echo "$RN" | jq -r .file.name)" "f2.bin"
MV=$(curl -sf -X POST "$BASE/files/move" -H "$AUTH" -H 'Content-Type: application/json' \
  -d "{\"id\":\"$FID\",\"parent_id\":null}")
assert_eq "移动到根目录" "$(echo "$MV" | jq -r '.file.parent_id')" "null"

echo "== 6. 分享（提取码 / 有效期 / 次数限制 / 续传不计数）=="
SH=$(curl -sf -X POST "$BASE/shares" -H "$AUTH" -H 'Content-Type: application/json' \
  -d "{\"file_id\":\"$FID\",\"require_code\":true,\"extract_code\":\"abc123\",\"expires_hours\":1,\"max_downloads\":2}")
SHID=$(echo "$SH" | jq -r .share.id)
TOK=$(echo "$SH" | jq -r .share.token)
assert_eq "创建分享返回 /s/{token}" "$(echo "$SH" | jq -r .url)" "/s/$TOK"

C403=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/shares/resolve" -H 'Content-Type: application/json' -d "{\"token\":\"$TOK\"}")
assert_eq "缺提取码 resolve 403" "$C403" "403"
C403B=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/shares/resolve" -H 'Content-Type: application/json' -d "{\"token\":\"$TOK\",\"extract_code\":\"wrong1\"}")
assert_eq "错误提取码 403" "$C403B" "403"
RV=$(curl -sf -X POST "$BASE/shares/resolve" -H 'Content-Type: application/json' -d "{\"token\":\"$TOK\",\"extract_code\":\"abc123\"}")
assert_eq "resolve 单节点树" "$(echo "$RV" | jq -r '.tree | length')" "1"
NODE=$(echo "$RV" | jq -r '.tree[0].id')

curl -sf -X GET "$BASE/shares/$TOK/download?node=$NODE&download=1" -o "$TMP/s.bin"
echo "$SHA  $TMP/s.bin" | sha256sum -c --quiet 2>/dev/null
ok "分享下载内容正确（计数 1）"
# Range 起点 >0 的续传请求不重复计数
curl -sf -X GET "$BASE/shares/$TOK/download?node=$NODE" -H 'Range: bytes=1000-1999' -o /dev/null
RV2=$(curl -sf -X POST "$BASE/shares/resolve" -H 'Content-Type: application/json' -d "{\"token\":\"$TOK\",\"extract_code\":\"abc123\"}")
assert_eq "Range 续传不重复计数（剩 1 次）" "$(echo "$RV2" | jq -r '.share.remaining_downloads')" "1"
# 第 2 次完整下载耗尽次数，第 3 次 403
curl -sf -X GET "$BASE/shares/$TOK/download?node=$NODE" -o /dev/null
C403C=$(curl -s -o /dev/null -w '%{http_code}' -X GET "$BASE/shares/$TOK/download?node=$NODE")
assert_eq "超过下载次数上限 403" "$C403C" "403"

PAGE=$(curl -sf "${SERVER_URL:-http://127.0.0.1:8080}/s/$TOK")
if echo "$PAGE" | grep -q '云栖盘'; then ok "浏览器分享页渲染"; else fail "浏览器分享页渲染"; fi

echo "== 7. 删除与清理 =="
curl -sf -X DELETE "$BASE/shares/$SHID" -H "$AUTH" >/dev/null
C404=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/shares/resolve" -H 'Content-Type: application/json' -d "{\"token\":\"$TOK\",\"extract_code\":\"abc123\"}")
assert_eq "删除分享后 resolve 404" "$C404" "404"
curl -sf -X DELETE "$BASE/files/$FID" -H "$AUTH" >/dev/null
curl -sf -X DELETE "$BASE/files/$DIRID?recursive=true" -H "$AUTH" >/dev/null
LS2=$(curl -sf -X GET "$BASE/files" -H "$AUTH")
assert_eq "删除后根目录为空" "$(echo "$LS2" | jq -r '.items | length')" "0"

echo ""
echo "════════════════════════════════════"
echo " 冒烟结果：通过 $PASS 项，失败 $FAIL 项"
echo "════════════════════════════════════"
[ "$FAIL" = "0" ]
