# 云栖盘（YunXi Drive）· Go 服务端

私有云盘后端。唯一接口契约见 [`docs/02-api-spec.md`](../docs/02-api-spec.md)，
本实现逐条按该契约实现（认证 / 文件 / 分块上传 / 下载 / 预览 / 分享 / 浏览器分享页 / 健康检查）。

## 技术栈

- Go 1.22+，标准库 `net/http`（1.22 ServeMux 路径参数），无 web 框架
- PostgreSQL 16（pgx/v5 连接池）、MinIO（aws-sdk-go-v2 S3 API，Path-Style）、Redis 7（可选，go-redis/v9）
- JWT HS256（golang-jwt/jwt/v5）、bcrypt、HMAC-SHA256 preview-token

## 快速启动

```bash
# 1. 启动开发依赖（PostgreSQL + Redis + MinIO）
cd server
docker compose -f docker-compose.dev.yml up -d

# 2. 拉取依赖并生成 go.sum（首次需要网络）
go mod tidy

# 3. 启动服务端（默认配置已对齐 compose，可零配置启动）
go run ./cmd/server
```

- 服务端启动时自动建表（幂等迁移）并自动创建 MinIO bucket `wangpan`（无需 mc 初始化）。
- 验证：`curl http://127.0.0.1:8080/healthz` → `{"ok":true,"version":"1.0.0","time":"..."}`
- MinIO 控制台：<http://127.0.0.1:9001>（minioadmin / minioadmin）。

## 环境变量

见 [`.env.example`](./.env.example)，全部带开发默认值。关键项：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `SERVER_ADDR` | `:8080` | HTTP 监听地址 |
| `DATABASE_URL` | `postgres://wangpan:wangpan@localhost:5432/wangpan?sslmode=disable` | PostgreSQL |
| `REDIS_URL` | 空 | 留空则限流/缓存降级为 no-op |
| `MINIO_ENDPOINT` | `127.0.0.1:9000` | MinIO S3 端点（可带 scheme） |
| `MINIO_BUCKET` | `wangpan` | 自动创建 |
| `JWT_SECRET` / `PREVIEW_TOKEN_SECRET` | dev 默认值 | **生产必须改为强随机值** |
| `DEFAULT_QUOTA_GB` | `10` | 新用户默认配额，0 = 不限 |

## 目录结构

```
cmd/server/main.go          启动装配：配置→连库→迁移→路由→优雅退出
internal/config             环境变量配置（全默认值）
internal/store              pgx 连接池 + users/files/shares 数据访问 + 事务
internal/object             MinIO S3 封装（Multipart 五方法 / Range GetObject / 批量删除）
internal/cache              Redis 可选缓存（no-op 降级 + 登录限流）
internal/token              JWT + preview-token（HMAC-SHA256）
internal/api                路由与全部 handler（认证/文件/上传/下载/预览/分享/分享页/健康检查）
migrations/001_init.sql     幂等建表（go:embed 内嵌，启动时执行）
```

## 关键实现说明

- **同层重名校验**：PostgreSQL 唯一约束对 NULL `parent_id` 不生效，因此应用层在事务内
  显式 `SELECT` 查重（`parent_id IS NOT DISTINCT FROM $n`），唯一约束仅作并发兜底。
- **分块上传**：会话元数据存 Redis（`upload:{upload_id}`，TTL 24h）；`received` 一律来自
  S3 `ListParts`（可靠真相源）；`complete` 时 ListParts → CompleteMultipartUpload →
  校验合并后大小 → 事务（查重 + INSERT + 配额终检）。
- **配额**：`init` 预检（413 QUOTA_EXCEEDED）；`complete` 事务内带守卫的
  `UPDATE ... WHERE quota_total = 0 OR quota_used + size <= quota_total` 终检，杜绝并发超卖。
- **下载**：流式 `io.Copy` 转发 S3 GetObject（无全量缓冲）；解析单段 `Range`/`If-Range`；
  `Accept-Ranges`/`ETag`（优先 sha256）/`Content-Disposition`（RFC5987 `filename*`）；
  206 的 `Content-Length`/`Content-Range` 按 S3 响应透传。
- **删除**：递归 CTE 收集子孙 → 事务删行 + 扣配额 → `DeleteObjects` 批量删对象。
- **分享**：8 位 base62 token（crypto/rand）；提取码只存 bcrypt(cost 10)；resolve 逐级校验；
  目录分享 `WITH RECURSIVE` 返回整棵子树；下载计数 `UPDATE ... WHERE downloads < max_downloads`
  按影响行数判断，Range 续传（start>0）不重复计数。
- **预览**：白名单 mime（image/video/audio/*、text/plain、text/markdown、text/csv、
  application/pdf、application/json、application/xml）；加密文件一律 415；
  preview-token 只能用于 preview 接口。
- **中间件**：请求 ID → slog JSON 访问日志 → CORS → panic recover → JWT 认证。

## 已知取舍（与实现要点一致）

- 上传会话元数据只存 Redis：Redis 不可用（或数据丢失）时，分块上传无法恢复现场，
  `GET /files/upload/{upload_id}` 返回 `404 UPLOAD_NOT_FOUND`，客户端需重新 init。
  这是任务约定的简化策略（未采用 MinIO metadata 退化路径）。
- 仅支持契约要求的单段 Range；多段 Range 返回 400。

## 自检

```bash
make fmt    # gofmt -w ./cmd ./internal ./migrations
make build  # go build -o bin/server ./cmd/server
make test   # go test ./...
```
