# 云栖盘（YunXi Drive）

Windows / macOS 双平台桌面云盘客户端 + Go 私有云服务端。

**两大核心能力**
1. **私有云盘**：账号/配额/权限分级、文件管理（上传/下载/删除/重命名/目录/在线预览）、大文件分块断点续传、公开/私密分享（提取码·有效期·次数限制）、统一传输队列（暂停/继续/取消/并发自定义）、本地目录双向同步、E2E 加密（AES-256-GCM 可选）。
2. **跨网盘下载优化（严格合规）**：仅支持**公开分享链接**的解析；自研多线程分块下载内核（1~32 线程、动态块大小、控制文件断点续传）+ 可选 aria2 加速内核；任务与私有云盘队列统一调度展示。

> ⚖️ 合规声明：本项目不含任何破解/反编译/绕过鉴权/篡改客户端功能；解析模块只处理匿名可访问的公开内容，提取码由用户输入并仅走页面同源公开接口；解析/加速模块默认禁用、可独立启停，禁用后私有云盘功能不受影响。

## 仓库结构

| 目录 | 说明 |
|---|---|
| [docs/01-architecture.md](docs/01-architecture.md) | 系统架构图（Mermaid）、模块划分、技术选型、关键机制设计 |
| [docs/02-api-spec.md](docs/02-api-spec.md) | REST API 契约（前后端唯一接口基准，含时序图与合规边界） |
| [docs/03-deployment.md](docs/03-deployment.md) | 部署流程、环境配置、服务器带宽与存储选型 |
| [docs/04-roadmap.md](docs/04-roadmap.md) | 性能优化与功能扩展路线 |
| [server/](server/) | Go 服务端（net/http + PostgreSQL + Redis(可选) + S3 兼容存储） |
| [client/](client/) | Electron 客户端（自研下载内核 + aria2 可选 + 中文 UI，零构建渲染层） |
| [scripts/](scripts/) | 一键启动（start.ps1/start.bat/start.sh）、端到端冒烟（smoke.ps1/smoke.sh） |
| [.github/workflows/ci.yml](.github/workflows/ci.yml) | GitHub Actions CI（构建/测试/端到端冒烟/发布产物） |

## 技术栈

- **客户端**：Electron 31；自研 Node Range 分块下载内核（慢块自适应再分块）+ 可选 aria2c JSON-RPC；原生 HTML/CSS/JS 渲染层（无打包器）。
- **服务端**：Go 1.22（标准库 net/http）；aws-sdk-go-v2 对接 S3 兼容对象存储（开发用 adobe/s3mock，生产可接 MinIO 企业版/AWS S3/阿里 OSS；Multipart 分块上传 / Range 下载）；PostgreSQL 16 元数据；Redis 7 限流缓存（可选，可降级）。
- **传输**：HTTPS + 标准 HTTP Range 断点续传；上传 8 MiB 分块、服务端 S3 Multipart 合并，中断零重传。

## 快速开始

### 0. 一键启动（推荐）

- **Windows**：双击根目录 [start.bat](start.bat)（或 `scripts\start.ps1`）。自动完成：环境体检 → 拉起依赖容器（PG/Redis/S3）→ 启动服务端（本机无 Go 时自动用 Docker 容器方式）→ 启动客户端；8080 被占用时自动顺延端口。常用参数：`-ServerOnly` / `-ClientOnly` / `-SkipDeps` / `-UseMirror`（国内镜像）/ `-Stop` / `-Status` / `-Check`。
- **macOS / Linux**：`./scripts/start.sh`（参数同义：`--server-only` 等）。

### 1. 手动启动服务端（Docker Compose）

```bash
cd server
cp .env.example .env            # 修改 JWT_SECRET / PREVIEW_TOKEN_SECRET / MINIO 密钥
docker compose -f docker-compose.dev.yml up -d    # PG + Redis + s3mock
go mod tidy && go run ./cmd/server                # 服务端（自动建表+建 bucket）
```

### 2. 手动启动客户端

```bash
cd client
npm install                     # 仅依赖 electron（国内可配 ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/）
npm start
```

客户端首次进入登录页，填写服务端地址（默认 `http://127.0.0.1:8080`）→ 注册 → 即可使用全部私有云盘功能。
可选：安装 aria2c 后在「设置」中开启加速内核（不装也可，自动回退自研内核）。

## 测试与 CI

| 命令 | 说明 |
|---|---|
| `cd server && go test ./...` | 服务端单元测试（路由注册回归/Range 解析/令牌/迁移切分/缓存降级等） |
| `cd client && npm test` | 客户端功能自测（自研下载内核/上传契约/E2E 加密/传输队列，纯 Node 无需 electron） |
| `bash scripts/smoke.sh` | 端到端冒烟（31 项：注册登录→8MiB 分块上传→断点状态→Range 206→预览签名→分享计数→删除） |
| `powershell -ExecutionPolicy Bypass -File scripts\smoke.ps1 -ServerUrl http://127.0.0.1:8080` | 同上（Windows 版） |

CI：[.github/workflows/ci.yml](.github/workflows/ci.yml)（GitHub Actions）——
服务端 `gofmt + go vet + go test + go build`、`PG/Redis/s3mock 真实依赖端到端冒烟`、
客户端 `全量 node --check + npm test`；推 `v*` 标签自动出 Windows（NSIS/便携版）与 macOS（dmg/zip）安装包。

## 安装包打包

```bash
cd client
npm install
npm run dist:win      # NSIS 安装包 + 便携版（dist/ 下）
npm run dist:mac      # macOS dmg + zip（需在 macOS 上执行）
powershell -ExecutionPolicy Bypass -File scripts\sign-dev.ps1   # 用本机开发证书签名（可选但推荐）
```

### 安装/运行被系统拦截怎么办

- **推荐：直接用便携版** `yunqipan-*-portable.exe`（免安装，双击即用）。
- 安装包报错时依次排查：
  1. 右键安装包 → 属性 → 勾选「解除锁定」（网络下载来源标记）；
  2. SmartScreen 提示「Windows 已保护你的电脑」→ 「更多信息」→「仍要运行」；
  3. Windows Defender 误报 → 「病毒和威胁防护」→ 保护历史记录 → 恢复/允许；必要时添加排除项（`client\dist`）；
  4. 若系统启用了「智能应用控制（Smart App Control）」→ 该策略只放行有信誉签名的应用，需在
     「隐私和安全性 → 智能应用控制」中关闭，或改用便携版；
  5. 运行 `scripts\sign-dev.ps1` 后重新分发产物：本机信任开发证书后不再出现未知发布者提示。
- 正式对外发布请购买正规代码签名证书（EV/OV），可彻底消除 SmartScreen/Defender 误报。

## 完整部署

生产部署（TLS/反代/备份/带宽选型）见 [docs/03-deployment.md](docs/03-deployment.md)。

## 关键设计速览

- **断点续传**：上传 = 客户端分块 + 跳过 `received[]`（S3 ListParts 为准）；下载 = `<文件>.wpdl.json` 控制文件记录每块完成偏移，崩溃后按块精确续传，目标文件预分配按 offset 写入、不损坏。
- **动态块大小**：5 s 采样各块速度，慢于中位数 30% 持续两个周期的块自动一分为二交给空闲线程，同块最多分裂 3 次。
- **统一队列**：上传/云盘下载/公开链接下载同一队列，任务状态 500 ms 防抖原子落盘，重启自动恢复。
- **分享体系**：8 位 base62 令牌；提取码只存 bcrypt；下载次数在「新下载」（Range 起点为 0）时原子计数，续传不重复计。
- **E2E 加密**：WPENC1 容器，1 MiB 块级独立 GCM 认证（可随机解密），口令仅存客户端，服务端只见密文。

## 平台要求

- 客户端：Windows 10+ / macOS 12+
- 服务端：Linux x64（Docker 或裸机），Go 1.22+ 源码构建

## License

内部项目，代码仅供学习与自建使用；请遵守所在地法律法规与所对接平台的服务协议。
