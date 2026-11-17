// sharepage.go —— 浏览器分享页 GET /s/{token}（非 /api 前缀，契约 5.3）。
// 服务端渲染 HTML（html/template，全部输出自动转义防 XSS），
// 少量原生 JS 同源调用 POST /api/v1/shares/resolve：
// 无提取码分享直接渲染文件树；有提取码先展示输入框，校验通过后渲染；
// 过期/超次/不存在显示对应中文提示。树节点一律用 DOM API + textContent 构建。
package api

import (
	"errors"
	"html/template"
	"log/slog"
	"net/http"
	"time"

	"wangpan/server/internal/store"
)

// sharePageData 分享页模板数据（全部经 html/template 自动转义）。
type sharePageData struct {
	Token       string
	FileName    string
	RequireCode bool
	Error       string // 分享不存在/已过期等初始错误提示
}

// sharePageHTML 分享页模板。
const sharePageHTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>云栖盘 · 文件分享{{if .FileName}} · {{.FileName}}{{end}}</title>
<style>
  body { font-family: system-ui, "PingFang SC", "Microsoft YaHei", sans-serif; margin: 0; background: #f3f5f9; color: #1f2933; }
  .wrap { max-width: 780px; margin: 48px auto; padding: 0 16px; }
  .card { background: #fff; border-radius: 14px; box-shadow: 0 2px 16px rgba(31,41,51,.06); padding: 28px; }
  h1 { font-size: 20px; margin: 0 0 6px; }
  .sub { color: #7b8794; font-size: 13px; margin-bottom: 18px; }
  #msg { font-size: 14px; min-height: 20px; }
  .err { color: #d93025; }
  .ok { color: #16a34a; }
  #codeBox { margin: 12px 0 20px; }
  #codeBox p { font-size: 14px; color: #52606d; margin: 0 0 8px; }
  input { font-size: 14px; padding: 8px 10px; border: 1px solid #cbd2d9; border-radius: 8px; width: 180px; }
  button { font-size: 14px; padding: 8px 18px; border: 0; border-radius: 8px; background: #2563eb; color: #fff; cursor: pointer; }
  button:hover { background: #1d4ed8; }
  ul { list-style: none; padding-left: 22px; margin: 6px 0; }
  li { padding: 3px 0; font-size: 14px; }
  a { color: #2563eb; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .dir { color: #374151; }
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <h1>云栖盘文件分享</h1>
    <div class="sub" id="subtitle">{{if .FileName}}「{{.FileName}}」{{else}}正在加载分享内容…{{end}}</div>
    <div id="msg" class="{{if .Error}}err{{end}}">{{.Error}}</div>
    <div id="codeBox" style="display:none">
      <p>该分享需要提取码</p>
      <input id="code" type="text" maxlength="8" placeholder="请输入提取码" autocomplete="off">
      <button onclick="tryResolve(document.getElementById('code').value)">提取文件</button>
    </div>
    <div id="tree"></div>
  </div>
</div>
<script>
"use strict";
// 以下逻辑只调用同源公开接口 /api/v1/shares/resolve，不涉及任何越权行为。
var TOKEN = "{{.Token}}";

function setMsg(text, isErr) {
  var el = document.getElementById("msg");
  el.textContent = text || "";
  el.className = isErr ? "err" : "ok";
}

function fmtSize(n) {
  if (n < 1024) { return n + " B"; }
  var units = ["KB", "MB", "GB", "TB"];
  var i = -1;
  do { n = n / 1024; i += 1; } while (n >= 1024 && i < units.length - 1);
  return n.toFixed(1) + " " + units[i];
}

// 用 DOM API + textContent 构建节点，动态内容一律不经过 innerHTML，防 XSS。
function buildTree(nodes) {
  var byParent = {};
  nodes.forEach(function (n) {
    var pid = n.parent_share_id || "__ROOT__";
    if (!byParent[pid]) { byParent[pid] = []; }
    byParent[pid].push(n);
  });
  function render(pid) {
    var kids = byParent[pid] || [];
    var ul = document.createElement("ul");
    kids.forEach(function (n) {
      var li = document.createElement("li");
      if (n.is_dir) {
        var span = document.createElement("span");
        span.className = "dir";
        span.textContent = "📁 " + n.name;
        li.appendChild(span);
        li.appendChild(render(n.id));
      } else {
        var a = document.createElement("a");
        a.href = "/api/v1/shares/" + encodeURIComponent(TOKEN) + "/download?node=" + encodeURIComponent(n.id) + "&download=1";
        a.textContent = "📄 " + n.name + "（" + fmtSize(n.size) + "）";
        li.appendChild(a);
      }
      ul.appendChild(li);
    });
    return ul;
  }
  return render("__ROOT__");
}

async function tryResolve(code) {
  setMsg("");
  var body = { token: TOKEN };
  if (code) { body.extract_code = code; }
  var res;
  try {
    res = await fetch("/api/v1/shares/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch (e) {
    setMsg("网络错误，请稍后重试", true);
    return;
  }
  var data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  if (res.status === 200 && data && data.share) {
    document.getElementById("codeBox").style.display = "none";
    document.getElementById("subtitle").textContent = "「" + data.share.file_name + "」" +
      (data.share.is_dir ? " · 文件夹" : " · " + fmtSize(data.share.size));
    var treeEl = document.getElementById("tree");
    treeEl.replaceChildren(buildTree(data.tree || []));
    return;
  }
  var codeName = data && data.error ? data.error.code : "";
  if (codeName === "SHARE_CODE_REQUIRED" || codeName === "SHARE_CODE_INVALID") {
    document.getElementById("codeBox").style.display = "block";
    setMsg(codeName === "SHARE_CODE_INVALID" ? "提取码错误，请重试" : "", true);
    return;
  }
  if (codeName === "SHARE_EXPIRED") { setMsg("该分享已过期", true); return; }
  if (codeName === "SHARE_LIMIT_REACHED") { setMsg("该分享下载次数已达上限", true); return; }
  if (codeName === "NOT_FOUND") { setMsg("分享不存在或已被删除", true); return; }
  setMsg((data && data.error && data.error.message) || "加载失败，请稍后重试", true);
}

window.addEventListener("DOMContentLoaded", function () {
  if (!document.getElementById("msg").textContent) {
    tryResolve("");
  }
});
</script>
</body>
</html>
`

var sharePageTemplate = template.Must(template.New("sharepage").Parse(sharePageHTML))

// handleSharePage GET /s/{token}：渲染浏览器分享页。
// 服务端仅预查分享元信息（文件名/是否需要提取码/是否过期），
// 文件树与下载链接由页面 JS 通过公开 resolve 接口动态加载。
func (a *api) handleSharePage(w http.ResponseWriter, r *http.Request) {
	token := r.PathValue("token")
	data := sharePageData{Token: token}
	if token == "" {
		data.Error = "分享链接无效"
	} else {
		share, err := a.deps.Store.GetShareByToken(r.Context(), token)
		if errors.Is(err, store.ErrNotFound) {
			data.Error = "分享不存在或已被删除"
		} else if err != nil {
			slog.Error("查询分享失败", "err", err, "token", token)
			data.Error = "服务器内部错误，请稍后重试"
		} else {
			data.FileName = share.FileName
			data.RequireCode = share.RequireCode
			if share.ExpiresAt != nil && share.ExpiresAt.Before(time.Now()) {
				data.Error = "该分享已过期"
			}
		}
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	if err := sharePageTemplate.Execute(w, data); err != nil {
		slog.Error("渲染分享页失败", "err", err, "token", token)
	}
}
