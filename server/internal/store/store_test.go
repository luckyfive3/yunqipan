// store_test.go —— 存储层纯函数单元测试（迁移切分、错误判定；不连数据库）。
package store

import (
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestSplitStatements(t *testing.T) {
	sql := `
-- 建表 A
CREATE TABLE IF NOT EXISTS a (
    id uuid PRIMARY KEY
);

-- 建表 B
CREATE TABLE IF NOT EXISTS b (
    id uuid PRIMARY KEY
);`
	stmts := splitStatements(sql)
	if len(stmts) != 2 {
		t.Fatalf("应切分出 2 条语句，得到 %d 条: %#v", len(stmts), stmts)
	}
	if stmts[0] != "CREATE TABLE IF NOT EXISTS a (\n    id uuid PRIMARY KEY\n)" {
		t.Fatalf("第 1 条语句不符: %q", stmts[0])
	}
}

func TestSplitStatementsEmptyAndOnlyComments(t *testing.T) {
	if got := splitStatements(""); len(got) != 0 {
		t.Fatalf("空脚本应返回 0 条，得到 %d", len(got))
	}
	if got := splitStatements("-- 只有注释\n\n-- 另一行注释"); len(got) != 0 {
		t.Fatalf("纯注释应返回 0 条，得到 %d", len(got))
	}
}

func TestIsUniqueViolation(t *testing.T) {
	if !isUniqueViolation(&pgconn.PgError{Code: "23505"}) {
		t.Error("23505 应判定为唯一约束冲突")
	}
	if isUniqueViolation(&pgconn.PgError{Code: "23503"}) {
		t.Error("23503 不应判定为唯一约束冲突")
	}
	if isUniqueViolation(errors.New("普通错误")) {
		t.Error("普通错误不应判定为唯一约束冲突")
	}
	if isUniqueViolation(nil) {
		t.Error("nil 不应判定为唯一约束冲突")
	}
}

func TestIsFKViolation(t *testing.T) {
	if !isFKViolation(&pgconn.PgError{Code: "23503"}) {
		t.Error("23503 应判定为外键冲突")
	}
	if isFKViolation(&pgconn.PgError{Code: "23505"}) {
		t.Error("23505 不应判定为外键冲突")
	}
}
