// respond.go —— 统一的 JSON 响应与契约错误格式（1.2）输出：
// 所有非 2xx 响应体统一为 {"error":{"code","message"}}。
package api

import (
	"encoding/json"
	"log/slog"
	"net/http"
)

// errorBody 契约 1.2 的错误结构。
type errorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type errorResponse struct {
	Error errorBody `json:"error"`
}

// writeJSON 输出 JSON 响应。
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		slog.Error("序列化响应失败", "err", err)
	}
}

// writeError 按契约错误格式输出非 2xx 响应。
func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, errorResponse{Error: errorBody{Code: code, Message: message}})
}

// decodeJSON 解析 JSON 请求体（限 1MiB），失败时写 400 INVALID_INPUT 并返回 false。
func decodeJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(dst); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_INPUT", "请求体不是合法 JSON")
		return false
	}
	return true
}
