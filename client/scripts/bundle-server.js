'use strict';
/**
 * bundle-server.js —— 把 Go 服务端二进制复制到 client/resources/server，
 * 供 electron-builder extraResources 随安装包分发（内置单机模式）。
 * 由 npm 生命周期 predist:win / predist:mac 自动调用。
 */
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', '..', 'server', 'bin', 'server.exe');
const dstDir = path.join(__dirname, '..', 'resources', 'server');
const dst = path.join(dstDir, 'server.exe');

if (!fs.existsSync(src)) {
  console.error('[bundle-server] 未找到服务端二进制: ' + src);
  console.error('  请先构建服务端: cd server && go build -o bin/server.exe ./cmd/server');
  process.exit(1);
}
fs.mkdirSync(dstDir, { recursive: true });
fs.copyFileSync(src, dst);
console.log('[bundle-server] 已复制服务端二进制 -> ' + dst + ' (' + fs.statSync(dst).size + ' bytes)');
