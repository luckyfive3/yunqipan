// users.go —— users 表数据访问：注册（含默认配额）、按用户名/ID 查询。

package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// User 用户模型（JSON 字段与契约 1.5 对齐；PasswordHash 不参与序列化）。
type User struct {
	ID           string    `json:"id"`
	Username     string    `json:"username"`
	PasswordHash string    `json:"-"`
	QuotaTotal   int64     `json:"quota_total"` // 0 = 不限容量
	QuotaUsed    int64     `json:"quota_used"`
	CreatedAt    time.Time `json:"created_at"`
}

// CreateUser 创建用户；用户名冲突（23505）返回 ErrConflict。
// quotaTotal 来自配置 DEFAULT_QUOTA_GB（0 = 不限容量）。
func (s *PgStore) CreateUser(ctx context.Context, username, passwordHash string, quotaTotal int64) (User, error) {
	var u User
	err := s.pool.QueryRow(ctx,
		`INSERT INTO users (username, password_hash, quota_total)
		 VALUES ($1, $2, $3)
		 RETURNING id::text, username, quota_total, quota_used, created_at`,
		username, passwordHash, quotaTotal).Scan(&u.ID, &u.Username, &u.QuotaTotal, &u.QuotaUsed, &u.CreatedAt)
	if err != nil {
		if isUniqueViolation(err) {
			return User{}, ErrConflict
		}
		return User{}, fmt.Errorf("创建用户失败: %w", err)
	}
	return u, nil
}

// GetUserByUsername 按用户名查询（含密码哈希，供登录比对）。
func (s *PgStore) GetUserByUsername(ctx context.Context, username string) (User, error) {
	var u User
	err := s.pool.QueryRow(ctx,
		`SELECT id::text, username, password_hash, quota_total, quota_used, created_at
		 FROM users WHERE username = $1`,
		username).Scan(&u.ID, &u.Username, &u.PasswordHash, &u.QuotaTotal, &u.QuotaUsed, &u.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, ErrNotFound
	}
	if err != nil {
		return User{}, fmt.Errorf("按用户名查询用户失败: %w", err)
	}
	return u, nil
}

// GetUserByID 按 ID 查询用户（含最新配额使用量）。
func (s *PgStore) GetUserByID(ctx context.Context, id string) (User, error) {
	var u User
	err := s.pool.QueryRow(ctx,
		`SELECT id::text, username, password_hash, quota_total, quota_used, created_at
		 FROM users WHERE id = $1::uuid`,
		id).Scan(&u.ID, &u.Username, &u.PasswordHash, &u.QuotaTotal, &u.QuotaUsed, &u.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, ErrNotFound
	}
	if err != nil {
		return User{}, fmt.Errorf("按 ID 查询用户失败: %w", err)
	}
	return u, nil
}
