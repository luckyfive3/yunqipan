// Package migrations 通过 go:embed 内嵌数据库迁移 SQL，
// 供 store.RunMigrations 在服务启动时幂等执行。
package migrations

import _ "embed"

// InitSQL 内嵌的初始建表脚本内容。
//
//go:embed 001_init.sql
var InitSQL string
