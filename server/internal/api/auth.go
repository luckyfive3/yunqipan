// auth.go —— 认证接口：注册、登录（Redis 可用时同 IP 5 次/分钟限流）、当前用户信息。
package api

import (
	"errors"
	"log/slog"
	"net/http"
	"regexp"

	"golang.org/x/crypto/bcrypt"

	"wangpan/server/internal/store"
)

// usernameRe 契约 2：用户名 3-32 位字母数字下划线。
var usernameRe = regexp.MustCompile(`^[A-Za-z0-9_]{3,32}$`)

// loginAttemptsPerMinute 登录限流：同 IP 每分钟 5 次（契约 2）。
const loginAttemptsPerMinute = 5

// handleRegister POST /auth/register → 201 {token, user}。
func (a *api) handleRegister(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if !usernameRe.MatchString(req.Username) {
		writeError(w, http.StatusBadRequest, "INVALID_INPUT", "用户名需为 3-32 位字母、数字或下划线")
		return
	}
	if len(req.Password) < 8 || len(req.Password) > 72 {
		writeError(w, http.StatusBadRequest, "INVALID_INPUT", "密码长度需为 8-72 位")
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		slog.Error("生成密码哈希失败", "err", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL", "服务器内部错误")
		return
	}
	// 新用户默认配额来自 DEFAULT_QUOTA_GB 配置（0 = 不限容量）
	u, err := a.deps.Store.CreateUser(r.Context(), req.Username, string(hash), a.deps.DefaultQuotaBytes)
	if errors.Is(err, store.ErrConflict) {
		writeError(w, http.StatusConflict, "CONFLICT", "用户名已存在")
		return
	}
	if err != nil {
		slog.Error("创建用户失败", "err", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL", "服务器内部错误")
		return
	}
	tokenStr, err := a.deps.Tokens.IssueJWT(u.ID)
	if err != nil {
		slog.Error("签发 JWT 失败", "err", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL", "服务器内部错误")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"token": tokenStr, "user": u})
}

// handleLogin POST /auth/login → 200 {token, user}；失败 401；超限 429 RATE_LIMITED。
func (a *api) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}

	// 登录限流：Redis 可用时同 IP 5 次/分钟；Redis 不可用时优雅降级（不限流）
	if a.deps.Cache.Enabled() {
		n, err := a.deps.Cache.LoginAttempt(r.Context(), clientIP(r))
		if err != nil {
			slog.Warn("登录限流计数失败，本次跳过限流", "err", err)
		} else if n > loginAttemptsPerMinute {
			writeError(w, http.StatusTooManyRequests, "RATE_LIMITED", "尝试过于频繁，请稍后再试")
			return
		}
	}

	u, err := a.deps.Store.GetUserByUsername(r.Context(), req.Username)
	if errors.Is(err, store.ErrNotFound) {
		// 不区分“用户不存在”与“密码错误”，避免账号枚举
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "用户名或密码错误")
		return
	}
	if err != nil {
		slog.Error("查询用户失败", "err", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL", "服务器内部错误")
		return
	}
	if bcrypt.CompareHashAndPassword([]byte(u.PasswordHash), []byte(req.Password)) != nil {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "用户名或密码错误")
		return
	}
	tokenStr, err := a.deps.Tokens.IssueJWT(u.ID)
	if err != nil {
		slog.Error("签发 JWT 失败", "err", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL", "服务器内部错误")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"token": tokenStr, "user": u})
}

// handleMe GET /auth/me → 200 {user}（含最新配额使用量）。
func (a *api) handleMe(w http.ResponseWriter, r *http.Request) {
	u, err := a.deps.Store.GetUserByID(r.Context(), userIDFrom(r.Context()))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "用户不存在")
		return
	}
	if err != nil {
		slog.Error("查询用户失败", "err", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL", "服务器内部错误")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"user": u})
}
