// health.go —— 健康检查 GET /healthz（契约 6）。
package api

import (
	"context"
	"log/slog"
	"net/http"
	"time"
)

// serverVersion 契约 6 中的版本号。
const serverVersion = "1.0.0"

// handleHealth GET /healthz：
// PG/Redis/MinIO 全部可用 → 200 {"ok":true,"version","time"}；
// 任一依赖不可用 → 503 {"ok":false,"deps":{...}}。
// Redis 未配置（降级模式）时视为可用（非依赖）。
func (a *api) handleHealth(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()

	postgresOK := a.deps.Store.Ping(ctx) == nil
	minioOK := a.deps.Object.Ping(ctx) == nil
	redisOK := true
	if a.deps.Cache.Enabled() {
		redisOK = a.deps.Cache.Ping(ctx) == nil
	}
	ok := postgresOK && minioOK && redisOK

	body := map[string]any{
		"ok":      ok,
		"version": serverVersion,
		"time":    time.Now().UTC().Format(time.RFC3339),
	}
	if !ok {
		slog.Warn("健康检查失败", "postgres", postgresOK, "redis", redisOK, "minio", minioOK)
		body["deps"] = map[string]bool{
			"postgres": postgresOK,
			"redis":    redisOK,
			"minio":    minioOK,
		}
		writeJSON(w, http.StatusServiceUnavailable, body)
		return
	}
	writeJSON(w, http.StatusOK, body)
}
