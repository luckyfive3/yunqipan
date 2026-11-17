# 安全策略

## 报告安全问题

如发现本项目存在安全漏洞，请**不要**通过公开 Issue 披露细节，改用以下任一方式私下联系维护者：

- GitHub 私密漏洞报告：仓库 **Security → Report a vulnerability**（推荐）
- 其他渠道：通过仓库所有者 GitHub 主页留有的联系方式

请在报告中说明：影响范围、复现步骤、可能的利用方式。我们会在确认后尽快修复并在 Release 中说明。

## 仓库中不含任何真实凭据

本仓库是**源码仓库**，不包含任何生产环境密钥、账号口令、云厂商 AccessKey、Cookie 或私钥。提交前已做如下处理：

| 类别 | 处理方式 |
|---|---|
| 环境变量 | 仅提交 `server/.env.example` 模板；真实 `.env` 被 `.gitignore` 排除 |
| 默认密钥 | 模板中一律为 `*-change-me` 占位值，**不可用于任何真实环境** |
| 测试凭据 | 冒烟测试使用临时账号与 CI 一次性假密钥（如 `ci-jwt-secret`），仅存活于 CI 容器 |
| 对象存储 | 示例中为 `minioadmin`，即 s3mock/MinIO 本地开发默认值 |
| 运行日志 | `logs/` 与 `*.log` 已排除（避免泄露本机路径与文件名） |
| 构建产物 | 可执行文件与 `client/resources/server/` 不提交，由脚本生成 |

## 部署前必做

自行部署时，**必须**替换下列值（`openssl rand -hex 32` 生成强随机值）：

```bash
JWT_SECRET=<强随机值>
PREVIEW_TOKEN_SECRET=<另一个强随机值>
MINIO_SECRET_KEY=<强随机值>
```

并确保：服务端启用 HTTPS、数据库/对象存储不对公网直接暴露、按需收紧 CORS 与上传大小限制。

## 依赖与漏洞扫描

- 推送前已启用 GitHub **Secret Scanning** 与 **Push Protection**，阻止密钥入库。
- 建议启用 Dependabot 以跟踪 `go.sum` 与 `client/package-lock.json` 的已知漏洞。
