// Package token 提供两类令牌：
//  1. JWT（HS256，7 天有效期，claims: sub=用户 UUID、exp），契约 1.1；
//  2. preview-token（HMAC-SHA256 短签名，契约 3.7）：
//     token = base64url( HMAC-SHA256(PREVIEW_TOKEN_SECRET, "{id}|{exp}") )。
package token

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// jwtTTL JWT 有效期（契约 1.1：7 天）。
const jwtTTL = 7 * 24 * time.Hour

// Manager 令牌管理器。
type Manager struct {
	jwtSecret     []byte
	previewSecret []byte
}

// NewManager 构造令牌管理器。
func NewManager(jwtSecret, previewSecret string) *Manager {
	return &Manager{
		jwtSecret:     []byte(jwtSecret),
		previewSecret: []byte(previewSecret),
	}
}

// IssueJWT 为用户签发 JWT。
func (m *Manager) IssueJWT(userID string) (string, error) {
	now := time.Now()
	claims := jwt.RegisteredClaims{
		Subject:   userID,
		IssuedAt:  jwt.NewNumericDate(now),
		ExpiresAt: jwt.NewNumericDate(now.Add(jwtTTL)),
	}
	t := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	s, err := t.SignedString(m.jwtSecret)
	if err != nil {
		return "", fmt.Errorf("签发 JWT 失败: %w", err)
	}
	return s, nil
}

// VerifyJWT 校验 JWT 并返回 sub（用户 UUID）；无效/过期返回 error。
func (m *Manager) VerifyJWT(tokenStr string) (string, error) {
	parsed, err := jwt.ParseWithClaims(tokenStr, &jwt.RegisteredClaims{}, func(t *jwt.Token) (any, error) {
		return m.jwtSecret, nil
	}, jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}))
	if err != nil || !parsed.Valid {
		return "", fmt.Errorf("JWT 无效: %w", err)
	}
	claims, ok := parsed.Claims.(*jwt.RegisteredClaims)
	if !ok || claims.Subject == "" {
		return "", errors.New("JWT 缺少 sub")
	}
	return claims.Subject, nil
}

// PreviewToken 按契约 3.7 生成预览签名：base64url(HMAC-SHA256(secret, "{id}|{exp}"))。
func (m *Manager) PreviewToken(fileID string, exp int64) string {
	mac := hmac.New(sha256.New, m.previewSecret)
	_, _ = mac.Write([]byte(fmt.Sprintf("%s|%d", fileID, exp)))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// VerifyPreviewToken 校验预览签名：exp 未过期 + 恒定时间比对 HMAC。
func (m *Manager) VerifyPreviewToken(fileID, sig string, exp int64) bool {
	if exp <= time.Now().Unix() {
		return false
	}
	if sig == "" {
		return false
	}
	decoded, err := base64.RawURLEncoding.DecodeString(sig)
	if err != nil {
		return false
	}
	mac := hmac.New(sha256.New, m.previewSecret)
	_, _ = mac.Write([]byte(fmt.Sprintf("%s|%d", fileID, exp)))
	return hmac.Equal(decoded, mac.Sum(nil))
}
