<#
  sign-dev.ps1 —— 用本机开发证书给 dist 产物签名（开发/自用场景，正式发布请购买正规代码签名证书）
  用法: .\scripts\sign-dev.ps1 [-NoTimestamp]
  说明: 1) 自动创建/复用 "CN=YunQiPan Dev" 代码签名证书（CurrentUser，3 年）；
        2) 把证书导入 CurrentUser 的 Root + TrustedPublisher（certutil 静默，无需管理员）；
        3) 对 dist 下 exe 做 SHA256 签名 + RFC3161 时间戳。
#>
[CmdletBinding()]
param([switch]$NoTimestamp)

$ErrorActionPreference = 'Stop'
$Dist = Join-Path (Split-Path -Parent $PSScriptRoot) 'client\dist'

$cert = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert -ErrorAction SilentlyContinue |
    Where-Object { $_.Subject -like '*YunQiPan Dev*' } | Select-Object -First 1
if (-not $cert) {
    Write-Host '创建代码签名证书 CN=YunQiPan Dev ...'
    $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=YunQiPan Dev, O=YunQiPan, C=CN' `
        -KeyUsage DigitalSignature -KeyAlgorithm RSA -KeyLength 3072 `
        -NotAfter (Get-Date).AddYears(3) -CertStoreLocation 'Cert:\CurrentUser\My'
}
Write-Host "证书指纹: $($cert.Thumbprint)"

$cer = Join-Path $env:TEMP 'yunqipan-dev.cer'
Export-Certificate -Cert $cert -FilePath $cer | Out-Null
certutil -user -addstore Root $cer 2>&1 | Select-Object -Last 1
certutil -user -addstore TrustedPublisher $cer 2>&1 | Select-Object -Last 1

$targets = Get-ChildItem -Recurse $Dist -Filter '*.exe' -ErrorAction SilentlyContinue
if (-not $targets) { Write-Error '未找到 dist 下的 exe，请先 npm run dist:win'; exit 1 }
foreach ($f in $targets) {
    $params = @{ FilePath = $f.FullName; Certificate = $cert; HashAlgorithm = 'SHA256' }
    if (-not $NoTimestamp) { $params.TimestampServer = 'http://timestamp.digicert.com' }
    $s = Set-AuthenticodeSignature @params
    Write-Host ("{0}: {1}" -f $f.Name, $s.Status)
}
Write-Host '完成。校验: Get-AuthenticodeSignature <exe> 应显示 Valid（本机已信任该证书）。'
