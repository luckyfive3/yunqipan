// cmd/server/main.go —— 云栖盘服务端入口：
// 加载配置 → slog JSON 日志 → 初始化存储（LOCAL_MODE=1 时 SQLite+本地磁盘，否则 PostgreSQL+MinIO）
// → 初始化 Redis（可选）→ 注册路由 → 启动 HTTP 服务，signal.NotifyContext + Shutdown 优雅退出。
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"wangpan/server/internal/api"
	"wangpan/server/internal/cache"
	"wangpan/server/internal/config"
	"wangpan/server/internal/object"
	"wangpan/server/internal/store"
	"wangpan/server/internal/token"
)

func main() {
	cfg := config.Load()

	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: parseLogLevel(cfg.LogLevel)}))
	slog.SetDefault(logger)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	var st store.Store
	var obj object.Object

	if cfg.LocalMode {
		// ── 单机模式：SQLite + 本地磁盘，零外部依赖 ──
		dbPath := filepath.Join(cfg.DataDir, "cloudpan.db")
		lg, err := store.NewSqlite(dbPath)
		if err != nil {
			slog.Error("初始化 SQLite 失败", "err", err, "path", dbPath)
			os.Exit(1)
		}
		st = lg
		dk, err := object.NewDisk(cfg.DataDir)
		if err != nil {
			slog.Error("初始化本地磁盘存储失败", "err", err, "dir", cfg.DataDir)
			os.Exit(1)
		}
		obj = dk
		slog.Info("单机模式（LOCAL_MODE=1）", "data_dir", cfg.DataDir, "db", dbPath)
	} else {
		// ── 标准模式：PostgreSQL + S3 兼容对象存储 ──
		// 1. 连接 PostgreSQL 并执行幂等迁移
		pg, err := store.NewPg(ctx, cfg.DatabaseURL)
		if err != nil {
			slog.Error("连接数据库失败", "err", err)
			os.Exit(1)
		}
		defer pg.Close()
		if err := pg.RunMigrations(ctx); err != nil {
			slog.Error("执行迁移失败", "err", err)
			os.Exit(1)
		}
		slog.Info("数据库迁移完成")
		st = pg

		// 2. 连接 MinIO（S3 API）并确保 bucket 存在（幂等自建，无需 mc 初始化）
		so, err := object.NewS3(ctx, cfg.MinIOEndpoint, cfg.MinIORegion, cfg.MinIOAccessKey, cfg.MinIOSecretKey, cfg.MinIOBucket, cfg.MinIOUseSSL)
		if err != nil {
			slog.Error("初始化对象存储失败", "err", err)
			os.Exit(1)
		}
		if err := so.EnsureBucket(ctx); err != nil {
			slog.Error("确保 bucket 存在失败", "err", err)
			os.Exit(1)
		}
		slog.Info("对象存储就绪", "bucket", cfg.MinIOBucket)
		obj = so
	}
	defer st.Close()

	// 3. 缓存（标准模式用 Redis、可选；单机模式用本地磁盘缓存承载上传会话与限流）
	var c cache.Cache
	if cfg.LocalMode {
		dc, err := cache.NewDisk(filepath.Join(cfg.DataDir, "cache"))
		if err != nil {
			slog.Error("初始化本地磁盘缓存失败", "err", err)
			os.Exit(1)
		}
		c = dc
		slog.Info("单机模式：使用本地磁盘缓存")
	} else {
		if cfg.RedisURL != "" {
			rc, err := cache.New(cfg.RedisURL)
			if err != nil {
				slog.Error("初始化 Redis 失败", "err", err)
				os.Exit(1)
			}
			c = rc
			if err := c.Ping(ctx); err != nil {
				slog.Warn("Redis 不可用，登录限流与缓存将降级", "err", err)
			} else {
				slog.Info("Redis 就绪")
			}
		} else {
			// 未配置 Redis：上传会话/限流改用本地磁盘缓存（否则分块上传会话
			// 无处保存，chunk PUT 必 404 —— 这是曾经导致“传输失败”的根因）。
			dc, err := cache.NewDisk(cfg.CacheDir)
			if err != nil {
				slog.Error("初始化本地磁盘缓存失败", "err", err)
				os.Exit(1)
			}
			c = dc
			slog.Info("未配置 REDIS_URL，上传会话与限流使用本地磁盘缓存", "dir", cfg.CacheDir)
		}
	}
	defer func() { _ = c.Close() }()

	// 4. 注册路由
	tm := token.NewManager(cfg.JWTSecret, cfg.PreviewTokenSecret)
	handler := api.NewRouter(api.Deps{
		Store:             st,
		Object:            obj,
		Cache:             c,
		Tokens:            tm,
		DefaultQuotaBytes: cfg.DefaultQuotaGB * 1073741824,
	})

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}

	// 5. 启动 HTTP 服务并优雅退出
	errCh := make(chan error, 1)
	go func() {
		slog.Info("HTTP 服务启动", "addr", cfg.Addr)
		errCh <- srv.ListenAndServe()
	}()
	select {
	case err := <-errCh:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("HTTP 服务异常退出", "err", err)
			os.Exit(1)
		}
	case <-ctx.Done():
		slog.Info("收到退出信号，开始优雅关闭")
		shutCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutCtx); err != nil {
			slog.Error("优雅关闭失败", "err", err)
		}
		slog.Info("服务已退出")
	}
}

// parseLogLevel 将配置中的日志级别字符串转换为 slog.Level。
func parseLogLevel(s string) slog.Level {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}
