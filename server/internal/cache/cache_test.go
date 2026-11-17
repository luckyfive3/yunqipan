// cache_test.go —— 缓存抽象单元测试（no-op 降级行为）。
package cache

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestNoopCache(t *testing.T) {
	c, err := New("") // 未配置 REDIS_URL → no-op 实现
	if err != nil {
		t.Fatalf("New(\"\") 不应报错: %v", err)
	}
	if c.Enabled() {
		t.Fatal("no-op 缓存 Enabled 应为 false")
	}
	ctx := context.Background()

	if _, err := c.Get(ctx, "k"); !errors.Is(err, ErrMiss) {
		t.Fatalf("no-op Get 应返回 ErrMiss，得到 %v", err)
	}
	if err := c.Set(ctx, "k", "v", time.Minute); err != nil {
		t.Fatalf("no-op Set 应成功: %v", err)
	}
	if err := c.Del(ctx, "k"); err != nil {
		t.Fatalf("no-op Del 应成功: %v", err)
	}
	if n, err := c.LoginAttempt(ctx, "1.2.3.4"); err != nil || n != 0 {
		t.Fatalf("no-op LoginAttempt 应返回 (0, nil)，得到 (%d, %v)", n, err)
	}
	if err := c.Ping(ctx); err != nil {
		t.Fatalf("no-op Ping 应成功: %v", err)
	}
	if err := c.Close(); err != nil {
		t.Fatalf("no-op Close 应成功: %v", err)
	}
}

func TestNewBadRedisURL(t *testing.T) {
	if _, err := New("not-a-valid-url://%%%"); err == nil {
		t.Fatal("非法 REDIS_URL 应报错")
	}
}
