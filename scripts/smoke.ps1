<#
  云栖盘 · 端到端冒烟测试（Windows PowerShell 5.1+）
  覆盖与 scripts\smoke.sh 一致：健康检查 → 注册登录 → 建目录 → 分块上传(断点状态)
  → 列表 → 全量下载(sha256) → Range(206) → 预览签名/白名单 → 重命名/移动
  → 分享(提取码/次数/续传不计数) → 浏览器分享页 → 删除
  用法：.\scripts\smoke.ps1 [-ServerUrl http://127.0.0.1:8080]
#>
[CmdletBinding()]
param([string]$ServerUrl = 'http://127.0.0.1:8080')

$ErrorActionPreference = 'Stop'
$Base = "$ServerUrl/api/v1"
$Health = "$ServerUrl/healthz"
$Tmp = Join-Path $env:TEMP ('wp-smoke-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Tmp | Out-Null
$script:Pass = 0
$script:Fail = 0

function Ok($m)   { Write-Host "   OK  $m" -ForegroundColor Green;  $script:Pass++ }
function Bad($m)  { Write-Host "   ERR $m" -ForegroundColor Red;    $script:Fail++ }
function Check([bool]$cond, [string]$m) { if ($cond) { Ok $m } else { Bad $m } }

function Invoke-Api {
    param([string]$Method, [string]$Path, $Body = $null, [string]$Token = '', [hashtable]$Headers = @{})
    $h = @{}
    if ($Token) { $h['Authorization'] = "Bearer $Token" }
    foreach ($k in $Headers.Keys) { $h[$k] = $Headers[$k] }
    $p = @{ Method = $Method; Uri = $Path; UseBasicParsing = $true }
    if ($Body -ne $null) {
        if ($Body -is [byte[]]) { $p['Body'] = $Body; $p['ContentType'] = 'application/octet-stream' }
        else { $p['Body'] = ($Body | ConvertTo-Json -Compress); $p['ContentType'] = 'application/json' }
    }
    if ($h.Count) { $p['Headers'] = $h }
    try { return Invoke-WebRequest @p } catch {
        $resp = $_.Exception.Response
        if ($resp -is [System.Net.HttpWebResponse]) {
            $sr = New-Object System.IO.StreamReader($resp.GetResponseStream())
            $body = $sr.ReadToEnd(); $sr.Close()
            return [pscustomobject]@{ StatusCode = [int]$resp.StatusCode; Content = $body }
        }
        return [pscustomobject]@{ StatusCode = 0; Content = '' }
    }
}

try {
    Write-Host "== 0. 等待服务端就绪 ==" -ForegroundColor Cyan
    $ready = $false
    for ($i = 0; $i -lt 60; $i++) {
        try { $r = Invoke-WebRequest -Uri $Health -TimeoutSec 3 -UseBasicParsing; if ($r.StatusCode -eq 200) { $ready = $true; break } } catch { }
        Start-Sleep -Seconds 2
    }
    if (-not $ready) { throw '服务端未就绪' }
    Ok 'healthz 通过'

    Write-Host "== 1. 注册 / 登录 ==" -ForegroundColor Cyan
    $user = 'smoke_' + (Get-Date -Format 'HHmmss')
    $reg = Invoke-Api POST "$Base/auth/register" @{ username = $user; password = 'password123' }
    $token = ($reg.Content | ConvertFrom-Json).token
    Check ($token -ne $null) '注册返回 JWT'
    $login = Invoke-Api POST "$Base/auth/login" @{ username = $user; password = 'password123' }
    Check ((($login.Content | ConvertFrom-Json).user.username) -eq $user) '登录成功'
    $bad = Invoke-Api POST "$Base/auth/login" @{ username = $user; password = 'wrong-pass' }
    Check ($bad.StatusCode -eq 401) '错误密码 401'

    Write-Host "== 2. 目录与分块上传（10MiB / 两块 8MiB+2MiB）==" -ForegroundColor Cyan
    $dir = Invoke-Api POST "$Base/files/mkdir" @{ parent_id = $null; name = 'smoke-dir' } $token
    $dirId = ($dir.Content | ConvertFrom-Json).file.id
    Check ($dirId -ne $null) '创建目录'

    # 10MiB 随机文件（8MiB 分块：块0=8MiB、块1=2MiB，S3 要求非末块 ≥5MiB）
    $fileSize = 10 * 1024 * 1024
    $bytes = New-Object byte[] $fileSize
    (New-Object Random).NextBytes($bytes)
    [IO.File]::WriteAllBytes("$Tmp\f.bin", $bytes)
    $sha = (Get-FileHash "$Tmp\f.bin" -Algorithm SHA256).Hash.ToLower()

    $init = Invoke-Api POST "$Base/files/upload/init" @{ parent_id = $dirId; name = 'f.bin'; size = $fileSize; mime = 'application/octet-stream'; chunk_size = 8388608 } $token
    $upId = ($init.Content | ConvertFrom-Json).upload_id
    Check ($upId -ne $null) '上传 init（默认 8MiB 分块）'

    $chunkSize = 8388608
    # 分块字节按 curl 文件方式传输（PS 5.1 的 Invoke-WebRequest 发送大二进制体会挂起，curl 无此问题）
    $fs = [IO.File]::OpenRead("$Tmp\f.bin")
    $c0 = New-Object byte[] $chunkSize
    $null = $fs.Read($c0, 0, $chunkSize)
    $c1 = New-Object byte[] ($fileSize - $chunkSize)
    $null = $fs.Read($c1, 0, $c1.Length)
    $fs.Close()
    [IO.File]::WriteAllBytes("$Tmp\c0.bin", $c0)
    [IO.File]::WriteAllBytes("$Tmp\c1.bin", $c1)

    function Put-Chunk([string]$upId, [int]$idx, [string]$file, [string]$auth) {
        return (& curl.exe -s -m 120 -o NUL -w '%{http_code}' -X PUT "$Base/files/upload/$upId/chunk/$idx" -H "Authorization: Bearer $auth" -H 'Content-Type: application/octet-stream' --data-binary "@$file")
    }
    Check ((Put-Chunk $upId 0 "$Tmp\c0.bin" $token) -eq '200') '分块 0 上传成功'
    Check ((Put-Chunk $upId 1 "$Tmp\c1.bin" $token) -eq '200') '分块 1 上传成功'
    Check ((Put-Chunk $upId 0 "$Tmp\c0.bin" $token) -eq '200') '分块 0 幂等重传成功'
    $st = Invoke-Api GET "$Base/uploads/$upId" $null $token
    $recv = (($st.Content | ConvertFrom-Json).received | ForEach-Object { $_ }) -join ','
    Check ($recv -eq '0,1') '断点状态 received=[0,1]'

    $comp = Invoke-Api POST "$Base/files/upload/$upId/complete" @{ sha256 = $sha } $token
    $fid = ($comp.Content | ConvertFrom-Json).file.id
    Check ($fid -ne $null) 'complete 合并入库'

    Write-Host "== 3. 列表 / 下载 / Range ==" -ForegroundColor Cyan
    $ls = Invoke-Api GET "$Base/files?parent_id=$dirId" $null $token
    Check ((($ls.Content | ConvertFrom-Json).items[0].size) -eq $fileSize) '目录列表含 10MiB 文件'

    $dl = Invoke-Api GET "$Base/files/$fid/download?download=1" $null $token
    [IO.File]::WriteAllBytes("$Tmp\d.bin", $dl.Content)
    Check (((Get-FileHash "$Tmp\d.bin" -Algorithm SHA256).Hash.ToLower()) -eq $sha) '全量下载 sha256 校验通过'

    & curl.exe -s -o "$Tmp\r.bin" -w '%{http_code}' -X GET "$Base/files/$fid/download" -H "Authorization: Bearer $token" -H 'Range: bytes=100-199' | Out-Null
    $rcode = & curl.exe -s -o NUL -w '%{http_code}' -X GET "$Base/files/$fid/download" -H "Authorization: Bearer $token" -H 'Range: bytes=100-199'
    Check ($rcode -eq '206') 'Range 下载返回 206'
    Check (((Get-Item "$Tmp\r.bin").Length) -eq 100) 'Range 分段长度 100'

    Write-Host "== 4. 预览：签名免 Bearer + 白名单 ==" -ForegroundColor Cyan
    $txt = "云栖盘预览冒烟内容`nsecond line`n"
    [IO.File]::WriteAllText("$Tmp\t.txt", $txt, (New-Object Text.UTF8Encoding($false)))
    $tbytes = [IO.File]::ReadAllBytes("$Tmp\t.txt")
    $tsha = (Get-FileHash "$Tmp\t.txt" -Algorithm SHA256).Hash.ToLower()
    $init2 = Invoke-Api POST "$Base/files/upload/init" @{ parent_id = $dirId; name = 't.txt'; size = $tbytes.Length; mime = 'text/plain'; chunk_size = 8388608 } $token
    $upId2 = ($init2.Content | ConvertFrom-Json).upload_id
    Check ((Put-Chunk $upId2 0 "$Tmp\t.txt" $token) -eq '200') '文本文件分块上传成功'
    $tid = ((Invoke-Api POST "$Base/files/upload/$upId2/complete" @{ sha256 = $tsha } $token).Content | ConvertFrom-Json).file.id

    $pt = Invoke-Api POST "$Base/files/$tid/preview-token" @{ ttl_seconds = 300 } $token
    $purl = ($pt.Content | ConvertFrom-Json).url
    $pcode = & curl.exe -s -o "$Tmp\p.txt" -w '%{http_code}' "$ServerUrl$purl"
    Check ($pcode -eq '200') 'preview-token 免 Bearer 预览 200'
    Check ((@(Compare-Object ([IO.File]::ReadAllBytes("$Tmp\t.txt")) ([IO.File]::ReadAllBytes("$Tmp\p.txt")))).Count -eq 0) '预览内容与原文一致'
    $bpre = Invoke-Api GET "$Base/files/$fid/preview" $null $token
    Check ($bpre.StatusCode -eq 415) '非白名单 mime 预览 415'

    Write-Host "== 5. 重命名 / 移动 ==" -ForegroundColor Cyan
    $rn = Invoke-Api POST "$Base/files/rename" @{ id = $fid; name = 'f2.bin' } $token
    Check ((($rn.Content | ConvertFrom-Json).file.name) -eq 'f2.bin') '重命名 f.bin → f2.bin'
    $mv = Invoke-Api POST "$Base/files/move" @{ id = $fid; parent_id = $null } $token
    Check ((($mv.Content | ConvertFrom-Json).file.parent_id) -eq $null) '移动到根目录'

    Write-Host "== 6. 分享（提取码 / 有效期 / 次数限制 / 续传不计数）==" -ForegroundColor Cyan
    $sh = Invoke-Api POST "$Base/shares" @{ file_id = $fid; require_code = $true; extract_code = 'abc123'; expires_hours = 1; max_downloads = 2 } $token
    $shJson = $sh.Content | ConvertFrom-Json
    $shId = $shJson.share.id
    $tok = $shJson.share.token
    Check ($shJson.url -eq "/s/$tok") '创建分享返回 /s/{token}'

    $r1 = Invoke-Api POST "$Base/shares/resolve" @{ token = $tok }
    Check ($r1.StatusCode -eq 403) '缺提取码 resolve 403'
    $r2 = Invoke-Api POST "$Base/shares/resolve" @{ token = $tok; extract_code = 'wrong1' }
    Check ($r2.StatusCode -eq 403) '错误提取码 403'
    $rv = Invoke-Api POST "$Base/shares/resolve" @{ token = $tok; extract_code = 'abc123' }
    $rvJson = $rv.Content | ConvertFrom-Json
    Check ($rvJson.tree.Count -eq 1) 'resolve 单节点树'
    $node = $rvJson.tree[0].id

    $sd = Invoke-Api GET "$Base/shares/$tok/download?node=$node&download=1" $null
    [IO.File]::WriteAllBytes("$Tmp\s.bin", $sd.Content)
    Check (((Get-FileHash "$Tmp\s.bin" -Algorithm SHA256).Hash.ToLower()) -eq $sha) '分享下载内容正确（计数 1）'
    & curl.exe -s -o NUL "$Base/shares/$tok/download?node=$node" -H 'Range: bytes=1000-1999' | Out-Null
    $rv2 = ((Invoke-Api POST "$Base/shares/resolve" @{ token = $tok; extract_code = 'abc123' }).Content | ConvertFrom-Json)
    Check ($rv2.share.remaining_downloads -eq 1) 'Range 续传不重复计数（剩 1 次）'
    Invoke-Api GET "$Base/shares/$tok/download?node=$node" $null | Out-Null
    $r3 = Invoke-Api GET "$Base/shares/$tok/download?node=$node" $null
    Check ($r3.StatusCode -eq 403) '超过下载次数上限 403'

    $page = (Invoke-WebRequest -Uri "$ServerUrl/s/$tok" -UseBasicParsing).Content
    Check ($page -match '云栖盘') '浏览器分享页渲染'

    Write-Host "== 7. 删除与清理 ==" -ForegroundColor Cyan
    Invoke-Api DELETE "$Base/shares/$shId" $null $token | Out-Null
    $r4 = Invoke-Api POST "$Base/shares/resolve" @{ token = $tok; extract_code = 'abc123' }
    Check ($r4.StatusCode -eq 404) '删除分享后 resolve 404'
    Invoke-Api DELETE "$Base/files/$fid" $null $token | Out-Null
    Invoke-Api DELETE "$Base/files/$dirId?recursive=true" $null $token | Out-Null
    $ls2 = Invoke-Api GET "$Base/files?parent_id=null" $null $token
    Check (($ls2.Content | ConvertFrom-Json).items.Count -eq 0) '删除后根目录为空'
}
finally {
    Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host '════════════════════════════════════'
Write-Host (" 冒烟结果：通过 {0} 项，失败 {1} 项" -f $script:Pass, $script:Fail)
Write-Host '════════════════════════════════════'
if ($script:Fail -gt 0) { exit 1 } else { exit 0 }
