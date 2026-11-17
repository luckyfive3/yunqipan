# 云栖盘 · 部署流程、环境配置与服务器带宽选型

## 1. 总览

| 组件 | 角色 | 最低配置 | 生产建议 |
|---|---|---|---|
| PostgreSQL 16 | 元数据 | 1C/1G | 2C/4G + SSD，每日 pg_dump |
| Redis 7 | 限流/缓存（可选） | 128M | 开启 AOF，主从 |
| S3 对象存储 | 开发 s3mock / 生产 MinIO 企业版·AWS S3·OSS | 1C/512M | 4 节点纠删码(EC:4) 或云对象存储 |
| Go 服务端 | API 网关 | 1C/512M | 2C/2G ×2 + 负载均衡（或单机加大带宽） |
| 客户端 | Electron | Win10+/macOS 12+ | 4C/8G 桌面即可 |

> Go 服务端单实例即可跑满千兆出口（下载是 io.Copy 流式转发，瓶颈在带宽与内核网络栈，不在 CPU）。多实例横向扩展时需注意：上传会话元数据在 Redis（共享即可），分块状态在对象存储（天然共享）。
>
> 说明：MinIO 社区版镜像与二进制自 2025 年起停止公开分发（dl.min.io 410、Docker Hub 匿名拉取被拒），
> 开发环境改用标准 S3 API 的 adobe/s3mock:3.11.0（见 docker-compose.dev.yml 顶部注释）；
> 生产可无缝切换 MinIO 企业版 / AWS S3 / 阿里云 OSS 等任意 S3 兼容存储（仅改 MINIO_* 环境变量）。

---

## 2. 服务端部署

### 2.1 方式 A：Docker Compose（推荐，依赖一键起）

```bash
cd server
cp .env.example .env          # 修改 JWT_SECRET / PREVIEW_TOKEN_SECRET / MINIO 密钥
docker compose -f docker-compose.dev.yml up -d   # 拉起 PG + Redis + s3mock（含健康检查）
docker compose -f docker-compose.dev.yml logs -f
go mod tidy && go run ./cmd/server               # 服务端本体在宿主机运行（启动时自动建表+建 bucket）
```

`.env` 关键项：

```ini
SERVER_ADDR=:8080
DATABASE_URL=postgres://wangpan:wangpan@localhost:5432/wangpan?sslmode=disable
MINIO_ENDPOINT=127.0.0.1:19000
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=<改成强随机>
MINIO_BUCKET=wangpan
MINIO_USE_SSL=false
REDIS_URL=redis://redis:6379/0        # 可留空 → 限流/缓存自动降级
JWT_SECRET=<openssl rand -hex 32>
PREVIEW_TOKEN_SECRET=<openssl rand -hex 32>
SHARE_BASE_URL=https://pan.example.com
DEFAULT_QUOTA_GB=10
```

### 2.2 方式 B：裸机二进制

```bash
cd server
go mod tidy && go build -o wangpan-server ./cmd/server
export $(cat .env | xargs)      # 或在 systemd 中 EnvironmentFile
./wangpan-server                 # 启动时自动建表、自动建对象存储 bucket
```

systemd 示例（`/etc/systemd/system/wangpan.service`）：

```ini
[Unit]
Description=YunXi Drive API
After=network.target

[Service]
EnvironmentFile=/opt/wangpan/.env
ExecStart=/opt/wangpan/wangpan-server
Restart=always
RestartSec=3
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```

### 2.3 TLS 与域名（生产必做）

用 Caddy 一行搞定（自动 HTTPS）：

```
pan.example.com {
    reverse_proxy 127.0.0.1:8080
    encode gzip
    request_body { max_size 1GB }
}
```

或 Nginx：

```nginx
server {
    listen 443 ssl http2;
    server_name pan.example.com;
    ssl_certificate     /etc/ssl/pan.pem;
    ssl_certificate_key /etc/ssl/pan.key;
    client_max_body_size 1g;          # 分块上传单块最大 64MiB，1g 足够
    location / { proxy_pass http://127.0.0.1:8080;
                 proxy_buffering off;           # 下载流式转发，禁止缓冲
                 proxy_request_buffering off;
                 proxy_http_version 1.1;
                 proxy_set_header Host $host;
                 proxy_set_header X-Real-IP $remote_addr; }
}
```

> `proxy_buffering off` 很重要：否则 Nginx 会先把整个文件缓冲到磁盘再回源，大文件下载体验全毁。

### 2.4 数据备份

- **PostgreSQL**：`pg_dump -Fc` 每日 + WAL 归档（元数据是命根子，文件本体可再生）。
- **对象存储**：生产 MinIO 用 `mc mirror` 异地/异桶复制并开启版本控制；云对象存储开生命周期与版本控制做误删兜底。
- **Redis**：开启 AOF；仅存限流与缓存，可整库丢弃重建。

---

## 3. 客户端部署

```bash
cd client
npm install                     # 仅依赖 electron
# 国内镜像加速：
#   set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
#   npm config set registry https://registry.npmmirror.com
npm start                       # 开发/直接运行
```

- **可选加速内核 aria2**：Windows `choco install aria2` 或官网解压后把 `aria2c.exe` 路径填入「设置 → aria2 路径」；macOS `brew install aria2`。不安装也完全可用（自动回退自研内核）。
- **打包分发**（可选，二选一）：
  - `npx electron-builder --win --mac`（在 settings 外接 electron-builder 配置即可，双平台产物）；
  - 或保持 `npm start` + 绿色目录分发（团队内部够用）。
- **升级路线**：设置里写入服务端地址（默认 `http://127.0.0.1:8080`），生产填写 `https://pan.example.com`。

---

## 4. 服务器带宽选型建议

### 4.1 核心公式

```
需要的出口带宽 ≈ 同时在线活跃下载用户数 × 单用户期望体验速度 × 冗余系数(1.2~1.5)
```

单文件多线程下载可以吃满单用户带宽，所以**服务端出口是唯一硬瓶颈**，按“体验目标”倒推：

| 场景 | 活跃下载用户 | 期望速度/用户 | 所需出口 | 建议套餐 |
|---|---|---|---|---|
| 个人/家庭自用 | 1~3 | 10 MB/s | 30~50 Mbps | 100 Mbps 家宽/轻量云即可 |
| 小团队(≤20人) | 3~8 | 5 MB/s | 120~320 Mbps | 300~500 Mbps 固定带宽 |
| 中小企业(≤100人) | 10~30 | 5 MB/s | 400 Mbps~1.2 Gbps | 1 Gbps 独享 + 可加 CDN |
| 大流量分发 | 50+ | 3 MB/s | 1.2 Gbps+ | ≥2 Gbps 或多出口聚合 + CDN |

> 注意区分：云厂商「带宽」按 Mbps 计、客户端速度按 MB/s 显示（1 MB/s ≈ 8 Mbps）。
> 1 Gbps 出口 ≈ 理论 125 MB/s，单用户 32 线程大文件下载在晚高峰能压出 30~80 MB/s 属正常。

### 4.2 上行与自建注意

- **上传方向**：用户向私有云传文件消耗的是**服务器入方向**带宽（家用宽带上行才是用户瓶颈）。对称带宽（如企业专线）体验最好；家宽自建建议至少 30 Mbps 上行。
- **家庭自建（NAS/迷你主机）**：需要公网 IP 或内网穿透（frp/ZeroTier/Tailscale），穿透层会引入额外延迟，多线程分块下载对延迟不敏感、影响很小。
- **对象存储直出**：若把下载改为 MinIO 预签名 URL 直出（演进项），出口带宽可由 MinIO/云对象存储独立承担，网关带宽需求大幅下降。

### 4.3 存储与并发容量规划

| 资源 | 估算规则 | 示例（100 用户，人均 50 GB，5 万文件） |
|---|---|---|
| 对象存储数据盘 | 有效容量 / EC 冗余率（EC:4 ≈ 1.33） | 5 TB 有效 → 约 6.7 TB 物理 |
| PostgreSQL | ≈ 1~2 KB/文件元数据行 | 5 万行 ≈ 100 MB（微不足道） |
| Redis | ≈ 200 B/键，缓存与限流为主 | 256 MB 充裕 |
| 网关内存 | 与流式并发数相关（每个流仅 32 KB 缓冲） | 500 并发流 ≈ 数十 MB |

### 4.4 上线检查清单

- [ ] `.env` 中所有 SECRET 已换成强随机值（严禁默认值上线）
- [ ] 全站 HTTPS；`SHARE_BASE_URL` 指向正确公网域名
- [ ] Nginx/Caddy 已关闭 proxy_buffering
- [ ] PostgreSQL / 对象存储 备份任务已生效并做过一次恢复演练
- [ ] 分享有效期、下载次数默认策略符合内部安全规范
- [ ] 防火墙仅放行 80/443；对象存储/Redis/PG 不暴露公网
