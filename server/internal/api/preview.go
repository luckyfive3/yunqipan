// preview.go —— 预览接口：
// GET /files/{id}/preview（Bearer 或 preview-token 免认证，契约 3.6）
// 与 POST /files/{id}/preview-token（签发 HMAC 短签名，契约 3.7）。
package api

import (
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"wangpan/server/internal/store"
)

// previewAuth 预览接口的两种认证方式：
// 1) 常规 Bearer JWT；2) 查询参数携带合法 preview-token（iframe 无法带自定义头）。
func (a *api) previewAuth(r *http.Request) (userID string, ok bool) {
	if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
		if uid, err := a.deps.Tokens.VerifyJWT(strings.TrimPrefix(h, "Bearer ")); err == nil {
			return uid, true
		}
	}
	expStr := r.URL.Query().Get("exp")
	sig := r.URL.Query().Get("token")
	if expStr != "" && sig != "" {
		exp, err := strconv.ParseInt(expStr, 10, 64)
		if err == nil && a.deps.Tokens.VerifyPreviewToken(r.PathValue("id"), sig, exp) {
			return "", true
		}
	}
	return "", false
}

// handlePreview GET /files/{id}/preview：
// 同 download（inline、支持 Range），但仅允许预览白名单 mime（契约 3.6），
// 加密文件（encrypted=true）一律 415。preview-token 只能用于 preview，不能用于 download。
func (a *api) handlePreview(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !validUUID(id) {
		writeError(w, http.StatusNotFound, "FILE_NOT_FOUND", "文件不存在")
		return
	}
	userID, ok := a.previewAuth(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "未登录或登录已过期")
		return
	}
	f, err := a.deps.Store.GetFileByID(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "FILE_NOT_FOUND", "文件不存在")
		return
	}
	if err != nil {
		slog.Error("查询文件失败", "err", err, "file_id", id)
		writeError(w, http.StatusInternalServerError, "INTERNAL", "服务器内部错误")
		return
	}
	// Bearer 场景校验归属；preview-token 场景无用户上下文，签名本身即授权
	if userID != "" && f.UserID != userID {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "无权访问他人资源")
		return
	}
	// 契约 3.6：加密文件一律 415
	if f.Encrypted {
		writeError(w, http.StatusUnsupportedMediaType, "NOT_SUPPORTED", "加密文件不可预览")
		return
	}
	if !previewMimeAllowed(f.Mime) {
		writeError(w, http.StatusUnsupportedMediaType, "NOT_SUPPORTED", "该文件类型不支持预览")
		return
	}
	if f.IsDir {
		writeError(w, http.StatusUnsupportedMediaType, "NOT_SUPPORTED", "目录不支持预览")
		return
	}
	if f.ObjectKey == nil {
		writeError(w, http.StatusNotFound, "FILE_NOT_FOUND", "文件对象不存在")
		return
	}
	// 始终 inline 预览（download=1 对 preview 无效），支持 Range
	a.serveFileStream(w, r, f, false)
}

// handlePreviewToken POST /files/{id}/preview-token → 200 {url, expires_at}。
// token = base64url( HMAC-SHA256(PREVIEW_TOKEN_SECRET, "{id}|{exp}") )；
// ttl_seconds 默认 300，上限 3600（契约 3.7）。
func (a *api) handlePreviewToken(w http.ResponseWriter, r *http.Request) {
	userID := userIDFrom(r.Context())
	id := r.PathValue("id")
	if !validUUID(id) {
		writeError(w, http.StatusNotFound, "FILE_NOT_FOUND", "文件不存在")
		return
	}
	f, err := a.deps.Store.GetFileByID(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "FILE_NOT_FOUND", "文件不存在")
		return
	}
	if err != nil {
		slog.Error("查询文件失败", "err", err, "file_id", id)
		writeError(w, http.StatusInternalServerError, "INTERNAL", "服务器内部错误")
		return
	}
	if f.UserID != userID {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "无权访问他人资源")
		return
	}
	var req struct {
		TTLSeconds int `json:"ttl_seconds"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	ttl := req.TTLSeconds
	if ttl == 0 {
		ttl = 300
	}
	if ttl < 1 || ttl > 3600 {
		writeError(w, http.StatusBadRequest, "INVALID_INPUT", "ttl_seconds 需在 1~3600 之间")
		return
	}
	exp := time.Now().Add(time.Duration(ttl) * time.Second)
	expUnix := exp.Unix()
	sig := a.deps.Tokens.PreviewToken(id, expUnix)
	url := fmt.Sprintf("/api/v1/files/%s/preview?token=%s&exp=%d", id, sig, expUnix)
	writeJSON(w, http.StatusOK, map[string]any{
		"url":        url,
		"expires_at": exp.UTC().Format(time.RFC3339),
	})
}
