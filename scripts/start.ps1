<#
  云栖盘 · 一键启动脚本（Windows PowerShell 5.1+）
  ─────────────────────────────────────────────────────────
  用法:
    .\scripts\start.ps1                完整启动（Docker 依赖 + 服务端 + 客户端）
    .\scripts\start.ps1 -ServerOnly    只启动 Docker 依赖 + 服务端
    .\scripts\start.ps1 -ClientOnly    只启动客户端
    .\scripts\start.ps1 -SkipDeps      跳过 Docker 依赖（自行准备 PG/Redis/MinIO）
    .\scripts\start.ps1 -NoDocker      不使用 Docker（依赖必须自行准备，服务端需本机 Go）
    .\scripts\start.ps1 -SkipInstall   跳过 go mod tidy / npm install（已装好时提速）
    .\scripts\start.ps1 -UseMirror     安装依赖时使用国内镜像（goproxy.cn / npmmirror）
    .\scripts\start.ps1 -Wipe          停止时连同数据卷一起删除（慎用）
    .\scripts\start.ps1 -Stop          停止全部（服务端/客户端/依赖容器）
    .\scripts\start.ps1 -Status        查看运行状态
    .\scripts\start.ps1 -Check         只做环境体检，不启动任何东西
#>
[CmdletBinding()]
param(
    [switch]$ServerOnly,
    [switch]$ClientOnly,
    [switch]$SkipDeps,
    [switch]$NoDocker,
    [switch]$SkipInstall,
    [switch]$UseMirror,
    [switch]$Wipe,
    [switch]$Stop,
    [switch]$Status,
    [switch]$Check,
    [int]$Port = 0
)

# 输出统一 UTF-8（配合 start.bat 的 chcp 65001，中文日志不乱码）
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# 关键：用 Continue 而非 Stop —— PS 5.1 中 EAP=Stop 会把原生程序（docker 等）的
# stderr 变成终止性错误，即使写了 2>$null 也会直接崩出（守护进程未启动时必现）。
# 本脚本全部依赖显式的 $LASTEXITCODE / ExitCode 判断与 throw，不需要 Stop。
$ErrorActionPreference = 'Continue'

$Root          = Split-Path -Parent $PSScriptRoot
$ServerDir     = Join-Path $Root 'server'
$ClientDir     = Join-Path $Root 'client'
$Compose       = Join-Path $ServerDir 'docker-compose.dev.yml'
$ComposeProj   = 'wangpan'
$Port          = 8080
$ApiHealth     = "http://127.0.0.1:$Port/healthz"
$DockerDesktop = 'C:\Program Files\Docker\Docker\Docker Desktop.exe'
$ContainerName = 'wangpan-server'
$ServerLog     = Join-Path $Root 'logs'

function Write-Step($msg) { Write-Host "`n[云栖盘] $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "   OK  $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "   WARN $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "   ERR $msg" -ForegroundColor Red }
function Write-Info($msg) { Write-Host "   ·   $msg" -ForegroundColor Gray }

function Find-Cmd($name) {
    $c = Get-Command $name -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    return $null
}

function Get-Go {
    $go = Find-Cmd 'go'
    if ($go) { return $go }
    $toolsGo = Join-Path $Root '.tools\go\bin\go.exe'
    if (Test-Path $toolsGo) { return $toolsGo }
    return $null
}

function Use-BundledGo($go) {
    # 使用 .tools 便携 Go 时，把 Go 的各类缓存目录重定向到工作区（兼容受限环境）
    if ($go -and $go -like (Join-Path $Root '*')) {
        $env:GOROOT = Split-Path (Split-Path $go)
        $env:GOPATH = Join-Path $Root '.tools\gopath'
        $env:GOMODCACHE = Join-Path $env:GOPATH 'pkg\mod'
        $env:GOCACHE = Join-Path $Root '.tools\gocache'
        $env:GOTMPDIR = Join-Path $Root '.tools\gotmp'
        $env:PATH = (Split-Path $go) + ';' + $env:PATH
        New-Item -ItemType Directory -Force -Path $env:GOTMPDIR | Out-Null
    }
}

function Get-Npm {
    $npm = Find-Cmd 'npm.cmd'
    if ($npm) { return $npm }
    $node = Find-Cmd 'node'
    if ($node) {
        $p = Join-Path (Split-Path $node) 'npm.cmd'
        if (Test-Path $p) { return $p }
    }
    return $null
}

function Get-DockerClient {
    return Find-Cmd 'docker'
}

function Test-DockerDaemon {
    # 探测 docker 守护进程是否在线（守护进程未启动时优雅返回 false，绝不抛错）
    $d = Get-DockerClient
    if (-not $d) { return $false }
    $v = ''
    try {
        $v = (& $d info --format '{{.ServerVersion}}' 2>$null | Out-String).Trim()
    } catch { }
    return ($LASTEXITCODE -eq 0 -and $v -match '^\d+\.\d+')
}

function Wait-Http([string]$Url, [int]$Seconds, [string]$What) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $r = Invoke-WebRequest -Uri $Url -TimeoutSec 3 -UseBasicParsing
            if ($r.StatusCode -eq 200) { return $true }
        } catch { }
        Start-Sleep -Seconds 2
    }
    return $false
}

function Find-FreePort([int]$start) {
    # 确定性检测：实际尝试绑定 127.0.0.1 端口（比查询监听表更可靠，
    # 兼容 Get-NetTCPConnection 在某些受限环境返回空的情况）
    for ($p = $start; $p -lt $start + 100; $p++) {
        $l = $null
        try {
            $l = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $p)
            $l.Start()
            $l.Stop()
            return $p
        } catch {
            if ($l) { try { $l.Stop() } catch { } }
        }
    }
    throw '找不到可用端口（8080~8179 均被占用）'
}

function Find-RunningServer([int]$start, [int]$count) {
    # 扫描候选端口，发现已有健康服务端则返回端口号（双击 start.bat 不会起第二个实例）
    for ($p = $start; $p -lt $start + $count; $p++) {
        try {
            $r = Invoke-WebRequest -Uri "http://127.0.0.1:$p/healthz" -TimeoutSec 2 -UseBasicParsing
            if ($r.StatusCode -eq 200 -and $r.Content -match '"ok":true') { return $p }
        } catch { }
    }
    return 0
}

function Invoke-DockerCompose([string[]]$ComposeArgs) {
    # 注意：参数不能命名为 $Args（与 PowerShell 自动变量冲突，splat 会变空）
    $d = Get-DockerClient
    & $d compose -p $ComposeProj -f $Compose @ComposeArgs
    if ($LASTEXITCODE -ne 0) { throw "docker compose 执行失败" }
}

function Test-Env {
    Write-Step '环境体检'
    $node = Find-Cmd 'node'
    $npm  = Get-Npm
    $go   = Get-Go
    $doc  = Get-DockerClient
    $dok  = Test-DockerDaemon
    if ($node) { Write-Ok ("Node.js    " + (& $node --version) + "   " + $node) } else { Write-Err '未找到 Node.js（客户端必需）。安装：winget install OpenJS.NodeJS.LTS' }
    if ($npm)  { Write-Ok ("npm        " + $npm) } else { Write-Err '未找到 npm.cmd（随 Node.js 一起安装）' }
    if ($go)   { Write-Ok ("Go         " + (& $go version) + "   " + $go) } else { Write-Warn '未找到 Go（可用 Docker 容器方式跑服务端，或安装：winget install GoLang.Go）' }
    if ($doc) {
        if ($dok) { Write-Ok 'Docker 守护进程已就绪' }
        else {
            if (Test-Path $DockerDesktop) { Write-Warn 'Docker Desktop 已安装但未运行（脚本会在需要时自动启动）' }
            else { Write-Warn '未安装 Docker Desktop（可用 -SkipDeps + 自建依赖，或 winget install Docker.DockerDesktop）' }
        }
    } else { Write-Warn '未找到 docker 命令' }
    $aria = Find-Cmd 'aria2c'
    if ($aria) { Write-Ok ("aria2c     " + $aria + "（可选加速内核）") } else { Write-Info '未安装 aria2c（可选：加速下载内核；不装则用自研内核）' }
    Write-Info "项目根目录: $Root"
    return @{ node = $node; npm = $npm; go = $go; docker = $doc; dockerOk = $dok }
}

function Start-DockerDaemon {
    if (Test-DockerDaemon) { return $true }
    if (-not (Test-Path $DockerDesktop)) { return $false }
    Write-Info '正在启动 Docker Desktop（首次启动可能较慢）...'
    Start-Process -FilePath $DockerDesktop | Out-Null
    $deadline = (Get-Date).AddSeconds(150)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 8
        if (Test-DockerDaemon) { Write-Ok 'Docker 守护进程已就绪'; return $true }
    }
    return $false
}

function Start-Deps {
    Write-Step '启动依赖容器（PostgreSQL + Redis + S3 对象存储）'
    if (-not (Start-DockerDaemon)) {
        Write-Err 'Docker 不可用。请安装/启动 Docker Desktop，或用 -SkipDeps 自行提供依赖服务。'
        exit 1
    }
    Invoke-DockerCompose @('up', '-d')
    # 等待三个容器健康（compose 文件指定了 container_name，无 -1 后缀）
    Write-Info '等待依赖容器健康检查（首次约 10~60 秒，属正常过程，请勿按 Ctrl+C）...'
    $deadline = (Get-Date).AddSeconds(180)
    $d = Get-DockerClient
    $svcMap = @{ postgres = 'wangpan-postgres'; redis = 'wangpan-redis'; s3mock = 'wangpan-s3mock' }
    $waited = 0
    while ((Get-Date) -lt $deadline) {
        $bad = @()
        foreach ($k in @('postgres', 'redis', 's3mock')) {
            $st = & $d inspect --format '{{.State.Health.Status}}' $svcMap[$k] 2>$null
            if ($st -ne 'healthy') { $bad += $k }
        }
        if ($bad.Count -eq 0) { Write-Ok '三个依赖容器全部健康'; return }
        $waited += 5
        Write-Info ("容器启动中({0} 秒): 待就绪 {1} —— 请耐心等待，不要中断" -f $waited, ($bad -join ', '))
        Start-Sleep -Seconds 5
    }
    Write-Warn '容器健康检查超时，继续尝试启动服务端（可能随后自动恢复）'
}

function Stop-ServerProcesses {
    # 1) 宿主 go run 方式
    Get-CimInstance Win32_Process -Filter "Name='go.exe' OR Name='server.exe' OR Name='wangpan-server.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like "*$ServerDir*" } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Write-Ok ("已停止服务端进程 PID " + $_.ProcessId) }
    # 2) Docker 容器方式
    $d = Get-DockerClient
    if ($d) { & $d rm -f $ContainerName 2>$null | Out-Null }
}

function Start-Server($go) {
    Write-Step '启动 Go 服务端'
    if ($go) {
        Use-BundledGo $go
        if (-not $SkipInstall) {
            Write-Info 'go mod tidy（首次会拉取依赖）...'
            if ($UseMirror) { $env:GOPROXY = 'https://goproxy.cn,direct' }
            $p = Start-Process -FilePath $go -ArgumentList @('mod', 'tidy') -WorkingDirectory $ServerDir -Wait -PassThru -NoNewWindow
            if ($p.ExitCode -ne 0) { throw 'go mod tidy 失败' }
        }
        # 端口竞争（其他服务在启动间隙抢占端口）时自动换端口重试，最多 3 次
        $tried = @()
        for ($attempt = 1; $attempt -le 3; $attempt++) {
            while ($tried -contains $script:Port) { $script:Port = Find-FreePort ($script:Port + 1) }
            $tried += $script:Port
            Write-Info ("启动服务端（后台运行，日志 logs\server.log；停止: start.bat -Stop；端口 " + $script:Port + "，第 " + $attempt + " 次尝试）...")
            # 显式绑定 127.0.0.1：端口被占用时立即报错，而不是静默退到 IPv6 被"影子化"
            $env:SERVER_ADDR = "127.0.0.1:$script:Port"
            # 上传会话存储：优先使用 compose 中的 Redis（未配置时服务端自动降级为磁盘缓存）
            if (-not $env:REDIS_URL) { $env:REDIS_URL = 'redis://127.0.0.1:6379/0' }
            $logDir = Join-Path $Root 'logs'
            New-Item -ItemType Directory -Force -Path $logDir | Out-Null
            Start-Process -FilePath $go -ArgumentList @('run', './cmd/server') -WorkingDirectory $ServerDir -WindowStyle Hidden `
                -RedirectStandardOutput (Join-Path $logDir 'server.log') `
                -RedirectStandardError (Join-Path $logDir 'server.err.log') | Out-Null
            if (Wait-Http "http://127.0.0.1:$script:Port/healthz" 60 '服务端') {
                Write-Ok "服务端已就绪: http://127.0.0.1:$script:Port（健康检查通过）"
                return
            }
            Write-Warn "端口 $Port 启动失败（可能刚被其他进程抢占），清理后换端口重试..."
            Get-CimInstance Win32_Process -Filter "Name='server.exe'" -ErrorAction SilentlyContinue |
                Where-Object { $_.CommandLine -like '*gotmp*' -or $_.ExecutablePath -like '*go-build*' } |
                ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
            Get-CimInstance Win32_Process -Filter "Name='go.exe'" -ErrorAction SilentlyContinue |
                Where-Object { $_.CommandLine -like '*run ./cmd/server*' } |
                ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        }
        Write-Err "服务端在 3 次尝试后仍未就绪。请检查：$Port 端口占用情况 / 服务端窗口日志"
        exit 1
    }
    else {
        Write-Warn '本机没有 Go，使用 Docker 容器运行服务端（首次需拉取 golang 镜像并下载依赖，可能较慢）...'
        if (-not (Start-DockerDaemon)) { Write-Err 'Docker 不可用且本机无 Go，无法启动服务端。'; exit 1 }
        $d = Get-DockerClient
        & $d rm -f $ContainerName 2>$null | Out-Null
        & $d run -d --name $ContainerName --network ("$ComposeProj" + '_default') -p ("$Port" + ':8080') --restart unless-stopped `
            -v wangpan-gocache:/go -v ("$ServerDir" + ':/app') -w /app `
            -e SERVER_ADDR=:8080 `
            -e DATABASE_URL='postgres://wangpan:wangpan@postgres:5432/wangpan?sslmode=disable' `
            -e MINIO_ENDPOINT='s3mock:9090' -e MINIO_ACCESS_KEY='minioadmin' -e MINIO_SECRET_KEY='minioadmin' `
            -e MINIO_BUCKET='wangpan' -e MINIO_USE_SSL='false' -e REDIS_URL='redis://redis:6379/0' `
            -e JWT_SECRET='dev-jwt-change-me' -e PREVIEW_TOKEN_SECRET='dev-preview-change-me' -e DEFAULT_QUOTA_GB=10 `
            golang:1.22-alpine sh -c 'go mod download && go build -o /tmp/wp-server ./cmd/server && /tmp/wp-server'
        if ($LASTEXITCODE -ne 0) { throw 'docker run 服务端失败' }
        Write-Info '容器已创建，等待编译与启动（首次约 3~8 分钟）...'
        if (-not (Wait-Http $ApiHealth 600 '服务端')) {
            Write-Err "服务端未在 $Port 端口就绪。请检查：server 窗口日志 / 'docker logs -f $ContainerName'"
            exit 1
        }
        Write-Ok "服务端已就绪: http://127.0.0.1:$Port（健康检查通过）"
    }
}

function Start-Client($env) {
    Write-Step '启动 Electron 客户端'
    if (-not $env.node) { Write-Err '未找到 Node.js，无法启动客户端。安装：winget install OpenJS.NodeJS.LTS'; exit 1 }
    $electron = Join-Path $ClientDir 'node_modules\electron\dist\electron.exe'
    if (-not (Test-Path $electron)) {
        if (-not $env.npm) { Write-Err '未找到 npm.cmd，无法安装 electron。'; exit 1 }
        if ($SkipInstall) { Write-Err 'electron 未安装且指定了 -SkipInstall，无法启动。'; exit 1 }
        Write-Info '首次运行：npm install 安装 electron（约 100MB）...'
        if ($UseMirror) { $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/' }
        $p = Start-Process -FilePath $env.npm -ArgumentList @('install', '--no-audit', '--no-fund') -WorkingDirectory $ClientDir -Wait -PassThru -NoNewWindow
        if ($p.ExitCode -ne 0) { Write-Err 'npm install 失败。国内网络可加 -UseMirror 重试。'; exit 1 }
        # npm 11+ 可能拦截 electron 的安装脚本：postinstall 补偿脚本会处理，这里再兜底一次
        if (-not (Test-Path $electron)) {
            Write-Info '补装 electron 二进制（install.js）...'
            & (Find-Cmd 'node') (Join-Path $ClientDir 'node_modules\electron\install.js')
            if ($LASTEXITCODE -ne 0) { Write-Err 'electron 二进制下载失败（可加 -UseMirror 重试）'; exit 1 }
        }
    }
    Write-Ok '客户端启动中（主窗口稍后弹出）...'
    Start-Process -FilePath $electron -ArgumentList @($ClientDir) -WorkingDirectory $ClientDir | Out-Null
}

function Stop-All {
    Write-Step '停止云栖盘'
    Stop-ServerProcesses
    # 客户端：只杀本项目目录下的 electron 进程
    Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like "*$ClientDir*" } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Write-Ok ("已停止客户端进程 PID " + $_.ProcessId) }
    $d = Get-DockerClient
    if ($d -and (Test-DockerDaemon)) {
        Write-Info '停止依赖容器（数据卷保留；-Wipe 可连同数据卷删除）...'
        if ($Wipe) { Invoke-DockerCompose @('down', '-v') } else { Invoke-DockerCompose @('down') }
        Write-Ok '依赖容器已停止'
    }
    Write-Ok '全部已停止'
}

function Show-Status {
    Write-Step '运行状态'
    $alive = Wait-Http $ApiHealth 3 '服务端'
    if ($alive) { Write-Ok "服务端运行中: $ApiHealth" } else { Write-Err "服务端未响应: $ApiHealth" }
    $d = Get-DockerClient
    if ($d -and (Test-DockerDaemon)) {
        & $d compose -p $ComposeProj -f $Compose ps
        if (& $d ps --filter "name=$ContainerName" --format '{{.Names}} {{.Status}}') { Write-Ok '服务端容器（Docker 方式）在运行' }
    }
    $eps = Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like "*$ClientDir*" }
    if ($eps) { Write-Ok ("客户端运行中: " + $eps.Count + " 个进程") } else { Write-Info '客户端未运行' }
    $sps = Get-CimInstance Win32_Process -Filter "Name='go.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like "*$ServerDir*" }
    if ($sps) { Write-Ok '服务端进程（本机 Go 方式）在运行' }
}

# ══════════════════════════════ 主流程 ══════════════════════════════
if ($Port -le 0) { $Port = Find-FreePort 8080 }
if ($Port -ne 8080) { Write-Info "8080 端口被占用，服务端改用端口 $Port（客户端登录页填写 http://127.0.0.1:$Port）" }
$ApiHealth = "http://127.0.0.1:$Port/healthz"

$env = Test-Env
if ($Check) { exit 0 }
if ($Stop)   { Stop-All; exit 0 }
if ($Status) { Show-Status; exit 0 }

if (-not $ClientOnly) {
    if (-not $SkipDeps) { Start-Deps }
    # 防呆：已有健康服务端在运行时跳过重复启动（双击 start.bat 不会起两个实例）
    $runningPort = Find-RunningServer 8080 20
    if ($runningPort -gt 0) {
        $script:Port = $runningPort
        Write-Ok "检测到服务端已在 $script:Port 运行，跳过启动"
    }
    else {
        Start-Server $env.go
    }
    $ApiHealth = "http://127.0.0.1:$Port/healthz"   # 重试换端口后同步刷新
}
if (-not $ServerOnly) {
    Start-Client $env
}

Write-Step '启动完成'
Write-Info "服务端 API : http://127.0.0.1:$Port（客户端免登录自动连接，打开即用）"
Write-Info "对象存储 S3 : http://127.0.0.1:19000（开发用 s3mock，生产可接 MinIO 企业版等 S3 存储）"
Write-Info "健康检查   : $ApiHealth"
Write-Info '提示：可选安装 aria2c 并在客户端「设置」中启用加速内核；不装也可正常使用。'
