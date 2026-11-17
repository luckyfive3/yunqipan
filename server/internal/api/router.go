// router.go —— 路由装配：按契约逐条注册全部端点（Go 1.22 ServeMux 路径参数），
// 并按 请求ID(最外) → 访问日志 → CORS → panic recover(最内) 的顺序包裹中间件。
package api

import (
	"net/http"

	"wangpan/server/internal/cache"
	"wangpan/server/internal/object"
	"wangpan/server/internal/store"
	"wangpan/server/internal/token"
)

// Deps API 层依赖注入（Store/Object 为接口，支持 PG+S3 与 SQLite+磁盘双实现）。
type Deps struct {
	Store             store.Store
	Object            object.Object
	Cache             cache.Cache
	Tokens            *token.Manager
	DefaultQuotaBytes int64 // 新用户默认配额字节数（0 = 不限）
}

type api struct {
	deps Deps
}

// NewRouter 注册全部路由并返回包裹中间件的 http.Handler。
func NewRouter(deps Deps) http.Handler {
	a := &api{deps: deps}
	mux := http.NewServeMux()

	// 健康检查（契约 6）
	mux.HandleFunc("GET /healthz", a.handleHealth)

	// 根路径状态页与 favicon（浏览器直接访问根地址不再 404）
	mux.HandleFunc("GET /{$}", a.handleRoot)
	mux.HandleFunc("GET /favicon.ico", a.handleFavicon)

	// 认证（契约 2）
	mux.HandleFunc("POST /api/v1/auth/register", a.handleRegister)
	mux.HandleFunc("POST /api/v1/auth/login", a.handleLogin)
	mux.HandleFunc("GET /api/v1/auth/me", a.requireAuth(a.handleMe))

	// 文件（契约 3）
	mux.HandleFunc("GET /api/v1/files", a.requireAuth(a.handleListFiles))
	mux.HandleFunc("GET /api/v1/files/tree", a.requireAuth(a.handleFileTree))
	mux.HandleFunc("GET /api/v1/files/{id}", a.requireAuth(a.handleGetFile))
	mux.HandleFunc("POST /api/v1/files/mkdir", a.requireAuth(a.handleMkdir))
	mux.HandleFunc("POST /api/v1/files/rename", a.requireAuth(a.handleRename))
	mux.HandleFunc("POST /api/v1/files/move", a.requireAuth(a.handleMove))
	mux.HandleFunc("DELETE /api/v1/files/{id}", a.requireAuth(a.handleDeleteFile))
	mux.HandleFunc("GET /api/v1/files/{id}/download", a.requireAuth(a.handleDownload))
	// 预览：Bearer 或 preview-token 均可，handler 内自行认证（iframe 无法带自定义头）
	mux.HandleFunc("GET /api/v1/files/{id}/preview", a.handlePreview)
	mux.HandleFunc("POST /api/v1/files/{id}/preview-token", a.requireAuth(a.handlePreviewToken))

	// 分块上传（契约 4）
	// 注意：GET /files/upload/{upload_id} 与 GET /files/{id}/download、/files/{id}/preview
	// 在 Go 1.22 ServeMux 中存在结构性冲突（/files/upload/download 同时命中两模式），
	// 故上传状态接口放在 /uploads/{upload_id}（契约 4.3 已同步）。
	mux.HandleFunc("POST /api/v1/files/upload/init", a.requireAuth(a.handleUploadInit))
	mux.HandleFunc("PUT /api/v1/files/upload/{upload_id}/chunk/{index}", a.requireAuth(a.handleUploadChunk))
	mux.HandleFunc("GET /api/v1/uploads/{upload_id}", a.requireAuth(a.handleUploadStatus))
	mux.HandleFunc("POST /api/v1/files/upload/{upload_id}/complete", a.requireAuth(a.handleUploadComplete))
	mux.HandleFunc("DELETE /api/v1/files/upload/{upload_id}", a.requireAuth(a.handleUploadAbort))

	// 分享（契约 5）
	mux.HandleFunc("POST /api/v1/shares", a.requireAuth(a.handleCreateShare))
	mux.HandleFunc("GET /api/v1/shares", a.requireAuth(a.handleListShares))
	mux.HandleFunc("DELETE /api/v1/shares/{id}", a.requireAuth(a.handleDeleteShare))
	mux.HandleFunc("POST /api/v1/shares/resolve", a.handleResolveShare)
	mux.HandleFunc("GET /api/v1/shares/{token}/download", a.handleShareDownload)

	// 浏览器分享页（非 /api 前缀，契约 5.3）
	mux.HandleFunc("GET /s/{token}", a.handleSharePage)

	// 中间件链
	var h http.Handler = mux
	h = a.withRecover(h)
	h = a.withCORS(h)
	h = a.withAccessLog(h)
	h = a.withRequestID(h)
	return h
}
