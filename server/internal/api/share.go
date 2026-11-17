// share.go —— 分享接口：创建/列表/删除（需 Bearer）与 resolve/下载（公开访问）。
// 契约 5.1/5.2：token 用 crypto/rand 生成 8 位 base62；提取码只存 bcrypt(cost 10) 哈希；
// resolve 按 存在 → 未过期 → 提取码 → 剩余次数 逐级校验；
// 目录分享 tree = WITH RECURSIVE 收集整棵子树转 ShareNode（根节点 parent_share_id=null）；
// 下载计数：Range 缺失或起始为 0 时原子 UPDATE ... WHERE downloads < max_downloads。
package api

import (
	"crypto/rand"
	"errors"
	"log/slog"
	"math/big"
	"net/http"
	"time"

	"golang.org/x/crypto/bcrypt"

	"wangpan/server/internal/store"
)

// shareTokenAlphabet 分享 token 字符集（8 位 base62，契约 5.1）。
const shareTokenAlphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"

// randomShareToken 用 crypto/rand 生成 n 位 base62 随机串。
func randomShareToken(n int) (string, error) {
	out := make([]byte, 0, n)
	for i := 0; i < n; i++ {
		v, err := rand.Int(rand.Reader, big.NewInt(int64(len(shareTokenAlphabet))))
		if err != nil {
			return "", err
		}
		out = append(out, shareTokenAlphabet[v.Int64()])
	}
	return string(out), nil
}

// handleCreateShare POST /shares → 201 {share, url}。
// require_code=true 时 extract_code 必填（4-8 位），服务端只存 bcrypt 哈希，绝不存明文；
// expires_hours / max_downloads 为 0 或缺省 = 永久 / 不限次。
func (a *api) handleCreateShare(w http.ResponseWriter, r *http.Request) {
	userID := userIDFrom(r.Context())
	var req struct {
		FileID       string `json:"file_id"`
		RequireCode  bool   `json:"require_code"`
		ExtractCode  string `json:"extract_code"`
		ExpiresHours int    `json:"expires_hours"`
		MaxDownloads int    `json:"max_downloads"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if !validUUID(req.FileID) {
		writeError(w, http.StatusBadRequest, "INVALID_INPUT", "file_id 不是合法 UUID")
		return
	}
	f, err := a.deps.Store.GetFileByID(r.Context(), req.FileID)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "文件不存在")
		return
	}
	if err != nil {
		slog.Error("查询待分享文件失败", "err", err, "file_id", req.FileID)
		writeError(w, http.StatusInternalServerError, "INTERNAL", "服务器内部错误")
		return
	}
	if f.UserID != userID {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "无权访问他人资源")
		return
	}

	// 提取码：只存 bcrypt(cost 10) 哈希
	var codeHash *string
	if req.RequireCode {
		if err := validateExtractCode(req.ExtractCode); err != nil {
			writeError(w, http.StatusBadRequest, "INVALID_INPUT", err.Error())
			return
		}
		h, err := bcrypt.GenerateFromPassword([]byte(req.ExtractCode), 10)
		if err != nil {
			slog.Error("生成提取码哈希失败", "err", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL", "服务器内部错误")
			return
		}
		s := string(h)
		codeHash = &s
	}

	// 有效期与下载次数：0/缺省 = 永久 / 不限次
	var expiresAt *time.Time
	if req.ExpiresHours > 0 {
		t := time.Now().Add(time.Duration(req.ExpiresHours) * time.Hour)
		expiresAt = &t
	}
	var maxDownloads *int
	if req.MaxDownloads > 0 {
		m := req.MaxDownloads
		maxDownloads = &m
	}

	// token 碰撞概率极小，冲突时重试 5 次兜底
	var share store.Share
	for i := 0; i < 5; i++ {
		tok, err := randomShareToken(8)
		if err != nil {
			slog.Error("生成分享 token 失败", "err", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL", "服务器内部错误")
			return
		}
		share, err = a.deps.Store.CreateShare(r.Context(), userID, req.FileID, tok, codeHash, expiresAt, maxDownloads)
		if errors.Is(err, store.ErrConflict) {
			continue // token 撞了，重试
		}
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "NOT_FOUND", "文件不存在")
			return
		}
		if err != nil {
			slog.Error("创建分享失败", "err", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL", "服务器内部错误")
			return
		}
		break
	}
	if share.ID == "" {
		slog.Error("创建分享失败：token 反复冲突")
		writeError(w, http.StatusInternalServerError, "INTERNAL", "服务器内部错误")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"share": share,
		"url":   "/s/" + share.Token,
	})
}

// handleListShares GET /shares → 200 {shares}（含 file_name，便于展示）。
func (a *api) handleListShares(w http.ResponseWriter, r *http.Request) {
	userID := userIDFrom(r.Context())
	shares, err := a.deps.Store.ListShares(r.Context(), userID)
	if err != nil {
		slog.Error("查询分享列表失败", "err", err, "user_id", userID)
		writeError(w, http.StatusInternalServerError, "INTERNAL", "服务器内部错误")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"shares": shares})
}

// handleDeleteShare DELETE /shares/{id} → 200 {ok:true}；只能删除自己的分享。
func (a *api) handleDeleteShare(w http.ResponseWriter, r *http.Request) {
	userID := userIDFrom(r.Context())
	id := r.PathValue("id")
	if !validUUID(id) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "分享不存在")
		return
	}
	ok, err := a.deps.Store.DeleteShare(r.Context(), userID, id)
	if err != nil {
		slog.Error("删除分享失败", "err", err, "share_id", id)
		writeError(w, http.StatusInternalServerError, "INTERNAL", "服务器内部错误")
		return
	}
	if !ok {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "分享不存在")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// resolvedShare resolve 响应中的 share 字段（契约 5.2）。
type resolvedShare struct {
	Token              string     `json:"token"`
	FileName           string     `json:"file_name"`
	IsDir              bool       `json:"is_dir"`
	Size               int64      `json:"size"`
	ExpiresAt          *time.Time `json:"expires_at"`          // null = 永久
	RemainingDownloads *int       `json:"remaining_downloads"` // null = 不限
}

// shareNode 分享树节点（契约 1.5 ShareNode）。
type shareNode struct {
	ID            string  `json:"id"`
	ParentShareID *string `json:"parent_share_id"`
	Name          string  `json:"name"`
	IsDir         bool    `json:"is_dir"`
	Size          int64   `json:"size"`
	Mime          string  `json:"mime"`
	Encrypted     bool    `json:"encrypted"`
}

// handleResolveShare POST /shares/resolve（公开，免 Bearer）。
// 依次校验：分享存在 → 未过期 → require_code 时提取码必填且 bcrypt 比对 → 剩余下载次数 > 0。
// 成功返回分享信息 + 整棵子树扁平数组（单文件分享 = 含 1 个节点的数组）。
func (a *api) handleResolveShare(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Token       string `json:"token"`
		ExtractCode string `json:"extract_code"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.Token == "" {
		writeError(w, http.StatusBadRequest, "INVALID_INPUT", "token 不能为空")
		return
	}
	share, err := a.deps.Store.GetShareByToken(r.Context(), req.Token)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "分享不存在")
		return
	}
	if err != nil {
		slog.Error("查询分享失败", "err", err, "token", req.Token)
		writeError(w, http.StatusInternalServerError, "INTERNAL", "服务器内部错误")
		return
	}
	// 逐级校验（契约 5.2 顺序）
	if share.ExpiresAt != nil && time.Now().After(*share.ExpiresAt) {
		writeError(w, http.StatusGone, "SHARE_EXPIRED", "分享已过期")
		return
	}
	if share.RequireCode {
		if req.ExtractCode == "" {
			writeError(w, http.StatusForbidden, "SHARE_CODE_REQUIRED", "需要提取码")
			return
		}
		if err := bcrypt.CompareHashAndPassword([]byte(*share.ExtractCodeHash), []byte(req.ExtractCode)); err != nil {
			writeError(w, http.StatusForbidden, "SHARE_CODE_INVALID", "提取码错误")
			return
		}
	}
	if share.MaxDownloads != nil && share.Downloads >= *share.MaxDownloads {
		writeError(w, http.StatusForbidden, "SHARE_LIMIT_REACHED", "下载次数已达上限")
		return
	}

	// 目录分享：WITH RECURSIVE 收集整棵子树转 ShareNode（根节点 parent_share_id=null）
	subtree, err := a.deps.Store.SubtreeFiles(r.Context(), share.FileID)
	if err != nil {
		slog.Error("收集分享子树失败", "err", err, "file_id", share.FileID)
		writeError(w, http.StatusInternalServerError, "INTERNAL", "服务器内部错误")
		return
	}
	nodes := make([]shareNode, 0, len(subtree))
	totalSize := int64(0)
	for _, f := range subtree {
		if !f.IsDir {
			totalSize += f.Size
		}
		var parentShareID *string
		if f.ID != share.FileID {
			// 子树内节点沿用真实 parent_id；根节点 parent_share_id=null
			parentShareID = f.ParentID
		}
		nodes = append(nodes, shareNode{
			ID:            f.ID,
			ParentShareID: parentShareID,
			Name:          f.Name,
			IsDir:         f.IsDir,
			Size:          f.Size,
			Mime:          f.Mime,
			Encrypted:     f.Encrypted,
		})
	}

	// share.size：目录分享返回子树总大小，单文件分享返回文件大小
	size := share.Size
	if share.IsDir {
		size = totalSize
	}
	var remaining *int
	if share.MaxDownloads != nil {
		r := *share.MaxDownloads - share.Downloads
		remaining = &r
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"share": resolvedShare{
			Token:              share.Token,
			FileName:           share.FileName,
			IsDir:              share.IsDir,
			Size:               size,
			ExpiresAt:          share.ExpiresAt,
			RemainingDownloads: remaining,
		},
		"tree": nodes,
	})
}

// handleShareDownload GET /shares/{token}/download?node=<id>&download=1（公开）。
// 与 /files/{id}/download 行为一致（Range/206/ETag/Content-Disposition）。
// 下载计数：Range 头缺失或起始为 0（新一轮下载）时事务内原子自增，
// 影响行数为 0 → 403 SHARE_LIMIT_REACHED；Range 续传（start>0）不重复计数。
// node 必须在该分享的子树内，否则 404。
func (a *api) handleShareDownload(w http.ResponseWriter, r *http.Request) {
	token := r.PathValue("token")
	nodeID := r.URL.Query().Get("node")
	if nodeID == "" || !validUUID(nodeID) {
		writeError(w, http.StatusBadRequest, "INVALID_INPUT", "node 参数缺失或不是合法 UUID")
		return
	}
	share, err := a.deps.Store.GetShareByToken(r.Context(), token)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "分享不存在")
		return
	}
	if err != nil {
		slog.Error("查询分享失败", "err", err, "token", token)
		writeError(w, http.StatusInternalServerError, "INTERNAL", "服务器内部错误")
		return
	}
	if share.ExpiresAt != nil && time.Now().After(*share.ExpiresAt) {
		writeError(w, http.StatusGone, "SHARE_EXPIRED", "分享已过期")
		return
	}

	// 节点必须在分享子树内（契约 5.2）
	subtree, err := a.deps.Store.SubtreeFiles(r.Context(), share.FileID)
	if err != nil {
		slog.Error("收集分享子树失败", "err", err, "file_id", share.FileID)
		writeError(w, http.StatusInternalServerError, "INTERNAL", "服务器内部错误")
		return
	}
	var node *store.File
	for i := range subtree {
		if subtree[i].ID == nodeID {
			node = &subtree[i]
			break
		}
	}
	if node == nil || node.IsDir || node.ObjectKey == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "节点不存在或不可下载")
		return
	}

	// 下载计数（契约 5.2）：Range 缺失或有效起始为 0 → 新一轮下载，原子自增
	start, _, hasRange, rerr := parseRangeHeader(r, node.Size)
	switch {
	case errors.Is(rerr, errRangeInvalid):
		writeError(w, http.StatusBadRequest, "INVALID_INPUT", "Range 头格式非法（仅支持单段 bytes=start-end）")
		return
	case errors.Is(rerr, errRangeUnsatisfiable):
		writeError(w, http.StatusRequestedRangeNotSatisfiable, "INVALID_INPUT", "Range 请求范围不满足")
		return
	}
	if !hasRange || start == 0 {
		ok, err := a.deps.Store.IncrementDownload(r.Context(), share.ID)
		if err != nil {
			slog.Error("更新下载次数失败", "err", err, "share_id", share.ID)
			writeError(w, http.StatusInternalServerError, "INTERNAL", "服务器内部错误")
			return
		}
		if !ok {
			writeError(w, http.StatusForbidden, "SHARE_LIMIT_REACHED", "下载次数已达上限")
			return
		}
	}

	a.serveFileStream(w, r, *node, r.URL.Query().Get("download") == "1")
}
