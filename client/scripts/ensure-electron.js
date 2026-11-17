'use strict';
/**
 * ensure-electron.js —— npm postinstall 补偿脚本
 *
 * 背景：npm 11+ 默认不执行依赖包（electron）的 install 脚本（allowScripts 机制），
 * 导致 node_modules/electron/dist 下没有二进制、path.txt 缺失，`npm start` 会报
 * "Electron failed to install correctly"。
 *
 * 本脚本作为根项目的 postinstall 执行（根项目脚本始终会运行），检测到缺失时
 * 自动调用 electron 自带的 install.js 完成下载与解压；支持 ELECTRON_MIRROR 镜像。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const electronDir = path.join(__dirname, '..', 'node_modules', 'electron');
const isWin = process.platform === 'win32';
const binary = isWin
  ? path.join(electronDir, 'dist', 'electron.exe')
  : path.join(electronDir, 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
const pathTxt = path.join(electronDir, 'path.txt');

if (fs.existsSync(binary) && fs.existsSync(pathTxt)) {
  process.exit(0); // 已安装完整
}

if (!fs.existsSync(path.join(electronDir, 'install.js'))) {
  console.error('[云栖盘] electron 包未安装，请先执行 npm install');
  process.exit(1);
}

console.log('[云栖盘] 检测到 electron 二进制缺失，正在补装（可用 ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ 加速）...');
const r = spawnSync(process.execPath, [path.join(electronDir, 'install.js')], { stdio: 'inherit' });
if (r.status !== 0) {
  console.error('[云栖盘] electron 二进制下载失败。国内网络请设置环境变量 ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ 后重试 npm install');
  process.exit(r.status || 1);
}
process.exit(0);
