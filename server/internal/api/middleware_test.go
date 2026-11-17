// middleware_test.go —— 中间件与响应工具单元测试（httptest，不依赖 DB/MinIO）。
package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"wangpan/server/internal/token"
)

// newRangeRequest 构造带 Range 头的请求（helpers 测试用）。
func newRangeRequest(rangeHeader string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "http://example.test/f", nil)
	if rangeHeader != "" {
		r.Header.Set("Range", rangeHeader)
	}
	return r
}

func newTestAPI() *api {
	tm := token.NewManager("test-jwt-secret", "test-preview-secret")
	return &api{deps: Deps{Tokens: tm}}
}

func TestRequireAuth(t *testing.T) {
	a := newTestAPI()
	uid := "6ba7b810-9dad-11d1-80b4-00c04fd430c8"
	jwt, err := a.deps.Tokens.IssueJWT(uid)
	if err != nil {
		t.Fatalf("签发测试 JWT 失败: %v", err)
	}

	handler := a.requireAuth(func(w http.ResponseWriter, r *http.Request) {
		got := userIDFrom(r.Context())
		if got != uid {
			t.Errorf("上下文中 userID = %q, want %q", got, uid)
		}
		w.WriteHeader(http.StatusOK)
	})

	// 无 Authorization 头 → 401 UNAUTHORIZED
	rec := httptest.NewRecorder()
	handler(rec, httptest.NewRequest(http.MethodGet, "/api/v1/files", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("无 token 应 401，得到 %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "UNAUTHORIZED") {
		t.Fatalf("错误体应含 UNAUTHORIZED: %s", rec.Body.String())
	}

	// 非法 token → 401
	rec = httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/api/v1/files", nil)
	r.Header.Set("Authorization", "Bearer bad.token.here")
	handler(rec, r)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("非法 token 应 401，得到 %d", rec.Code)
	}

	// 合法 token → 200 且 user_id 注入上下文
	rec = httptest.NewRecorder()
	r = httptest.NewRequest(http.MethodGet, "/api/v1/files", nil)
	r.Header.Set("Authorization", "Bearer "+jwt)
	handler(rec, r)
	if rec.Code != http.StatusOK {
		t.Fatalf("合法 token 应 200，得到 %d", rec.Code)
	}
}

func TestWithRecoverPanicTo500(t *testing.T) {
	a := newTestAPI()
	h := a.withRecover(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		panic("测试 panic")
	}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/x", nil))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("panic 应转为 500，得到 %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "INTERNAL") {
		t.Fatalf("错误体应含 INTERNAL: %s", rec.Body.String())
	}
}

func TestWithRequestID(t *testing.T) {
	a := newTestAPI()
	var seen string
	h := a.withRequestID(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.Context().Value(ctxRequestID).(string)
		w.WriteHeader(http.StatusNoContent)
	}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/x", nil))
	if seen == "" {
		t.Fatal("请求应携带 request_id")
	}
	if rec.Header().Get("X-Request-ID") != seen {
		t.Fatal("X-Request-ID 响应头应与上下文一致")
	}
}

func TestWriteErrorFormat(t *testing.T) {
	rec := httptest.NewRecorder()
	writeError(rec, http.StatusNotFound, "FILE_NOT_FOUND", "文件不存在")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("状态码 = %d", rec.Code)
	}
	body := rec.Body.String()
	if !strings.Contains(body, `"code":"FILE_NOT_FOUND"`) || !strings.Contains(body, `"message":"文件不存在"`) {
		t.Fatalf("错误体格式不符: %s", body)
	}
}

func TestDecodeJSON(t *testing.T) {
	// 合法 JSON
	rec := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(`{"name":"a.txt"}`))
	var dst struct{ Name string }
	if !decodeJSON(rec, r, &dst) || dst.Name != "a.txt" {
		t.Fatal("decodeJSON 解析失败")
	}
	// 非法 JSON → 写 400 并返回 false
	rec = httptest.NewRecorder()
	r = httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(`{bad`))
	if decodeJSON(rec, r, &dst) {
		t.Fatal("非法 JSON 应返回 false")
	}
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("非法 JSON 应 400，得到 %d", rec.Code)
	}
}
