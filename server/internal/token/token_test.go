// token_test.go —— JWT 与 preview-token 单元测试。
package token

import (
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const testUserID = "6ba7b810-9dad-11d1-80b4-00c04fd430c8"

func TestJWTIssueVerifyRoundtrip(t *testing.T) {
	m := NewManager("secret-a", "secret-b")
	tok, err := m.IssueJWT(testUserID)
	if err != nil {
		t.Fatalf("IssueJWT: %v", err)
	}
	got, err := m.VerifyJWT(tok)
	if err != nil {
		t.Fatalf("VerifyJWT: %v", err)
	}
	if got != testUserID {
		t.Fatalf("sub = %q, want %q", got, testUserID)
	}
}

func TestJWTRejectsTamperedAndExpired(t *testing.T) {
	m := NewManager("secret-a", "secret-b")

	// 篡改
	tok, _ := m.IssueJWT(testUserID)
	if _, err := m.VerifyJWT(tok + "x"); err == nil {
		t.Fatal("篡改的 token 应校验失败")
	}

	// 错误的签名密钥
	other := NewManager("other-secret", "secret-b")
	if _, err := other.VerifyJWT(tok); err == nil {
		t.Fatal("错误密钥应校验失败")
	}

	// 已过期
	expired := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.RegisteredClaims{
		Subject:   testUserID,
		ExpiresAt: jwt.NewNumericDate(time.Now().Add(-time.Minute)),
	})
	s, err := expired.SignedString([]byte("secret-a"))
	if err != nil {
		t.Fatalf("构造过期 token 失败: %v", err)
	}
	if _, err := m.VerifyJWT(s); err == nil {
		t.Fatal("过期 token 应校验失败")
	}

	// 算法混淆（用 none / 非 HS256）
	none := jwt.NewWithClaims(jwt.SigningMethodNone, jwt.RegisteredClaims{Subject: testUserID})
	s, err = none.SignedString(jwt.UnsafeAllowNoneSignatureType)
	if err != nil {
		t.Fatalf("构造 none 算法 token 失败: %v", err)
	}
	if _, err := m.VerifyJWT(s); err == nil {
		t.Fatal("none 算法 token 应校验失败")
	}
}

func TestPreviewTokenRoundtrip(t *testing.T) {
	m := NewManager("secret-a", "preview-secret")
	exp := time.Now().Add(5 * time.Minute).Unix()
	sig := m.PreviewToken(testUserID, exp)
	if !m.VerifyPreviewToken(testUserID, sig, exp) {
		t.Fatal("合法签名应通过")
	}
	// 过期
	if m.VerifyPreviewToken(testUserID, sig, time.Now().Add(-time.Minute).Unix()) {
		t.Fatal("过期签名不应通过")
	}
	// 篡改签名
	if m.VerifyPreviewToken(testUserID, sig+"x", exp) {
		t.Fatal("篡改签名不应通过")
	}
	// 不同文件 ID
	if m.VerifyPreviewToken("another-file-id", sig, exp) {
		t.Fatal("跨文件复用签名不应通过")
	}
}
