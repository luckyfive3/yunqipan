// Package cache 提供 Redis 可选缓存层：
// 未配置 REDIS_URL 时返回 no-op 实现，登录限流与上传会话缓存全部优雅降级。
package cache

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// ErrMiss 键不存在。
var ErrMiss = errors.New("cache: 键不存在")

// Cache 缓存抽象。业务代码只依赖该接口，Redis 不可用时行为不变（降级）。
type Cache interface {
	Get(ctx context.Context, key string) (string, error)
	Set(ctx context.Context, key, value string, ttl time.Duration) error
	Del(ctx context.Context, keys ...string) error
	// LoginAttempt 记录一次同 IP 登录尝试并返回当前分钟计数（限流用）。
	LoginAttempt(ctx context.Context, ip string) (int64, error)
	Ping(ctx context.Context) error
	Enabled() bool
	Close() error
}

// New 构造缓存：redisURL 为空时返回 no-op 实现。
func New(redisURL string) (Cache, error) {
	if strings.TrimSpace(redisURL) == "" {
		return &noopCache{}, nil
	}
	opts, err := redis.ParseURL(redisURL)
	if err != nil {
		return nil, fmt.Errorf("解析 REDIS_URL 失败: %w", err)
	}
	return &redisCache{client: redis.NewClient(opts)}, nil
}

// noopCache Redis 未配置时的降级实现：全部操作空转。
type noopCache struct{}

func (n *noopCache) Get(context.Context, string) (string, error)              { return "", ErrMiss }
func (n *noopCache) Set(context.Context, string, string, time.Duration) error { return nil }
func (n *noopCache) Del(context.Context, ...string) error                     { return nil }
func (n *noopCache) LoginAttempt(context.Context, string) (int64, error)      { return 0, nil }
func (n *noopCache) Ping(context.Context) error                               { return nil }
func (n *noopCache) Enabled() bool                                            { return false }
func (n *noopCache) Close() error                                             { return nil }

// redisCache 真实 Redis 实现。
type redisCache struct {
	client *redis.Client
}

func (r *redisCache) Get(ctx context.Context, key string) (string, error) {
	v, err := r.client.Get(ctx, key).Result()
	if errors.Is(err, redis.Nil) {
		return "", ErrMiss
	}
	if err != nil {
		return "", err
	}
	return v, nil
}

func (r *redisCache) Set(ctx context.Context, key, value string, ttl time.Duration) error {
	return r.client.Set(ctx, key, value, ttl).Err()
}

func (r *redisCache) Del(ctx context.Context, keys ...string) error {
	return r.client.Del(ctx, keys...).Err()
}

// LoginAttempt INCR + 首次 EXPIRE 实现同 IP 每分钟限流计数（契约 2：5 次/分钟）。
func (r *redisCache) LoginAttempt(ctx context.Context, ip string) (int64, error) {
	key := "login:attempt:" + ip
	n, err := r.client.Incr(ctx, key).Result()
	if err != nil {
		return 0, err
	}
	if n == 1 {
		// 首次计数时设置 1 分钟过期窗口
		if err := r.client.Expire(ctx, key, time.Minute).Err(); err != nil {
			return 0, err
		}
	}
	return n, nil
}

func (r *redisCache) Ping(ctx context.Context) error {
	return r.client.Ping(ctx).Err()
}

func (r *redisCache) Enabled() bool { return true }

func (r *redisCache) Close() error { return r.client.Close() }
