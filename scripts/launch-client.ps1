# launch-client.ps1 —— 云栖盘客户端启动器（由 启动云栖盘.cmd 调用）
# 流程：探测服务端(8080~8083) → 不在线则调 start.ps1 -ServerOnly 拉起 → 再次探测
#       → 确保客户端程序本体存在（必要时解压绿色版）→ 启动并观察 60 秒 → 报告结果
[CmdletBinding()]
param()

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Continue'

$Root = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $Root 'logs'
$Log = Join-Path $LogDir 'client-launch.log'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-Log([string]$msg) {
    Write-Host $msg
    try { Add-Content -Path $Log -Value ('[' + (Get-Date -Format 'HH:mm:ss') + '] ' + $msg) -Encoding UTF8 } catch { }
}

function Find-Server {
    foreach ($p in 8080..8083) {
        try {
            $r = Invoke-WebRequest -Uri "http://127.0.0.1:$p/healthz" -TimeoutSec 2 -UseBasicParsing
            if ($r.StatusCode -eq 200 -and $r.Content -match '"ok":true') { return $p }
        } catch { }
    }
    return 0
}

function Start-And-Watch([string]$extraArgs) {
    # 防御：若环境存在 ELECTRON_RUN_AS_NODE，Electron 会以 Node 模式运行并拒绝 Chromium 参数
    if (Test-Path Env:\ELECTRON_RUN_AS_NODE) { Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue }
    # 简化版监控：不使用异步事件回调；进程存活 60 秒即成功，
    # 退出后才同步读取（无 --v=1 时 Chromium 输出很小，不会撑爆管道）。
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $App
    # --no-sandbox：本机 Chromium 进程沙箱在系统安全策略下初始化失败（STATUS_BREAKPOINT），
    # 必须禁用 OS 级沙箱才能启动（渲染层 contextIsolation/sandbox 仍生效）
    $psi.Arguments = '--no-sandbox --enable-logging'
    if ($extraArgs) { $psi.Arguments += ' ' + $extraArgs }
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    try {
        $p = [System.Diagnostics.Process]::Start($psi)
    }
    catch {
        Write-Log ('[错误] 启动进程失败: ' + $_.Exception.Message)
        return $false
    }
    Write-Log ('客户端进程已创建 PID=' + $p.Id)

    $startedAt = Get-Date
    while ((Get-Date) -lt $startedAt.AddSeconds(60)) {
        try { if ($p.WaitForExit(500)) { break } } catch { break }
    }

    if (-not $p.HasExited) {
        Write-Log '[OK] 客户端进程存活，窗口应已出现。'
        return $true
    }

    $code = 0
    try { $code = $p.ExitCode } catch { }
    $hex = '{0:X8}' -f ([int64]$code -band 0xFFFFFFFFL)
    Write-Log ('[提示] 客户端进程已退出，退出码 ' + $code + ' (0x' + $hex + ')，存活约 ' + [int]((Get-Date) - $startedAt).TotalSeconds + ' 秒。')
    $err = ''
    try { $err = $p.StandardError.ReadToEnd() } catch { }
    if ($err) {
        $err = $err.Substring(0, [Math]::Min(1200, $err.Length))
        Write-Log '---- 客户端错误输出 ----'
        $err -split "`r?`n" | ForEach-Object { Write-Log ('  ' + $_) }
    }
    return $false
}

try {
    Write-Log '云栖盘启动器开始'
    $port = Find-Server
    if ($port -gt 0) {
        Write-Log "服务端在线: http://127.0.0.1:$port"
    }
    else {
        Write-Log '服务端不在线，正在自动启动（Docker 依赖 + Go 服务端，首次约 1~3 分钟，请勿按 Ctrl+C）...'
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'scripts\start.ps1') -ServerOnly
        $port = Find-Server
        if ($port -eq 0) {
            Write-Log '[错误] 服务端仍未就绪，详情见 logs\start.log。可再次双击本启动器重试。'
            exit 1
        }
        Write-Log "服务端已就绪: http://127.0.0.1:$port"
    }

    # 用户数据目录一律指向项目内（便携化）：绕开部分环境下应用进程无法写 %APPDATA%
    # 的问题。应用在 ready 前读取 WP_USER_DATA。
    $runtimeProfile = Join-Path $Root '.runtime\profile'
    New-Item -ItemType Directory -Force -Path $runtimeProfile | Out-Null
    $env:WP_USER_DATA = $runtimeProfile
    Write-Log ('用户数据目录: ' + $runtimeProfile + '（便携模式）')

    # 把探测到的服务端地址写入客户端配置（免登录模式自动连接用）
    $settingsFile = Join-Path $runtimeProfile 'settings.json'
    try {
        $s = $null
        if (Test-Path $settingsFile) {
            try { $s = Get-Content $settingsFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $s = $null }
        }
        if (-not $s) { $s = [pscustomobject]@{} }
        $s | Add-Member -MemberType NoteProperty -Name serverBase -Value ("http://127.0.0.1:" + $port) -Force
        $s | ConvertTo-Json -Depth 8 | Set-Content -Path $settingsFile -Encoding UTF8
    } catch {
        Write-Log ('[提示] 写入 settings.json 失败: ' + $_.Exception.Message)
    }

    # 确保客户端程序本体存在（优先解压好的目录，其次解压绿色版 zip）
    $App = Join-Path $Root 'client\dist\win-unpacked\云栖盘.exe'
    if (-not (Test-Path $App)) {
        Write-Log '客户端程序本体不存在，尝试解压绿色版 zip ...'
        $zip = Join-Path $Root 'client\dist\yunqipan-1.0.0-win-绿色版.zip'
        if (Test-Path $zip) {
            try { Expand-Archive -Force $zip (Join-Path $Root 'client\dist\win-unpacked') } catch { Write-Log ('解压失败: ' + $_.Exception.Message) }
        }
    }
    if (-not (Test-Path $App)) {
        Write-Log ('[错误] 未找到 ' + $App + '，请先运行 start.bat 或重新解压绿色版 zip。')
        exit 1
    }

    Write-Log ('启动客户端: ' + $App + '（首次约 10~30 秒出窗口，请耐心等待）...')

    $ok = Start-And-Watch ''
    if (-not $ok) {
        Write-Log '尝试兼容模式重试（禁用 GPU 与软件光栅化，适配部分显卡/驱动环境）...'
        $ok = Start-And-Watch '--disable-gpu --disable-software-rasterizer'
    }

    if ($ok) { exit 0 }

    Write-Log '[异常] 客户端进程未能持续运行（已重试兼容模式）。'
    $errLog = Join-Path $env:APPDATA 'yunqipan-client\startup-error.log'
    if (Test-Path $errLog) {
        Write-Log ('---- 应用启动错误日志 ' + $errLog + ' ----')
        Get-Content $errLog -Tail 30 -Encoding UTF8 | ForEach-Object { Write-Log ('  ' + $_) }
    }
    else {
        Write-Log '未发现应用启动错误日志（%APPDATA%\yunqipan-client\startup-error.log）'
        Write-Log '提示: 可反馈上方「客户端错误输出」或 logs\client-launch.log 给维护者。'
    }
    exit 1
}
catch {
    Write-Log ('[错误] 启动器异常: ' + ($_.Exception.Message))
    Write-Log ($_.ScriptStackTrace.Substring(0, [Math]::Min(400, $_.ScriptStackTrace.Length)))
    exit 1
}
