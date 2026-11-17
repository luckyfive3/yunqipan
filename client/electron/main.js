'use strict';
/**
 * main.js —— 主进程入口
 *
 * 职责：
 *   1. 单实例锁：重复启动时聚焦已有窗口。
 *   2. 创建 BrowserWindow（contextIsolation:true, nodeIntegration:false, sandbox:true），
 *      加载 renderer/index.html。
 *   3. 启动时初始化全部服务：userData 目录、settings、task-store、事件总线、api-client、
 *      传输队列、上传管理器、aria2 引擎、下载引擎、同步服务、解析器、IPC 路由。
 *   4. 任务恢复：task-store 恢复未完成任务（running → paused）；
 *      settings.autoResume 为 true 时自动继续（上传按 upload_id、下载按控制文件续传）。
 *   5. 退出时：持久化任务与设置、终止 aria2 子进程（优先 aria2.shutdown，超时 SIGTERM）。
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

// 目录可写性探测（创建目录 + 写入临时文件）。
function dirWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.wp-write-probe');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch (e) {
    return false;
  }
}

// 用户数据目录解析（必须在 app ready 之前完成，Chromium 的 singleton 锁与 GPU 缓存才会跟随）：
//   1) WP_USER_DATA 环境变量（便携模式，启动器设置）；
//   2) 默认 %APPDATA%\云栖盘；
//   3) 默认路径不可写时 → 程序旁 profile 目录（绿色版解压目录）；
//   4) 仍不可写 → 系统临时目录 yunqipan-profile。
// 保证「直接双击 exe」在任何环境下都能启动，而不是因用户目录不可写静默退出。
let userDataOverride = process.env.WP_USER_DATA ? path.resolve(process.env.WP_USER_DATA) : null;
if (!userDataOverride) {
  const defaultUserData = app.getPath('userData');
  if (!dirWritable(defaultUserData)) {
    const exeProfile = path.join(path.dirname(app.getPath('exe')), 'profile');
    if (dirWritable(exeProfile)) {
      userDataOverride = exeProfile;
    } else {
      const tmpProfile = path.join(os.tmpdir(), 'yunqipan-profile');
      if (dirWritable(tmpProfile)) userDataOverride = tmpProfile;
    }
  }
}
if (userDataOverride) {
  app.setPath('userData', userDataOverride);
}

// ── 兼容性开关：部分机器（含本项目开发机）的 Chromium 进程沙箱在系统安全策略下
//    初始化失败会导致进程以 STATUS_BREAKPOINT 静默退出（连 --version 都跑不起来）。
//    --no-sandbox 仅禁用 OS 级进程沙箱；渲染层仍保留 contextIsolation + sandbox:true +
//    零 Node 权限，安全性不受影响。
app.commandLine.appendSwitch('no-sandbox');

const { createSettings } = require('./services/settings');
const { createTaskStore } = require('./services/task-store');
const events = require('./services/events');
const { createApiClient } = require('./services/api-client');
const { createTransferQueue } = require('./services/transfer-queue');
const { createAria2Engine } = require('./services/aria2-engine');
const { createDownloadEngine } = require('./services/download-engine');
const { createUploadManager } = require('./services/upload-manager');
const { createSyncService } = require('./services/sync-service');
const { createRegistry } = require('./parsers/registry');
const ipc = require('./ipc');

let mainWin = null;
let quitting = false;
let services = null;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // ── 启动诊断：任何未捕获异常都落盘到 userData\startup-error.log，
  //    启动失败用系统弹窗明示（避免"双击没反应"无从排查）──
  process.on('uncaughtException', (err) => {
    try {
      const dir = app.getPath('userData');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'startup-error.log'),
        '[' + new Date().toISOString() + '] uncaughtException\n' + (err && err.stack ? err.stack : String(err)) + '\n');
    } catch (e) { /* 忽略日志写入失败 */ }
  });
  process.on('unhandledRejection', (reason) => {
    try {
      const dir = app.getPath('userData');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'startup-error.log'),
        '[' + new Date().toISOString() + '] unhandledRejection\n' +
        (reason && reason.stack ? reason.stack : String(reason)) + '\n');
    } catch (e) { /* 忽略 */ }
  });

  app.on('second-instance', () => {
    if (mainWin) {
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.focus();
    }
  });

  app.whenReady().then(bootstrap).catch((e) => {
    console.error('[main] 启动失败：', e);
    try {
      const dir = app.getPath('userData');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'startup-error.log'),
        '[' + new Date().toISOString() + '] bootstrap 失败\n' + (e && e.stack ? e.stack : String(e)) + '\n');
      const { dialog } = require('electron');
      dialog.showErrorBox('云栖盘启动失败',
        '启动失败，错误详情已写入:\n' + path.join(dir, 'startup-error.log') + '\n\n' +
        String((e && (e.stack || e.message)) || e).slice(0, 800));
    } catch (e2) { /* 弹窗失败则仅退出 */ }
    app.quit();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', (e) => {
    if (quitting) return;
    quitting = true;
    e.preventDefault();
    shutdown().finally(() => app.exit(0));
  });
}

async function bootstrap() {
  const userData = app.getPath('userData');

  // 1) userData 下建目录：缓存、aria2 缓存、加密临时目录
  const cacheDir = path.join(userData, 'cache');
  for (const dir of [cacheDir, path.join(cacheDir, 'aria2'), path.join(cacheDir, 'enc-tmp')]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // 2) 设置（填充运行时默认目录）
  const settings = createSettings({ userDataDir: userData });
  await settings.load();
  // 默认下载目录放在 userData 内：任何启动方式/受限环境都可写（系统 Downloads 目录
  // 在部分受限环境下会被拒写 EPERM，导致下载失败）
  if (!settings.get('downloadDir')) settings.set('downloadDir', path.join(userData, 'downloads'));
  if (!settings.get('cacheDir')) settings.set('cacheDir', cacheDir);

  // 3) 任务存储
  const taskStore = createTaskStore({ userDataDir: userData });
  await taskStore.load();

  // 4) 事件总线（窗口推送出口）
  events.init(() => (mainWin ? [mainWin] : []));

  // 5) API 客户端（401 时广播认证失效）
  const api = createApiClient({ userDataDir: userData, settings });
  api.setOnUnauthorized(() => {
    events.emit('auth:changed', { authed: false, reason: 'expired' });
  });

  // 6) 传输队列（统一调度上传+下载）
  const queue = createTransferQueue({ settings, taskStore, events });

  // 7) aria2 引擎（可选加速内核）
  const aria2Engine = createAria2Engine({ settings, userDataDir: userData });

  // 8) 下载引擎（门面：aria2 / 自研内核）
  const downloadEngine = createDownloadEngine({ settings, api, aria2Engine });

  // 9) 上传管理器
  const uploadManager = createUploadManager({ settings, api, queue, userDataDir: userData });

  // 10) 解析器注册表
  const parsers = createRegistry({ settings, api });

  // 11) 同步服务
  const syncService = createSyncService({ settings, api, queue, events, userDataDir: userData });

  queue.attachEngines(uploadManager, downloadEngine);
  queue.startHeartbeat();

  services = {
    settings, taskStore, events, api, queue,
    uploadManager, downloadEngine, aria2Engine,
    syncService, parsers,
    getWin: () => mainWin
  };

  // 12) IPC 路由
  ipc.init(services);

  // 13) 创建窗口
  createWindow();

  // 启动成功留痕（用于"双击没反应"时区分「应用已运行」与「启动即失败」）
  try {
    fs.mkdirSync(userData, { recursive: true });
    fs.appendFileSync(path.join(userData, 'startup.log'),
      '[' + new Date().toISOString() + '] 启动成功（' + app.getVersion() + '）\n');
  } catch (e) { /* 忽略 */ }

  // 14) 恢复未完成任务：running → paused；autoResume 则自动继续
  const saved = taskStore.all();
  queue.restore(saved, !!settings.get('autoResume'));

  // 15) 同步服务按配置自动启动
  if (settings.get('sync') && settings.get('sync.enabled') && settings.get('sync.localRoot')) {
    syncService.start().catch(() => { /* 同步启动失败不影响主流程 */ });
  }
}

function createWindow() {
  mainWin = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 920,
    minHeight: 620,
    title: '云栖盘',
    autoHideMenuBar: true,
    backgroundColor: '#f5f7fa',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  mainWin.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWin.on('closed', () => { mainWin = null; });
}

/** 退出清理：停止心跳与同步、持久化任务与设置、优雅关闭 aria2。 */
async function shutdown() {
  try {
    if (services) {
      services.queue.stopHeartbeat();
      services.syncService.stop();
      await services.taskStore.flushNow();
      await services.settings.flushNow();
      await services.aria2Engine.shutdown();
    }
  } catch (e) {
    console.error('[main] 退出清理异常：', e);
  }
}
