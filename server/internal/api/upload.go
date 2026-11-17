// upload.go —— 分块上传接口：init / chunk / status / complete / abort（契约 4）。
// 服务端把客户端分块映射为 S3 Multipart（PartNumber = index + 1），断点续传状态天然
// 保存在对象存储中；received 一律由 ListParts 得出（可靠真相源）。
// 会话元数据存 Redis（key: upload:{upload_id}，TTL 24h，JSON）；
// 按任务约定的简化策略：Redis 不可用时上传会话无法恢复（GET status 返回 UPLOAD_NOT_FOUND），
// 这是已知的优雅降级边界，见 README「已知取舍」。
package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"

	"wangpan/server/internal/cache"
	"wangpan/server/internal/store"
)

// 契约 4 相关常量。
const (
	uploadSessionTTL = 24 * time.Hour
	uploadSessionKey = "upload:"
	defaultChunkSize = 8 << 20 // 8 MiB（S3 要求除最后一块外每块 ≥5MiB，8MiB 默认值安全）
)

// uploadSession 分块上传会话元数据（Redis JSON 存储）。
type uploadSession struct {
	UploadID  string  `json:"upload_id"`
	FileID    string  `json:"file_id"`
	UserID    string  `json:"user_id"`
	ParentID  *string `json:"parent_id"`
	Name      string  `json:"name"`
	Size      int64   `json:"size"`
	Mime      string  `json:"mime"`
	SHA256    *string `json:"sha256"`
	Encrypted bool    `json:"encrypted"`
	ChunkSize int64   `json:"chunk_size"`
}

// saveUploadSession 序列化会话并写入 Redis（覆盖式写入同时刷新 TTL）。
func (a *api) saveUploadSession(ctx context.Context, s uploadSession) error {
	data, err := json.Marshal(s)
	if err != nil {
		return fmt.Errorf("序列化上传会话失败: %w", err)
	}
	if err := a.deps.Cache.Set(ctx, uploadSessionKey+s.UploadID, string(data), uploadSessionTTL); err != nil {
		return fmt.Errorf("保存上传会话失败: %w", err)
	}
	return nil
}

// loadUploadSession 从 Redis 读取会话；未命中返回 cache.ErrMiss。
func (a *api) loadUploadSession(ctx context.Context, uploadID string) (uploadSession, error) {
	v, err := a.deps.Cache.Get(ctx, uploadSessionKey+uploadID)
	if err != nil {
		return uploadSession{}, err
	}
	var s uploadSession
	if err := json.Unmarshal([]byte(v), &s); err != nil {
		return uploadSession{}, fmt.Errorf("解析上传会话失败: %w", err)
	}
	return s, nil
}

// handleUploadInit POST /files/upload/init → 201 {upload_id, chunk_size, received}。
// 服务端：校验参数与配额（预检）→ CreateMultipartUpload → 会话写 Redis。
func (a *api) handleUploadInit(w http.ResponseWriter, r *http.Request) {
	userID := userIDFrom(r.Context())
	var req struct {
		ParentID  *string `json:"parent_id"`
		Name      string  `json:"name"`
		Size      int64   `json:"size"`
		Mime      string  `json:"mime"`
		SHA256    *string `json:"sha256"`
		Encrypted bool    `json:"encrypted"`
		ChunkSize int64   `json:"chunk_size"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if err := validateFileName(req.Name); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_INPUT", err.Error())
		return
	}
	if req.Size < 0 {
		writeError(w, http.StatusBadRequest, "INVALID_INPUT", "size 不能为负数")
		return
	}
	mimeType := req.Mime
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}
	chunkSize := req.ChunkSize
	if chunkSize == 0 {
		chunkSize = defaultChunkSize
	}
	// 契约 1.4：分块大小允许范围 1 MiB ~ 64 MiB
	if chunkSize < minChunkSize || chunkSize > maxChunkSize {
		writeError(w, http.StatusBadRequest, "INVALID_INPUT", "chunk_size 需在 1MiB~64MiB 之间")
		return
	}
	if req.ParentID != nil && !validUUID(*req.ParentID) {
		writeError(w, http.StatusBadRequest, "INVALID_INPUT", "parent_id 不是合法 UUID")
		return
	}
	if req.ParentID != nil {
		parent, err := a.deps.Store.GetFileByID(r.Context(), *req.ParentID)
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "NOT_FOUND", "父目录不存在")
			return
		}
		if err != nil {
			slog.Error("查询父目录失败", "err", err, "parent_id", *req.ParentID)
			writeError(w, http.StatusInternalServerError, "INTERNAL", "服务器内部错误")
			return
		}
		if parent.UserID != userID {
			writeError(w, http.StatusForbidden, "FORBIDDEN", "无权访问他人资源")
			return
		}
		if !parent.IsDir {
			writeError(w, http.StatusBadRequest, "INVALID_INPUT", "parent_id 不是目录")
			return
		}
	}

	// 配额预检（契约 4：quota_total>0 时 quota_used+size 不得超过，否则 413）
	u, err := a.deps.Store.GetUserByID(r.Context(), userID)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "用户不存在")
		return
	}
	if err != nil {
		slog.Error("查询用户失败", "err", err, "user_id", userID)
		writeError(w, http.StatusInternalServerError, "INTERNAL", "服务器内部错误")
		return
	}
	if u.QuotaTotal > 0 && u.QuotaUsed+req.Size > u.QuotaTotal {
		writeError(w, http.StatusRequestEntityTooLarge, "QUOTA_EXCEEDED", "存储配额不足")
		return
	}

	// 文件 ID 在 init 时生成，complete 时写入 files 行；object_key = objects/{fileID}/{name}
	fileID := uuid.NewString()
	key := objectKey(fileID, req.Name)
	uploadID, err := a.deps.Object.CreateMultipart(r.Context(), key, mimeType)
	if err != nil {
		slog.Error("初始化分块上传失败", "err", err, "key", key)
		writeError(w, http.StatusInternalServerError, "INTERNAL", "服务器内部错误")
		return
	}
	sess := uploadSession{
		UploadID:  uploadID,
		FileID:    fileID,
		UserID:    userID,
		ParentID:  req.ParentID,
		Name:      req.Name,
		Size:      req.Size,
		Mime:      mimeType,
		SHA256:    req.SHA256,
		Encrypted: req.Encrypted,
		ChunkSize: chunkSize,
	}
	if err := a.saveUploadSession(r.Context(), sess); err != nil {
		slog.Error("保存上传会话失败", "err", err, "upload_id", uploadID)
		_ = a.deps.Object.AbortMultipart(r.Context(), key, uploadID) // 清理孤儿会话
		writeError(w, http.StatusInternalServerError, "INTERNAL", "服务器内部错误")
		return
	}
	slog.Info("分块上传初始化", "upload_id", uploadID, "file_id", fileID, "name", req.Name, "size", req.Size, "chunk_size", chunkSize)
	writeJSON(w, http.StatusCreated, map[string]any{
		"upload_id":  uploadID,
		"chunk_size": chunkSize,
		"received":   make([]int, 0), // 新会话无已传分块
	})
}

// handleUploadChunk PUT /files/upload/{upload_id}/chunk/{index} → 200 {ok, received}。
// index 从 0 开始；请求体为该块原始字节（最后一块可以小于 chunk_size）；
// 单块 ≤ chunk_size，超出 413 CHUNK_TOO_LARGE；UploadPart(partNumber=index+1)，幂等覆盖。
func (a *api) handleUploadChunk(w http.ResponseWriter, r *http.Request) {
	userID := userIDFrom(r.Context())
	uploadID := r.PathValue("upload_id")
	index, err := strconv.Atoi(r.PathValue("index"))
	if err != nil || index < 0 {
		writeError(w, http.StatusBadRequest, "INVALID_INPUT", "分块编号非法（index 从 0 开始）")
		return
	}
	sess, err := a.loadUploadSession(r.Context(), uploadID)
	if errors.Is(err, cache.ErrMiss) {
		writeError(w, http.StatusNotFound, "UPLOAD_NOT_FOUND", "分块上传会话不存在或已过期")
		return
	}
	if err != nil {
		slog.Error("读取上传会话失败", "err", err, "upload_id", uploadID)
		writeError(w, http.StatusInternalServerError, "INTERNAL", "服务器内部错误")
		return
	}
	if sess.UserID != userID {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "无权访问他人资源")
		return
	}
	// 分块编号范围校验：index < ceil(size / chunk_size)
	if sess.Size > 0 {
		maxIndex := (sess.Size + sess.ChunkSize - 1) / sess.ChunkSize
		if int64(index) >= maxIndex {
			writeError(w, http.StatusBadRequest, "INVALID_INPUT", "分块编号超出范围")
			return
		}
	}

	// 读取整块；多读 1 字节用于探测 CHUNK_TOO_LARGE（单块上限即 chunk_size）
	data, err := io.ReadAll(io.LimitReader(r.Body, sess.ChunkSize+1))
	if err != nil {
		slog.Warn("读取分块失败", "err", err, "upload_id", uploadID, "index", index)
		writeError(w, http.StatusBadRequest, "INVALID_INPUT", "读取分块数据失败")
		return
	}
	if int64(len(data)) > sess.ChunkSize {
		writeError(w, http.StatusRequestEntityTooLarge, "CHUNK_TOO_LARGE", "分块超过 chunk_size 限制")
		return
	}

	key := objectKey(sess.FileID, sess.Name)
	// 幂等：重复 PUT 同块直接覆盖（契约 4）
	if _, err := a.deps.Object.UploadPart(r.Context(), key, uploadID, int32(index+1), data); err != nil {
		slog.Error("上传分块失败", "err", err, "upload_id", uploadID, "index", index)
		writeError(w, http.StatusInternalServerError, "INTERNAL", "服务器内部错误")
		return
	}
	// received 一律来自 ListParts（断点续传的可靠真相源）
	parts, err := a.deps.Object.ListParts(r.Context(), key, uploadID)
	if err != nil {
		slog.Error("列举分块失败", "err", err, "upload_id", uploadID)
		writeError(w, http.StatusInternalServerError, "INTERNAL", "服务器内部错误")
		return
	}
	received := make([]int, 0, len(parts))
	for _, p := range parts {
		received = append(received, int(p.Number)-1)
	}
	// 刷新会话 TTL（失败不致命，仅记录）
	if err := a.saveUploadSession(r.Context(), sess); err != nil {
		slog.Warn("刷新上传会话 TTL 失败", "err", err, "upload_id", uploadID)
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "received": received})
}

// handleUploadStatus GET /files/upload/{upload_id} → 200：恢复上传现场。
func (a *api) handleUploadStatus(w http.ResponseWriter, r *http.Request) {
	userID := userIDFrom(r.Context())
	uploadID := r.PathValue("upload_id")
	sess, err := a.loadUploadSession(r.Context(), uploadID)
	if errors.Is(err, cache.ErrMiss) {
		writeError(w, http.StatusNotFound, "UPLOAD_NOT_FOUND", "分块上传会话不存在或已过期")
		return
	}
	if err != nil {
		slog.Error("读取上传会话失败", "err", err, "upload_id", uploadID)
		writeError(w, http.StatusInternalServerError, "INTERNAL", "服务器内部错误")
		return
	}
	if sess.UserID != userID {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "无权访问他人资源")
		return
	}
	key := objectKey(sess.FileID, sess.Name)
	parts, err := a.deps.Object.ListParts(r.Context(), key, uploadID)
	if err != nil {
		slog.Error("列举分块失败", "err", err, "upload_id", uploadID)
		writeError(w, http.StatusInternalServerError, "INTERNAL", "服务器内部错误")
		return
	}
	received := make([]int, 0, len(parts))
	for _, p := range parts {
		received = append(received, int(p.Number)-1)
	}
	if err := a.saveUploadSession(r.Context(), sess); err != nil {
		slog.Warn("刷新上传会话 TTL 失败", "err", err, "upload_id", uploadID)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"upload_id":  sess.UploadID,
		"chunk_size": sess.ChunkSize,
		"received":   received,
		"name":       sess.Name,
		"size":       sess.Size,
		"parent_id":  sess.ParentID,
		"encrypted":  sess.Encrypted,
	})
}

// handleUploadComplete POST /files/upload/{upload_id}/complete → 200 {file}。
// 服务端：ListParts 取全部 ETag → CompleteMultipartUpload → 校验拼接后大小==size
// → 事务（查重 → INSERT files → 配额终检）；配额不足 413（并中止上传）。
func (a *api) handleUploadComplete(w http.ResponseWriter, r *http.Request) {
	userID := userIDFrom(r.Context())
	uploadID := r.PathValue("upload_id")
	sess, err := a.loadUploadSession(r.Context(), uploadID)
	if errors.Is(err, cache.ErrMiss) {
		writeError(w, http.StatusNotFound, "UPLOAD_NOT_FOUND", "分块上传会话不存在或已过期")
		return
	}
	if err != nil {
		slog.Error("读取上传会话失败", "err", err, "upload_id", uploadID)
		writeError(w, http.StatusInternalServerError, "INTERNAL", "服务器内部错误")
		return
	}
	if sess.UserID != userID {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "无权访问他人资源")
		return
	}
	var req struct {
		SHA256 *string `json:"sha256"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	// complete 请求可携带最终 sha256，覆盖 init 时的值
	if req.SHA256 != nil {
		sess.SHA256 = req.SHA256
	}

	key := objectKey(sess.FileID, sess.Name)
	parts, err := a.deps.Object.ListParts(r.Context(), key, uploadID)
	if err != nil {
		slog.Error("列举分块失败", "err", err, "upload_id", uploadID)
		writeError(w, http.StatusInternalServerError, "INTERNAL", "服务器内部错误")
		return
	}
	// 完整性校验：应传分块数 = ceil(size / chunk_size)
	expected := int64(0)
	if sess.Size > 0 {
		expected = (sess.Size + sess.ChunkSize - 1) / sess.ChunkSize
	}
	if int64(len(parts)) < expected {
		writeError(w, http.StatusBadRequest, "INVALID_INPUT",
			fmt.Sprintf("分块尚未传完：已传 %d/%d", len(parts), expected))
		return
	}

	if _, err := a.deps.Object.CompleteMultipart(r.Context(), key, uploadID, parts); err != nil {
		slog.Error("合并分块失败", "err", err, "upload_id", uploadID)
		writeError(w, http.StatusInternalServerError, "INTERNAL", "服务器内部错误")
		return
	}
	// 拼接后大小校验（契约 4）
	actual, err := a.deps.Object.HeadObject(r.Context(), key)
	if err != nil {
		slog.Error("校验对象大小失败", "err", err, "key", key)
		writeError(w, http.StatusInternalServerError, "INTERNAL", "服务器内部错误")
		return
	}
	if actual != sess.Size {
		slog.Error("合并后对象大小与声明不符", "expected", sess.Size, "actual", actual, "key", key)
		writeError(w, http.StatusInternalServerError, "INTERNAL", "合并后对象大小校验失败")
		return
	}

	f, err := a.deps.Store.CreateFileComplete(r.Context(), userID, sess.FileID, sess.ParentID, sess.Name, sess.Size, sess.Mime, sess.SHA256, sess.Encrypted, key)
	switch {
	case errors.Is(err, store.ErrQuotaExceeded):
		// 契约：配额不足 → 413 并中止上传
		_ = a.deps.Object.AbortMultipart(r.Context(), key, uploadID)
		_ = a.deps.Cache.Del(r.Context(), uploadSessionKey+uploadID)
		writeError(w, http.StatusRequestEntityTooLarge, "QUOTA_EXCEEDED", "存储配额不足")
		return
	case errors.Is(err, store.ErrConflict):
		_ = a.deps.Object.AbortMultipart(r.Context(), key, uploadID)
		_ = a.deps.Cache.Del(r.Context(), uploadSessionKey+uploadID)
		writeError(w, http.StatusConflict, "CONFLICT", "同名文件或目录已存在")
		return
	case errors.Is(err, store.ErrParentNotFound):
		_ = a.deps.Object.AbortMultipart(r.Context(), key, uploadID)
		_ = a.deps.Cache.Del(r.Context(), uploadSessionKey+uploadID)
		writeError(w, http.StatusNotFound, "NOT_FOUND", "父目录不存在")
		return
	case err != nil:
		slog.Error("完成上传入库失败", "err", err, "upload_id", uploadID)
		writeError(w, http.StatusInternalServerError, "INTERNAL", "服务器内部错误")
		return
	}
	// 完成：清理上传会话（S3 已自动合并中间分块，无需额外对象清理）
	if err := a.deps.Cache.Del(r.Context(), uploadSessionKey+uploadID); err != nil {
		slog.Warn("清理上传会话失败", "err", err, "upload_id", uploadID)
	}
	slog.Info("分块上传完成", "upload_id", uploadID, "file_id", f.ID, "size", f.Size)
	writeJSON(w, http.StatusOK, map[string]any{"file": f})
}

// handleUploadAbort DELETE /files/upload/{upload_id} → 200 {ok:true}：AbortMultipartUpload。
func (a *api) handleUploadAbort(w http.ResponseWriter, r *http.Request) {
	userID := userIDFrom(r.Context())
	uploadID := r.PathValue("upload_id")
	sess, err := a.loadUploadSession(r.Context(), uploadID)
	if errors.Is(err, cache.ErrMiss) {
		writeError(w, http.StatusNotFound, "UPLOAD_NOT_FOUND", "分块上传会话不存在或已过期")
		return
	}
	if err != nil {
		slog.Error("读取上传会话失败", "err", err, "upload_id", uploadID)
		writeError(w, http.StatusInternalServerError, "INTERNAL", "服务器内部错误")
		return
	}
	if sess.UserID != userID {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "无权访问他人资源")
		return
	}
	key := objectKey(sess.FileID, sess.Name)
	if err := a.deps.Object.AbortMultipart(r.Context(), key, uploadID); err != nil {
		slog.Error("中止分块上传失败", "err", err, "upload_id", uploadID)
		writeError(w, http.StatusInternalServerError, "INTERNAL", "服务器内部错误")
		return
	}
	if err := a.deps.Cache.Del(r.Context(), uploadSessionKey+uploadID); err != nil {
		slog.Warn("清理上传会话失败", "err", err, "upload_id", uploadID)
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
