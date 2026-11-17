// files.go —— 文件/目录接口 handler：列表、树、详情、mkdir、rename、move、删除、下载。
// 下载为流式转发 S3 GetObject（io.Copy，不做全量缓冲），
// 支持单段 HTTP Range 与 If-Range，200/206 的 Content-Length / Content-Range 按 S3 响应透传。
package api

import (
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"strconv"

	"wangpan/server/internal/object"
	"wangpan/server/internal/store"
)

// handleListFiles GET /files?parent_id=<uuid>：列出目录内容（目录在前、名称升序，契约 3.1）。
// 不传 parent_id 表示根目录（parent_id = NULL）。
func (a *api) handleListFiles(w http.ResponseWriter, r *http.Request) {
	userID := userIDFrom(r.Context())
	var parentID *string
	if q := r.URL.Query().Get("parent_id"); q != "" {
		if !validUUID(q) {
			writeError(w, http.StatusBadRequest, "INVALID_INPUT", "parent_id 不是合法 UUID")
			return
		}
		parentID = &q
	}
	items, err := a.deps.Store.ListChildren(r.Context(), userID, parentID)
	if err != nil {
		slog.Error("列出目录失败", "err", err, "user_id", userID)
		writeError(w, http.StatusInternalServerError, "INTERNAL", "服务器内部错误")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

// handleFileTree GET /files/tree：当前用户全部文件/目录扁平数组（同步场景用）。
// 节点数 > 20000 时 413 TOO_MANY_NODES（客户端应退化为逐目录拉取）。
func (a *api) handleFileTree(w http.ResponseWriter, r *http.Request) {
	userID := userIDFrom(r.Context())
	items, err := a.deps.Store.ListAll(r.Context(), userID)
	if errors.Is(err, store.ErrTooManyNodes) {
		writeError(w, http.StatusRequestEntityTooLarge, "TOO_MANY_NODES", "目录树节点过多（>20000），请逐目录拉取")
		return
	}
	if err != nil {
		slog.Error("查询文件树失败", "err", err, "user_id", userID)
		writeError(w, http.StatusInternalServerError, "INTERNAL", "服务器内部错误")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

// handleGetFile GET /files/{id}：文件详情；他人文件 403。
func (a *api) handleGetFile(w http.ResponseWriter, r *http.Request) {
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
	writeJSON(w, http.StatusOK, map[string]any{"file": f})
}

// handleMkdir POST /files/mkdir → 201 {file}；409 同名冲突。
func (a *api) handleMkdir(w http.ResponseWriter, r *http.Request) {
	userID := userIDFrom(r.Context())
	var req struct {
		ParentID *string `json:"parent_id"`
		Name     string  `json:"name"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if err := validateFileName(req.Name); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_INPUT", err.Error())
		return
	}
	if req.ParentID != nil && !validUUID(*req.ParentID) {
		writeError(w, http.StatusBadRequest, "INVALID_INPUT", "parent_id 不是合法 UUID")
		return
	}
	f, err := a.deps.Store.CreateDir(r.Context(), userID, req.ParentID, req.Name)
	switch {
	case errors.Is(err, store.ErrConflict):
		writeError(w, http.StatusConflict, "CONFLICT", "同名文件或目录已存在")
		return
	case errors.Is(err, store.ErrParentNotFound):
		writeError(w, http.StatusNotFound, "NOT_FOUND", "父目录不存在或不是目录")
		return
	case errors.Is(err, store.ErrDepthExceeded):
		writeError(w, http.StatusBadRequest, "INVALID_INPUT", "目录最大深度为 64 层")
		return
	case err != nil:
		slog.Error("创建目录失败", "err", err, "user_id", userID)
		writeError(w, http.StatusInternalServerError, "INTERNAL", "服务器内部错误")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"file": f})
}

// handleRename POST /files/rename → 200 {file}。
func (a *api) handleRename(w http.ResponseWriter, r *http.Request) {
	userID := userIDFrom(r.Context())
	var req struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if !validUUID(req.ID) {
		writeError(w, http.StatusBadRequest, "INVALID_INPUT", "id 不是合法 UUID")
		return
	}
	if err := validateFileName(req.Name); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_INPUT", err.Error())
		return
	}
	f, err := a.deps.Store.RenameFile(r.Context(), userID, req.ID, req.Name)
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, "FILE_NOT_FOUND", "文件不存在")
		return
	case errors.Is(err, store.ErrForbidden):
		writeError(w, http.StatusForbidden, "FORBIDDEN", "无权访问他人资源")
		return
	case errors.Is(err, store.ErrConflict):
		writeError(w, http.StatusConflict, "CONFLICT", "同名文件或目录已存在")
		return
	case err != nil:
		slog.Error("重命名失败", "err", err, "file_id", req.ID)
		writeError(w, http.StatusInternalServerError, "INTERNAL", "服务器内部错误")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"file": f})
}

// handleMove POST /files/move → 200 {file}。
// 服务端校验：目标目录存在且属于当前用户；防环；409 同名冲突（契约 3.4）。
func (a *api) handleMove(w http.ResponseWriter, r *http.Request) {
	userID := userIDFrom(r.Context())
	var req struct {
		ID       string  `json:"id"`
		ParentID *string `json:"parent_id"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if !validUUID(req.ID) {
		writeError(w, http.StatusBadRequest, "INVALID_INPUT", "id 不是合法 UUID")
		return
	}
	if req.ParentID != nil && !validUUID(*req.ParentID) {
		writeError(w, http.StatusBadRequest, "INVALID_INPUT", "parent_id 不是合法 UUID")
		return
	}
	f, err := a.deps.Store.MoveFile(r.Context(), userID, req.ID, req.ParentID)
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, "FILE_NOT_FOUND", "文件不存在")
		return
	case errors.Is(err, store.ErrForbidden):
		writeError(w, http.StatusForbidden, "FORBIDDEN", "无权访问他人资源")
		return
	case errors.Is(err, store.ErrParentNotFound):
		writeError(w, http.StatusNotFound, "NOT_FOUND", "目标目录不存在或不是目录")
		return
	case errors.Is(err, store.ErrCycle):
		writeError(w, http.StatusBadRequest, "INVALID_INPUT", "不能把目录移动到自己的子目录")
		return
	case errors.Is(err, store.ErrDepthExceeded):
		writeError(w, http.StatusBadRequest, "INVALID_INPUT", "目录最大深度为 64 层")
		return
	case errors.Is(err, store.ErrConflict):
		writeError(w, http.StatusConflict, "CONFLICT", "同名文件或目录已存在")
		return
	case err != nil:
		slog.Error("移动失败", "err", err, "file_id", req.ID)
		writeError(w, http.StatusInternalServerError, "INTERNAL", "服务器内部错误")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"file": f})
}

// handleDeleteFile DELETE /files/{id}?recursive=true → 200 {ok:true}。
// 文件直接删；目录必须带 recursive=true，否则 400（契约 3.5）。
// 服务端：递归 CTE 收集子孙 → 事务删行并扣配额 → RemoveObjects 批量删对象。
func (a *api) handleDeleteFile(w http.ResponseWriter, r *http.Request) {
	userID := userIDFrom(r.Context())
	id := r.PathValue("id")
	if !validUUID(id) {
		writeError(w, http.StatusNotFound, "FILE_NOT_FOUND", "文件不存在")
		return
	}
	recursive := r.URL.Query().Get("recursive") == "true"

	f, err := a.deps.Store.GetFileByID(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "FILE_NOT_FOUND", "文件不存在")
		return
	}
	if err != nil {
		slog.Error("查询待删文件失败", "err", err, "file_id", id)
		writeError(w, http.StatusInternalServerError, "INTERNAL", "服务器内部错误")
		return
	}
	if f.UserID != userID {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "无权访问他人资源")
		return
	}
	if f.IsDir && !recursive {
		writeError(w, http.StatusBadRequest, "INVALID_INPUT", "删除目录需要 recursive=true")
		return
	}

	freed, keys, err := a.deps.Store.DeleteFile(r.Context(), userID, id, recursive)
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, "FILE_NOT_FOUND", "文件不存在")
		return
	case errors.Is(err, store.ErrForbidden):
		writeError(w, http.StatusForbidden, "FORBIDDEN", "无权访问他人资源")
		return
	case errors.Is(err, store.ErrInvalidInput):
		writeError(w, http.StatusBadRequest, "INVALID_INPUT", "删除目录需要 recursive=true")
		return
	case err != nil:
		slog.Error("删除失败", "err", err, "file_id", id)
		writeError(w, http.StatusInternalServerError, "INTERNAL", "服务器内部错误")
		return
	}
	// 事务已提交后再删对象；失败不吞错（对象成为孤儿，日志记录 key 便于人工清理）
	if err := a.deps.Object.RemoveObjects(r.Context(), keys); err != nil {
		slog.Error("删除对象失败", "err", err, "keys", keys, "file_id", id)
		writeError(w, http.StatusInternalServerError, "INTERNAL", "服务器内部错误")
		return
	}
	slog.Info("删除完成", "file_id", id, "freed_bytes", freed, "objects", len(keys))
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handleDownload GET /files/{id}/download?download=1：
// 支持 HTTP Range（单段）与 If-Range；download=1 时 Content-Disposition 为 attachment。
func (a *api) handleDownload(w http.ResponseWriter, r *http.Request) {
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
	if f.IsDir {
		writeError(w, http.StatusBadRequest, "INVALID_INPUT", "目录不支持下载")
		return
	}
	if f.ObjectKey == nil {
		writeError(w, http.StatusNotFound, "FILE_NOT_FOUND", "文件对象不存在")
		return
	}
	a.serveFileStream(w, r, f, r.URL.Query().Get("download") == "1")
}

// serveFileStream 完成「Range 解析 → If-Range 校验 → S3 读取 → 响应头 → 流式 io.Copy」
// 全流程，供私有下载、预览与分享下载复用；错误响应已按契约写好。
// 调用方需保证 f.ObjectKey 非空且 f 不是目录。
func (a *api) serveFileStream(w http.ResponseWriter, r *http.Request, f store.File, attach bool) {
	start, end, hasRange, rerr := parseRangeHeader(r, f.Size)
	switch {
	case errors.Is(rerr, errRangeInvalid):
		writeError(w, http.StatusBadRequest, "INVALID_INPUT", "Range 头格式非法（仅支持单段 bytes=start-end）")
		return
	case errors.Is(rerr, errRangeUnsatisfiable):
		writeError(w, http.StatusRequestedRangeNotSatisfiable, "INVALID_INPUT", "Range 请求范围不满足")
		return
	}
	rng := ""
	if hasRange {
		rng = fmt.Sprintf("bytes=%d-%d", start, end)
	}
	// If-Range 与对外 ETag（优先 sha256）不一致时退化为 200 全量
	if ir := r.Header.Get("If-Range"); ir != "" && f.SHA256 != nil && !etagEqual(ir, *f.SHA256) {
		rng = ""
	}

	body, info, err := a.deps.Object.GetObject(r.Context(), *f.ObjectKey, rng)
	if errors.Is(err, object.ErrObjectNotFound) {
		writeError(w, http.StatusNotFound, "FILE_NOT_FOUND", "文件对象不存在")
		return
	}
	if err != nil {
		slog.Error("读取对象失败", "err", err, "key", *f.ObjectKey)
		writeError(w, http.StatusInternalServerError, "INTERNAL", "服务器内部错误")
		return
	}
	defer func() { _ = body.Close() }()

	serveObjectResponse(w, f.Name, f.Mime, f.SHA256, f.Size, info, rng != "", attach)
	// 单请求读块上限：流式 io.Copy，不做全量缓冲（契约 3.4）
	if _, err := io.Copy(w, body); err != nil {
		// 响应头已写出无法改状态码：仅记录（客户端中断属正常场景）
		slog.Warn("流式转发中断", "err", err, "file_id", f.ID, "key", *f.ObjectKey)
	}
}

// serveObjectResponse 按契约 3.4 设置下载响应头：
// Accept-Ranges / Content-Type / ETag（优先 sha256，否则对象 ETag）/
// Content-Disposition（RFC5987 filename*，非 ASCII 自动 UTF-8 百分号编码）；
// 200 与 206 的 Content-Length / Content-Range 按 S3 响应透传。
func serveObjectResponse(w http.ResponseWriter, name, mimeType string, sha256 *string, size int64, info *object.ObjectInfo, partial bool, attach bool) {
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("Content-Type", mimeType)
	if sha256 != nil && *sha256 != "" {
		w.Header().Set("ETag", quotedETag(*sha256))
	} else if info.ETag != nil {
		w.Header().Set("ETag", *info.ETag)
	}
	disposition := "inline"
	if attach {
		disposition = "attachment"
	}
	// mime.FormatMediaType 对非 ASCII 文件名自动生成 RFC5987 的 filename*=UTF-8''... 形式
	w.Header().Set("Content-Disposition", mime.FormatMediaType(disposition, map[string]string{"filename": name}))
	if partial {
		if info.ContentRange != nil {
			w.Header().Set("Content-Range", *info.ContentRange)
		}
		if info.ContentLength != nil {
			w.Header().Set("Content-Length", strconv.FormatInt(*info.ContentLength, 10))
		}
		w.WriteHeader(http.StatusPartialContent)
	} else {
		if info.ContentLength != nil {
			w.Header().Set("Content-Length", strconv.FormatInt(*info.ContentLength, 10))
		} else {
			w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
		}
		w.WriteHeader(http.StatusOK)
	}
}
