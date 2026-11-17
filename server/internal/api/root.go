// root.go —— 根路径服务状态页与 favicon 处理。
// 说明：本服务是桌面客户端的 API 服务端，没有网页版界面；
// 但用户常会用浏览器直接访问根地址，默认 404 会令人困惑，故返回一个状态页。
package api

import (
	"fmt"
	"net/http"
)

// handleRoot GET /：友好的服务状态页（提示使用桌面客户端）。
func (a *api) handleRoot(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprint(w, `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>云栖盘 · 服务端状态</title>
<style>
  body { font-family: system-ui, "PingFang SC", "Microsoft YaHei", sans-serif;
         margin: 0; background: #f3f5f9; color: #1f2933; }
  .wrap { max-width: 640px; margin: 64px auto; padding: 0 16px; }
  .card { background: #fff; border-radius: 14px; box-shadow: 0 2px 16px rgba(31,41,51,.06); padding: 28px; }
  h1 { font-size: 22px; margin: 0 0 8px; }
  .ok { color: #16a34a; font-weight: 600; }
  p { font-size: 14px; line-height: 1.8; color: #52606d; }
  a { color: #2563eb; text-decoration: none; }
  a:hover { text-decoration: underline; }
  code { background: #eef2f7; padding: 2px 6px; border-radius: 6px; font-size: 13px; }
</style>
</head>
<body>
<div class="wrap"><div class="card">
  <h1>☁ 云栖盘服务端 <span class="ok">● 运行中</span></h1>
  <p>这是「云栖盘」桌面客户端的 API 服务端，<b>没有网页版界面</b>，请使用桌面客户端访问：</p>
  <p>1. 双击项目根目录的 <code>start.bat</code>（或直接运行便携版 <code>yunqipan-*-portable.exe</code>）；<br>
     2. 客户端登录页的「服务地址」填写：<code>http://127.0.0.1:8080</code>；<br>
     3. 注册账号后即可使用全部功能（上传/下载/分享/同步）。</p>
  <p>接口状态：<a href="/healthz">/healthz 健康检查</a> ｜
     API 前缀 <code>/api/v1/</code> ｜ 分享链接形如 <code>/s/&lt;token&gt;</code></p>
  <p>遇到「404 page not found」是正常的——这只说明该路径没有页面（例如根路径或错误端口），不代表服务异常。</p>
</div></div>
</body>
</html>
`)
}

// handleFavicon GET /favicon.ico：浏览器会自动请求，返回 204 避免日志噪音。
func (a *api) handleFavicon(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusNoContent)
}
