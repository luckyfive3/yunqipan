// Package store 提供元数据访问层：
//   - Store 接口：api 层依赖的统一抽象；
//   - PgStore：PostgreSQL 实现（默认，LOCAL_MODE=0）；
//   - SqliteStore：SQLite 单机实现（LOCAL_MODE=1，零外部依赖）。
//
// 幂等迁移（RunMigrations）仅 PG 实现需要；SQLite 实现自带建表。
package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"wangpan/server/migrations"
)

// 业务层错误哨兵值，API 层据此映射为契约错误码。
// 两个实现（PgStore / SqliteStore）必须统一使用这些哨兵值。
var (
	ErrNotFound       = errors.New("记录不存在")
	ErrConflict       = errors.New("同名冲突")
	ErrForbidden      = errors.New("无权访问")
	ErrQuotaExceeded  = errors.New("配额不足")
	ErrTooManyNodes   = errors.New("节点过多")
	ErrInvalidInput   = errors.New("输入非法")
	ErrCycle          = errors.New("目录移动成环")
	ErrDepthExceeded  = errors.New("目录深度超限")
	ErrParentNotFound = errors.New("父目录不存在")
)

// maxTreeDepth 目录最大深度（契约 1.4）。
const maxTreeDepth = 64

// Store 元数据访问接口（api 层只依赖该接口）。
// 实现：PgStore（PostgreSQL）与 SqliteStore（SQLite 单机模式）。
type Store interface {
	CreateUser(ctx context.Context, username, passwordHash string, quotaTotal int64) (User, error)
	GetUserByUsername(ctx context.Context, username string) (User, error)
	GetUserByID(ctx context.Context, id string) (User, error)

	ListChildren(ctx context.Context, userID string, parentID *string) ([]File, error)
	ListAll(ctx context.Context, userID string) ([]File, error)
	GetFileByID(ctx context.Context, id string) (File, error)
	CreateDir(ctx context.Context, userID string, parentID *string, name string) (File, error)
	RenameFile(ctx context.Context, userID, id, name string) (File, error)
	MoveFile(ctx context.Context, userID, id string, parentID *string) (File, error)
	DeleteFile(ctx context.Context, userID, id string, recursive bool) (freed int64, keys []string, err error)
	CreateFileComplete(ctx context.Context, userID, id string, parentID *string, name string, size int64, mimeType string, sha256 *string, encrypted bool, objectKey string) (File, error)

	CreateShare(ctx context.Context, userID, fileID, token string, codeHash *string, expiresAt *time.Time, maxDownloads *int) (Share, error)
	ListShares(ctx context.Context, userID string) ([]Share, error)
	GetShareByToken(ctx context.Context, token string) (Share, error)
	DeleteShare(ctx context.Context, userID, id string) (bool, error)
	IncrementDownload(ctx context.Context, id string) (bool, error)
	SubtreeFiles(ctx context.Context, rootID string) ([]File, error)

	Ping(ctx context.Context) error
	Close()
}

// PgStore PostgreSQL 数据访问层。
type PgStore struct {
	pool *pgxpool.Pool
}

// NewPg 创建 PostgreSQL 连接池并验证连通性。
func NewPg(ctx context.Context, connString string) (*PgStore, error) {
	pool, err := pgxpool.New(ctx, connString)
	if err != nil {
		return nil, fmt.Errorf("创建 PostgreSQL 连接池失败: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("连接 PostgreSQL 失败: %w", err)
	}
	return &PgStore{pool: pool}, nil
}

// Ping 健康检查用。
func (s *PgStore) Ping(ctx context.Context) error { return s.pool.Ping(ctx) }

// Close 关闭连接池。
func (s *PgStore) Close() { s.pool.Close() }

// RunMigrations 幂等执行内嵌迁移（仅 PostgreSQL 使用）。
func (s *PgStore) RunMigrations(ctx context.Context) error {
	for i, stmt := range splitStatements(migrations.InitSQL) {
		if _, err := s.pool.Exec(ctx, stmt); err != nil {
			return fmt.Errorf("执行第 %d 条迁移语句失败: %w", i+1, err)
		}
	}
	return nil
}

// splitStatements 将迁移脚本切分为单条语句。
// 迁移脚本仅含简单 DDL（无函数体/触发器/分号字面量），按 ";" 切分是安全的。
func splitStatements(sqlText string) []string {
	var out []string
	for _, chunk := range strings.Split(sqlText, ";") {
		var lines []string
		for _, ln := range strings.Split(chunk, "\n") {
			t := strings.TrimSpace(ln)
			if t == "" || strings.HasPrefix(t, "--") {
				continue
			}
			lines = append(lines, ln)
		}
		stmt := strings.TrimSpace(strings.Join(lines, "\n"))
		if stmt != "" {
			out = append(out, stmt)
		}
	}
	return out
}

// isUniqueViolation 判断是否为唯一约束冲突（SQLSTATE 23505，PostgreSQL）。
func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

// isFKViolation 判断是否为外键约束冲突（SQLSTATE 23503，PostgreSQL）。
func isFKViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23503"
}
