// router_test.go —— 路由注册回归测试。
// Go 1.22 ServeMux 对存在结构性冲突的模式（如 GET /files/upload/{id} 与
// GET /files/{id}/download）会在注册时直接 panic，本测试确保路由表始终无冲突。
package api

import "testing"

func TestRouterRegistrationNoConflict(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("路由注册 panic（存在模式冲突）: %v", r)
		}
	}()
	// Deps 为零值即可：注册阶段不触碰任何依赖
	h := NewRouter(Deps{})
	if h == nil {
		t.Fatal("NewRouter 不应返回 nil")
	}
}
