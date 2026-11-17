// Package config 提供全环境变量驱动的服务端配置，所有项均有开发默认值，
// 默认值与 docker-compose.dev.yml 对齐，可零配置直接启动。
package config

import (
	"os"
	"strconv"
	"strings"
)

// Config 服务端运行配置。
type Config struct {
	Addr               string // HTTP 监听地址，如 ":8080"
	LocalMode          bool   // 单机模式：SQLite + 本地磁盘，零外部依赖
	DataDir            string // 单机模式数据目录（默认 ./data-local）
	DatabaseURL        string // PostgreSQL 连接串
	RedisURL           string // Redis 连接串；留空则限流/缓存降级为本地磁盘缓存（CacheDir）
	CacheDir           string // 无 Redis 时本地磁盘缓存目录（上传会话/限流）
	MinIOEndpoint      string // MinIO S3 端点（可带或不带 scheme）
	MinIORegion        string // S3 区域（MinIO 填任意值即可）
	MinIOAccessKey     string
	MinIOSecretKey     string
	MinIOBucket        string
	MinIOUseSSL        bool
	JWTSecret          string // JWT HS256 签名密钥
	PreviewTokenSecret string // preview-token HMAC-SHA256 密钥（契约 3.7）
	DefaultQuotaGB     int64  // 新用户默认配额（GB）；0 = 不限容量
	LogLevel           string // debug / info / warn / error
}

// Load 从环境变量加载配置，未设置时使用开发默认值。
func Load() Config {
	return Config{
		Addr:               getenv("SERVER_ADDR", ":8080"),
		LocalMode:          getenvBool("LOCAL_MODE", false),
		DataDir:            getenv("DATA_DIR", "./data-local"),
		DatabaseURL:        getenv("DATABASE_URL", "postgres://wangpan:wangpan@localhost:5432/wangpan?sslmode=disable"),
		RedisURL:           getenv("REDIS_URL", ""),
		CacheDir:           getenv("CACHE_DIR", "./data-cache"),
		MinIOEndpoint:      getenv("MINIO_ENDPOINT", "127.0.0.1:19000"),
		MinIORegion:        getenv("MINIO_REGION", "us-east-1"),
		MinIOAccessKey:     getenv("MINIO_ACCESS_KEY", "minioadmin"),
		MinIOSecretKey:     getenv("MINIO_SECRET_KEY", "minioadmin"),
		MinIOBucket:        getenv("MINIO_BUCKET", "wangpan"),
		MinIOUseSSL:        getenvBool("MINIO_USE_SSL", false),
		JWTSecret:          getenv("JWT_SECRET", "dev-insecure-jwt-secret-change-me"),
		PreviewTokenSecret: getenv("PREVIEW_TOKEN_SECRET", "dev-insecure-preview-secret-change-me"),
		DefaultQuotaGB:     getenvInt64("DEFAULT_QUOTA_GB", 10),
		LogLevel:           getenv("LOG_LEVEL", "info"),
	}
}

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return strings.TrimSpace(v)
	}
	return def
}

func getenvBool(key string, def bool) bool {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return def
	}
	return b
}

func getenvInt64(key string, def int64) int64 {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil {
		return def
	}
	return n
}
