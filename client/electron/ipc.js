'use strict';
/**
 * ipc.js —— IPC 单一入口与通道分发表
 *
 * 职责：
 *   1. ipcMain.handle('wp:invoke') 单一入口，按 channel 分发表（下方 handler 表）。
 *   2. 所有返回值统一 {ok:true,data} | {ok:false,error:{code,message}}，渲染层统一 toast 错误。
 *   3. 通道清单（与 preload 暴露 / 渲染层调用一一对应）：
 *        auth:    register|login|logout|me
 *        files:   list|path|mkdir|rename|move|remove|tree|previewToken
 *        upload:  start|pause|resume|cancel
 *        download:start|pause|resume|cancel|retry|list|summary
 *        transfers:list|clearFinished
 *        shares:  create|list|remove|resolve
 *        parse:   resolve|download
 *        sync:    configure|start|stop|status|scanNow
 *        settings:get|set
 *        app:     pickDirectory|pickFile|openPath|reveal|version|getState
 */
const { ipcMain, dialog, shell, app, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');

const ok = (data) => ({ ok: true, data });
const fail = (e) => ({
  ok: false,
  error: { code: (e && e.code) || 'INTERNAL', message: (e && e.message) || String(e) }
});

function init(services) {
  const {
    settings, api, queue, uploadManager, syncService, parsers, events, aria2Engine
  } = services;
  const getWin = () => services.getWin ? services.getWin() : null;

  function requireAuth() {
    if (!api.hasToken()) throw { code: 'UNAUTHORIZED', message: '尚未登录，请先登录' };
  }

  // ── 本地服务端自动拉起：从 exe 所在目录向上查找 scripts\start.ps1（覆盖
  //    启动器/绿色版/开发模式；安装版不含脚本则跳过，依赖开机自启任务）──
  let serverStartAttempted = false;
  function findServerStarter() {
    let dir = path.dirname(app.getPath('exe'));
    for (let i = 0; i < 4; i++) {
      const cand = path.join(dir, 'scripts', 'start.ps1');
      if (fs.existsSync(cand)) return cand;
      dir = path.dirname(dir);
    }
    return null;
  }
  async function autoStartLocalServer() {
    if (serverStartAttempted) return false;
    serverStartAttempted = true;
    const script = findServerStarter();
    if (!script) return false;
    try {
      spawn('powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-ServerOnly'],
        { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      return true;
    } catch (e) {
      return false;
    }
  }
  async function waitServerReady(timeoutMs) {
    // 探测顺序：当前配置地址 → 本机常见端口（服务端可能因端口占用而换端口）
    const bases = [];
    const cur = String(settings.get('serverBase') || '');
    if (cur) bases.push(cur);
    for (let p = 8080; p <= 8083; p++) bases.push('http://127.0.0.1:' + p);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const b of bases) {
        try {
          const d = await api.get(b + '/healthz', { auth: false, timeoutMs: 2000 });
          if (d && d.ok === true) {
            if (settings.get('serverBase') !== b) settings.set('serverBase', b);
            return true;
          }
        } catch (e) { /* 未就绪继续等 */ }
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    return false;
  }

  // ── 内置单机服务端（随安装包分发的 server.exe，SQLite + 本地磁盘，零外部依赖）──
  function findEmbeddedServer() {
    const candidates = [];
    if (process.resourcesPath) {
      candidates.push(path.join(process.resourcesPath, 'server', 'server.exe'));
    }
    candidates.push(path.join(app.getPath('exe'), '..', '..', '..', 'server', 'bin', 'server.exe'));
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return null;
  }
  function freePort() {
    return new Promise((resolve, reject) => {
      const s = net.createServer();
      s.unref();
      s.on('error', reject);
      s.listen(0, '127.0.0.1', () => {
        const p = s.address().port;
        s.close(() => resolve(p));
      });
    });
  }
  async function startEmbeddedServer() {
    const bin = findEmbeddedServer();
    if (!bin) return false;
    try {
      const port = await freePort();
      const dataDir = path.join(app.getPath('userData'), 'server-data');
      const env = Object.assign({}, process.env);
      delete env.ELECTRON_RUN_AS_NODE;
      env.LOCAL_MODE = '1';
      env.DATA_DIR = dataDir;
      env.SERVER_ADDR = '127.0.0.1:' + port;
      spawn(bin, [], { env, detached: true, stdio: 'ignore', windowsHide: true }).unref();
      settings.set('serverBase', 'http://127.0.0.1:' + port);
      return true;
    } catch (e) {
      return false;
    }
  }
  /** 服务端启动链：全新安装 → 内置单机服务端；已配置远程地址 → 尝试项目一键脚本（Docker 服务端）。 */
  async function startServerChain() {
    const base = String(settings.get('serverBase') || '');
    if (!base) {
      if (await startEmbeddedServer()) {
        return waitServerReady(60000);
      }
    }
    if (await autoStartLocalServer()) {
      return waitServerReady(180000);
    }
    return false;
  }

  /** 目标下载路径唯一化：同名文件自动追加 " (n)"，避免互相覆盖。 */
  function uniqueDest(destPath) {
    let p = destPath;
    let n = 1;
    while (fs.existsSync(p)) {
      const ext = path.extname(destPath);
      const base = destPath.slice(0, destPath.length - ext.length);
      p = base + ' (' + n + ')' + ext;
      n++;
    }
    return p;
  }

  ipcMain.handle('wp:invoke', async (event, channel, payload) => {
    payload = payload || {};
    try {
      switch (channel) {
        /* ---------------- 认证 ---------------- */
        case 'auth:register': {
          const d = await api.post('/api/v1/auth/register', {
            username: String(payload.username || ''), password: String(payload.password || '')
          });
          api.setAuth({ token: d.token, user: d.user });
          events.emit('auth:changed', { authed: true, user: d.user });
          return ok({ user: d.user });
        }
        case 'auth:login': {
          const d = await api.post('/api/v1/auth/login', {
            username: String(payload.username || ''), password: String(payload.password || '')
          });
          api.setAuth({ token: d.token, user: d.user });
          events.emit('auth:changed', { authed: true, user: d.user });
          return ok({ user: d.user });
        }
        case 'auth:logout': {
          api.clear();
          events.emit('auth:changed', { authed: false });
          return ok(true);
        }
        case 'auth:me': {
          requireAuth();
          const d = await api.get('/api/v1/auth/me');
          if (d && d.user) api.setAuth({ user: d.user });
          return ok(d.user);
        }
        case 'auth:autoLogin': {
          // 本地单用户免登录模式：打开即用。
          // 1) 已有有效 token → 校验并返回；2) 否则用持久化凭据自动注册（已存在则登录）；
          // 3) 服务端不在线时：若本机可定位到启动脚本，自动拉起服务端（最长等 3 分钟）后重试。
          const attempt = async () => {
            if (api.hasToken()) {
              try {
                const d = await api.get('/api/v1/auth/me');
                if (d && d.user) {
                  api.setAuth({ user: d.user });
                  return { user: d.user };
                }
              } catch (e) {
                if (e.code !== 'UNAUTHORIZED') throw e; // 网络/服务端错误上抛
              }
            }
            let creds = settings.get('localCreds');
            if (!creds) {
              creds = {
                username: 'local_' + Math.random().toString(36).slice(2, 8),
                password: 'wp' + Math.random().toString(36).slice(2, 14)
              };
              settings.set('localCreds', creds);
            }
            try {
              const d = await api.post('/api/v1/auth/register', {
                username: creds.username, password: creds.password
              });
              api.setAuth({ token: d.token, user: d.user });
            } catch (e) {
              if (e.code !== 'CONFLICT') throw e;
              const d = await api.post('/api/v1/auth/login', {
                username: creds.username, password: creds.password
              });
              api.setAuth({ token: d.token, user: d.user });
            }
            return { user: api.getUser() };
          };
          try {
            const r = await attempt();
            events.emit('auth:changed', { authed: true, user: r.user });
            return ok(r);
          } catch (e) {
            if (e && (e.code === 'NETWORK' || e.code === 'TIMEOUT')) {
              if (await startServerChain()) {
                const r2 = await attempt();
                events.emit('auth:changed', { authed: true, user: r2.user });
                return ok(r2);
              }
              throw { code: 'SERVER_OFFLINE', message: '服务端未启动：内置单机服务端不可用，请检查安装完整性或双击项目根目录 start.bat 启动服务端后重试' };
            }
            throw e;
          }
        }

        /* ---------------- 文件 ---------------- */
        case 'files:list': {
          requireAuth();
          const q = payload.parentId ? '?parent_id=' + encodeURIComponent(payload.parentId) : '';
          const d = await api.get('/api/v1/files' + q);
          return ok(d.items || []);
        }
        case 'files:path': {
          requireAuth();
          // 沿 parent_id 链逐级回溯，构造面包屑路径
          const chain = [];
          let id = payload.id || null;
          let guard = 0;
          while (id && guard++ < 64) {
            const d = await api.get('/api/v1/files/' + encodeURIComponent(id));
            chain.unshift({ id: d.file.id, name: d.file.name, isDir: d.file.is_dir });
            id = d.file.parent_id;
          }
          return ok(chain);
        }
        case 'files:mkdir': {
          requireAuth();
          const d = await api.post('/api/v1/files/mkdir', {
            parent_id: payload.parentId ?? null, name: String(payload.name || '')
          });
          return ok(d.file);
        }
        case 'files:rename': {
          requireAuth();
          const d = await api.post('/api/v1/files/rename', {
            id: String(payload.id), name: String(payload.name || '')
          });
          return ok(d.file);
        }
        case 'files:move': {
          requireAuth();
          const d = await api.post('/api/v1/files/move', {
            id: String(payload.id), parent_id: payload.parentId ?? null
          });
          return ok(d.file);
        }
        case 'files:remove': {
          requireAuth();
          await api.del('/api/v1/files/' + encodeURIComponent(payload.id) + '?recursive=' + (payload.recursive ? 'true' : 'false'));
          return ok(true);
        }
        case 'files:tree': {
          requireAuth();
          const d = await api.get('/api/v1/files/tree');
          return ok(d.items || []);
        }
        case 'files:previewToken': {
          requireAuth();
          const d = await api.post('/api/v1/files/' + encodeURIComponent(payload.id) + '/preview-token', {
            ttl_seconds: payload.ttlSeconds || 300
          });
          return ok({ url: api.base() + d.url, expiresAt: d.expires_at });
        }

        /* ---------------- 上传 ---------------- */
        case 'upload:start': {
          requireAuth();
          if (!payload.localPath) throw { code: 'INVALID_INPUT', message: '缺少本地文件路径' };
          const def = await uploadManager.createTask({
            localPath: payload.localPath,
            parentId: payload.parentId ?? null,
            name: payload.name,
            encrypted: payload.encrypted === undefined ? !!settings.get('e2eDefault') : !!payload.encrypted
          });
          const task = queue.addTask(def);
          return ok({ task: queue.get(task.id) });
        }
        case 'upload:pause': { queue.pause(payload.id); return ok(true); }
        case 'upload:resume': { queue.resume(payload.id); return ok(true); }
        case 'upload:cancel': { queue.cancel(payload.id); return ok(true); }

        /* ---------------- 下载 ---------------- */
        case 'download:start': {
          requireAuth();
          const source = payload.source || {};
          if (!source.type || !['file', 'share', 'url'].includes(source.type)) {
            throw { code: 'INVALID_INPUT', message: '无效的下载源' };
          }
          if (!payload.name) throw { code: 'INVALID_INPUT', message: '缺少文件名' };
          const destDir = payload.destDir || settings.get('downloadDir') || app.getPath('downloads');
          const destPath = uniqueDest(path.join(destDir, payload.name));
          const task = queue.addTask({
            kind: 'download',
            name: payload.name,
            size: payload.size || 0,
            source,
            destPath,
            threads: payload.threads || settings.get('defaultThreads') || 8
          });
          return ok({ task: queue.get(task.id) });
        }
        case 'download:pause': { queue.pause(payload.id); return ok(true); }
        case 'download:resume': { queue.resume(payload.id); return ok(true); }
        case 'download:cancel': { queue.cancel(payload.id); return ok(true); }
        case 'download:retry': { queue.retry(payload.id); return ok(true); }
        case 'download:list': { return ok(queue.list('download')); }
        case 'download:summary': { return ok(queue.summary()); }

        /* ---------------- 传输 ---------------- */
        case 'transfers:list': {
          return ok({ tasks: queue.list(), summary: queue.summary() });
        }
        case 'transfers:clearFinished': {
          queue.clearFinished();
          return ok(true);
        }

        /* ---------------- 分享 ---------------- */
        case 'shares:create': {
          requireAuth();
          const d = await api.post('/api/v1/shares', {
            file_id: String(payload.fileId),
            require_code: !!payload.requireCode,
            extract_code: payload.requireCode ? String(payload.extractCode || '') : undefined,
            expires_hours: payload.expiresHours || 0,
            max_downloads: payload.maxDownloads || 0
          });
          return ok({ share: d.share, url: api.base() + d.url });
        }
        case 'shares:list': {
          requireAuth();
          const d = await api.get('/api/v1/shares');
          return ok(d.shares || []);
        }
        case 'shares:remove': {
          requireAuth();
          await api.del('/api/v1/shares/' + encodeURIComponent(payload.id));
          return ok(true);
        }
        case 'shares:resolve': {
          // 公开接口：不带 Bearer（避免过期 token 干扰公开访问）
          const d = await api.post('/api/v1/shares/resolve', {
            token: String(payload.token || ''),
            extract_code: payload.extractCode ? String(payload.extractCode) : undefined
          }, { auth: false });
          return ok(d);
        }

        /* ---------------- 解析 ---------------- */
        case 'parse:resolve': {
          // 解析整体超时保护（45 秒）：避免第三方页面长时间无响应挂住界面
          const work = (async () => {
            const r = await parsers.resolve(payload.link, payload.code);
            if (r.type === 'share') {
              // 自家服务端分享链接特判：直接走 shares.resolve（公开接口）
              try {
                const d = await api.post('/api/v1/shares/resolve', {
                  token: r.token,
                  extract_code: payload.code ? String(payload.code) : undefined
                }, { auth: false });
                return { type: 'share', token: r.token, share: d.share, tree: d.tree || [] };
              } catch (e) {
                if (e.code === 'SHARE_CODE_REQUIRED' || e.code === 'SHARE_CODE_INVALID') {
                  throw { code: e.code, message: '请输入提取码：' + (e.message || '需要提取码') };
                }
                throw e;
              }
            }
            return r;
          })();
          const timeout = new Promise((_, reject) => {
            setTimeout(() => reject({ code: 'PARSER_TIMEOUT', message: '解析超时（45 秒），请确认链接有效或稍后重试' }), 45000);
          });
          return ok(await Promise.race([work, timeout]));
        }
        case 'parse:download': {
          requireAuth();
          const files = payload.files || [];
          const destDir = payload.destDir || settings.get('downloadDir') || app.getPath('downloads');
          const threads = payload.threads || settings.get('defaultThreads') || 8;
          let count = 0;
          for (const f of files) {
            if (f.type === 'share' && f.token && f.nodeId) {
              queue.addTask({
                kind: 'download',
                name: f.name,
                size: f.size || 0,
                source: { type: 'share', token: f.token, nodeId: f.nodeId },
                destPath: uniqueDest(path.join(destDir, f.name)),
                threads
              });
              count++;
            } else if (f.type === 'url' && f.url) {
              queue.addTask({
                kind: 'download',
                name: f.name,
                size: f.size || 0,
                source: { type: 'url', url: f.url, headers: f.headers || {} },
                destPath: uniqueDest(path.join(destDir, f.name)),
                threads
              });
              count++;
            } else if (f.type === 'file' && f.fileId) {
              queue.addTask({
                kind: 'download',
                name: f.name,
                size: f.size || 0,
                source: { type: 'file', fileId: f.fileId },
                destPath: uniqueDest(path.join(destDir, f.name)),
                threads
              });
              count++;
            }
          }
          return ok({ count });
        }

        /* ---------------- 同步 ---------------- */
        case 'sync:configure': { return ok(syncService.configure(payload.config || {})); }
        case 'sync:start': { return ok(await syncService.start()); }
        case 'sync:stop': { return ok(syncService.stop()); }
        case 'sync:status': { return ok(syncService.status()); }
        case 'sync:scanNow': { await syncService.scanNow(); return ok(syncService.status()); }

        /* ---------------- 设置 ---------------- */
        case 'settings:get': { return ok(settings.get(payload.key)); }
        case 'settings:set': {
          settings.set(payload.key, payload.value);
          // 限速立即应用到 aria2（若在运行）
          if (String(payload.key).startsWith('limitDown') && aria2Engine) {
            aria2Engine.applyLimit().catch(() => {});
          }
          return ok(settings.get());
        }

        /* ---------------- 应用 ---------------- */
        case 'app:pickDirectory': {
          const win = getWin();
          const r = await dialog.showOpenDialog(win, {
            title: payload.title || '选择目录',
            properties: ['openDirectory', 'createDirectory']
          });
          return ok({ path: r.canceled ? null : (r.filePaths[0] || null) });
        }
        case 'app:pickFile': {
          const win = getWin();
          const r = await dialog.showOpenDialog(win, {
            title: payload.title || '选择文件',
            properties: payload.multi ? ['openFile', 'multiSelections'] : ['openFile']
          });
          return ok({ paths: r.canceled ? [] : r.filePaths });
        }
        case 'app:openPath': {
          const err = await shell.openPath(String(payload.path || ''));
          if (err) throw { code: 'OPEN_FAILED', message: err };
          return ok(true);
        }
        case 'app:reveal': {
          // 打开目标所在目录（文件则选中）：目标不存在时逐级回退到最近的已存在路径。
          // 受限环境下 explorer/cmd 可能都无法启动：最终回退为「复制路径到剪贴板」，
          // 保证功能永远可用（用户可粘贴路径到资源管理器地址栏）。
          const target = String(payload.path || '');
          let p = target;
          while (p && !fs.existsSync(p)) {
            const par = path.dirname(p);
            if (par === p) break;
            p = par;
          }
          if (!p || !fs.existsSync(p)) {
            throw { code: 'PATH_MISSING', message: '目标路径不存在：' + (target || '(空)') };
          }
          let isDir = false;
          try { isDir = fs.statSync(p).isDirectory(); } catch (e) { isDir = false; }
          const openDir = isDir ? p : path.dirname(p);
          // 1) explorer 直接打开/选中
          try {
            if (isDir) spawn('explorer.exe', [p], { detached: true, stdio: 'ignore' }).unref();
            else spawn('explorer.exe', ['/select,', p], { detached: true, stdio: 'ignore' }).unref();
            return ok(true);
          } catch (e) { /* 继续降级 */ }
          // 2) cmd start（ShellExecute 路径）
          try {
            spawn('cmd.exe', ['/c', 'start', '', isDir ? p : ('/select,"' + p + '"')],
              { detached: true, stdio: 'ignore', windowsHide: true }).unref();
            return ok(true);
          } catch (e) { /* 继续降级 */ }
          // 3) Electron shell.openPath（返回错误串可感知）
          const err = await shell.openPath(openDir);
          if (!err) return ok(true);
          // 4) 最终兜底：复制路径，前端提示用户自行粘贴
          try { clipboard.writeText(openDir); } catch (e) { /* 忽略 */ }
          return ok({ fallback: true, path: openDir, err });
        }
        case 'app:copyText': {
          clipboard.writeText(String(payload.text || ''));
          return ok(true);
        }
        case 'app:version': { return ok(app.getVersion()); }
        case 'app:getState': {
          return ok({
            authed: api.hasToken(),
            user: api.getUser(),
            settings: settings.get(),
            version: app.getVersion()
          });
        }

        default:
          throw { code: 'INVALID_CHANNEL', message: '未知的 IPC 通道：' + channel };
      }
    } catch (e) {
      return fail(e);
    }
  });
}

module.exports = { init };
