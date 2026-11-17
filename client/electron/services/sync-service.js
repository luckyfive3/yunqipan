'use strict';
/**
 * sync-service.js —— 双向同步服务
 *
 * 职责：
 *   1. 状态：{running, lastScan, lastError, pending, events:最近20条}，变化即推送 'sync:status'。
 *   2. 本地监听：fs.watch(localRoot, {recursive:true})。
 *      【平台差异注释】macOS（FSEvents/kqueue）与 Windows（ReadDirectoryChangesW）的 Node
 *      实现均支持 recursive:true；Linux 上 libuv 不支持递归监听，且任何平台都可能因
 *      句柄耗尽/网络盘等触发 'error' 事件——因此统一实现“异常回退”：watch 出错或不可用时
 *      自动切换为 3 秒轮询快照 {mtimeMs, size}，行为一致。
 *   3. 远端：每 intervalSec 拉取 GET /files/tree（扁平数组，客户端按 parent_id 组相对路径）。
 *   4. 索引：userData/sync-index.json，{localPath → {remoteId, localMtime, remoteMtime, size}}。
 *   5. 变更处理：
 *      - 本地新增/变更 → 上传任务（3 秒内同路径去重合并）；
 *      - 远端新增/变更 → 下载任务到 localRoot 对应相对路径；
 *      - 删除传播：本地删除 → DELETE /files/{remoteId}；远端删除 → 删本地
 *        （mode='twoway' 时双向传播；'up' 只推不拉删除，'down' 反向）；
 *      - 冲突：两侧 mtime 都比索引新 → 本地文件改名 " (conflict yyyyMMdd-HHmmss)" 后下载远端版；
 *      - exclude 支持 * 通配符。
 *   6. 【首次全量对齐策略】本地有远端无 → 上传；远端有本地无 → 下载；
 *      两侧均有（新索引）：大小相同且 mtime 差 < 2s 视为同一版本，仅登记索引不传输；
 *      否则按冲突处理（保留本地副本 + 下载远端版），保证不丢数据。
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const TEMP_SUFFIX = ['.wpdl.json', '.part', '.aria2', '.wpenc'];

function wildcardToRegex(pattern) {
  const esc = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + esc + '$');
}

function createSyncService({ settings, api, queue, events, userDataDir }) {
  const indexFile = path.join(userDataDir, 'sync-index.json');
  const state = { running: false, lastScan: null, lastError: null, pending: 0, events: [] };
  let index = {};                    // localPath -> {remoteId, localMtime, remoteMtime, size}
  let watcher = null;
  let remoteTimer = null;
  let localTimer = null;
  let watchOk = false;               // watch 模式是否健康（异常回退轮询）
  let scanning = false;
  const pendingOps = new Map();      // relPath -> {op, timer}  3 秒去重合并
  const inflight = new Set();        // 正在传输的相对路径（防误判删除）
  let remoteTree = [];               // 最近一次远端树（本地扫描时用于解析父目录 id）

  function log(type, message) {
    state.events.unshift({ time: new Date().toISOString(), type, message });
    if (state.events.length > 20) state.events.length = 20;
    emitStatus();
  }

  function emitStatus() {
    events.emit('sync:status', {
      running: state.running,
      lastScan: state.lastScan,
      lastError: state.lastError,
      pending: state.pending,
      events: state.events.slice(0, 20)
    });
  }

  async function loadIndex() {
    try { index = JSON.parse(await fsp.readFile(indexFile, 'utf8')) || {}; }
    catch (e) { index = {}; }
  }

  let saveTimer = null;
  function saveIndex() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      const tmp = indexFile + '.tmp';
      fsp.writeFile(tmp, JSON.stringify(index, null, 2), 'utf8')
        .then(() => fsp.rename(tmp, indexFile))
        .catch(() => {});
    }, 1000);
  }

  function cfg() { return settings.get('sync') || {}; }

  function isExcluded(relPath) {
    const exclude = cfg().exclude || [];
    const norm = relPath.replace(/\\/g, '/');
    for (const p of exclude) {
      const pat = String(p).replace(/\\/g, '/');
      try {
        if (wildcardToRegex(pat).test(norm) || wildcardToRegex(pat).test(norm.split('/').pop())) return true;
      } catch (e) { /* 非法表达式忽略 */ }
    }
    return false;
  }

  function isTempFile(name) {
    return TEMP_SUFFIX.some((s) => name.endsWith(s));
  }

  /* ---------------- 本地快照 ---------------- */
  async function walkDir(dir, base, out) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
    catch (e) { return; }
    for (const ent of entries) {
      const rel = base ? base + '/' + ent.name : ent.name;
      const abs = path.join(dir, ent.name);
      if (isExcluded(rel)) continue;
      try {
        if (ent.isDirectory()) {
          await walkDir(abs, rel, out);
        } else if (ent.isFile() && !isTempFile(ent.name)) {
          const st = await fsp.stat(abs);
          out[rel] = { mtimeMs: st.mtimeMs, size: st.size };
        }
      } catch (e) { /* 文件被并发删除 */ }
    }
  }

  function localRoot() {
    const root = cfg().localRoot;
    if (!root) throw { code: 'INVALID_INPUT', message: '请先在同步页选择本地同步目录' };
    return root;
  }

  /* ---------------- 远端树 → 相对路径 ---------------- */
  function buildRemoteMaps(items) {
    const byId = new Map();
    for (const it of items || []) byId.set(it.id, it);
    const dirs = new Map(); // relPath(目录) -> id
    const files = new Map(); // relPath(文件) -> node
    const resolvePath = (id) => {
      const chain = [];
      let cur = byId.get(id);
      let guard = 0;
      while (cur && cur.parent_id && guard++ < 64) {
        chain.unshift(cur.name);
        cur = byId.get(cur.parent_id);
      }
      return chain.join('/');
    };
    for (const it of items || []) {
      let rel;
      try { rel = resolvePath(it.id); } catch (e) { continue; }
      if (it.is_dir) dirs.set(rel, it.id);
      else files.set(rel, it);
    }
    return { dirs, files };
  }

  /** 相对路径（含父目录）→ 远端目录 id。 */
  function remoteDirIdOf(relPath, dirs) {
    const parts = relPath.split('/');
    parts.pop();
    if (!parts.length) return cfg().remoteRootId ?? null;
    const hit = (dirs && typeof dirs.get === 'function') ? dirs.get(parts.join('/')) : undefined;
    return hit !== undefined ? hit : (cfg().remoteRootId ?? null);
  }

  /* ---------------- 本地侧变更 ---------------- */
  function scheduleUpload(relPath, mtimeMs, size, dirs) {
    const key = 'u:' + relPath;
    const prev = pendingOps.get(key);
    if (prev) clearTimeout(prev.timer);
    state.pending++;
    emitStatus();
    const timer = setTimeout(async () => {
      pendingOps.delete(key);
      try {
        const abs = path.join(localRoot(), relPath);
        await fsp.mkdir(path.dirname(abs), { recursive: true });
        const st = await fsp.stat(abs).catch(() => null);
        if (!st) return; // 3 秒内已被删除，交由删除传播处理
        inflight.add(relPath); // 任务终态时由 task-final 回调移除，防止扫描误判删除
        const def = await uploadManagerCreateTask(relPath, abs, st, dirs);
        queue.addTask(def);
        index[relPath] = {
          remoteId: index[relPath] ? index[relPath].remoteId : null,
          localMtime: st.mtimeMs,
          remoteMtime: index[relPath] ? index[relPath].remoteMtime : null,
          size: st.size
        };
        saveIndex();
        log('upload', '已加入上传队列：' + relPath);
      } catch (e) {
        log('error', '上传调度失败 ' + relPath + '：' + e.message);
      } finally {
        state.pending = Math.max(0, state.pending - 1);
        emitStatus();
      }
    }, 3000);
    pendingOps.set(key, { op: 'upload', timer });
  }

  async function uploadManagerCreateTask(relPath, abs, st, dirs) {
    const parentId = remoteDirIdOf(relPath, dirs);
    const name = path.basename(relPath);
    return {
      kind: 'upload',
      name,
      size: st.size,
      source: { type: 'local', localPath: abs, parentId, mime: require('./upload-manager').inferMime(name) },
      destPath: abs,
      encrypted: !!settings.get('e2eDefault')
    };
  }

  async function localScan() {
    const root = localRoot();
    const snapshot = {};
    await walkDir(root, '', snapshot);
    const rels = new Set(Object.keys(snapshot));

    // 1) 本地新增/变更 → 上传
    for (const [rel, st] of Object.entries(snapshot)) {
      const rec = index[rel];
      if (!rec || !rec.remoteId) {
        if (!rec || st.mtimeMs > (rec.localMtime || 0) + 1000 || st.size !== (rec.size ?? -1)) {
          if (!inflight.has(rel) && !pendingOps.has('u:' + rel)) scheduleUpload(rel, st.mtimeMs, st.size, remoteTree.dirs || {});
        }
      } else if (st.mtimeMs > (rec.localMtime || 0) + 1000 && !inflight.has(rel) && !pendingOps.has('u:' + rel)) {
        scheduleUpload(rel, st.mtimeMs, st.size, remoteTree.dirs || {});
      }
    }

    // 2) 本地删除 → 远端删除（twoway 双向；'up' 只推删除到远端）
    const mode = cfg().mode;
    if (mode === 'twoway' || mode === 'up') {
      for (const [rel, rec] of Object.entries(index)) {
        if (rels.has(rel) || inflight.has(rel) || pendingOps.has('u:' + rel)) continue;
        if (!rec.remoteId) { delete index[rel]; saveIndex(); continue; }
        try {
          await api.del('/api/v1/files/' + encodeURIComponent(rec.remoteId) + '?recursive=true');
          delete index[rel];
          saveIndex();
          log('delete-remote', '已删除远端文件：' + rel);
        } catch (e) {
          log('error', '远端删除失败 ' + rel + '：' + e.message);
        }
      }
    }
  }

  /* ---------------- 远端侧变更 ---------------- */
  function scheduleDownload(relPath, node) {
    const key = 'd:' + relPath;
    const prev = pendingOps.get(key);
    if (prev) clearTimeout(prev.timer);
    state.pending++;
    emitStatus();
    const timer = setTimeout(() => {
      pendingOps.delete(key);
      try {
        inflight.add(relPath); // 任务终态时由 task-final 回调移除
        const dest = path.join(localRoot(), relPath);
        queue.addTask({
          kind: 'download',
          name: path.basename(relPath),
          size: node.size || 0,
          source: { type: 'file', fileId: node.id },
          destPath: dest,
          threads: settings.get('defaultThreads') || 8
        });
        index[relPath] = {
          remoteId: node.id,
          localMtime: index[relPath] ? index[relPath].localMtime : Date.parse(node.updated_at || 0) || Date.now(),
          remoteMtime: Date.parse(node.updated_at || 0) || Date.now(),
          size: node.size || 0
        };
        saveIndex();
        log('download', '已加入下载队列：' + relPath);
      } catch (e) {
        log('error', '下载调度失败 ' + relPath + '：' + e.message);
      } finally {
        state.pending = Math.max(0, state.pending - 1);
        emitStatus();
      }
    }, 3000);
    pendingOps.set(key, { op: 'download', timer });
  }

  async function handleConflict(relPath, node) {
    const abs = path.join(localRoot(), relPath);
    const ts = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = '' + ts.getFullYear() + pad(ts.getMonth() + 1) + pad(ts.getDate()) + '-' +
      pad(ts.getHours()) + pad(ts.getMinutes()) + pad(ts.getSeconds());
    const ext = path.extname(relPath);
    const base = relPath.slice(0, relPath.length - ext.length);
    const conflictRel = base + ' (conflict ' + stamp + ')' + ext;
    try {
      await fsp.rename(abs, path.join(localRoot(), conflictRel));
      log('conflict', '发现冲突：本地版本已保留为 "' + conflictRel + '"，将下载远端版本');
      // 本地改名副本与远端的新版本按“首次对齐”规则下一轮处理
      index[conflictRel] = { remoteId: null, localMtime: Date.now(), remoteMtime: null, size: (await fsp.stat(path.join(localRoot(), conflictRel))).size };
    } catch (e) {
      log('error', '冲突改名失败 ' + relPath + '：' + e.message);
    }
    scheduleDownload(relPath, node);
  }

  async function remoteScan() {
    const mode = cfg().mode;
    let items;
    try {
      const d = await api.get('/api/v1/files/tree');
      items = d.items || [];
    } catch (e) {
      state.lastError = e.message || '远端树拉取失败';
      log('error', '远端树拉取失败：' + state.lastError);
      emitStatus();
      return;
    }
    remoteTree = buildRemoteMaps(items);
    const remoteFiles = remoteTree.files;
    const remoteIds = new Set();
    for (const [rel, node] of remoteFiles) remoteIds.add(node.id);

    // 1) 远端新增/变更 → 下载
    for (const [rel, node] of remoteFiles) {
      if (isExcluded(rel)) continue;
      const remoteMtime = Date.parse(node.updated_at || 0) || 0;
      const rec = index[rel];
      let localSt = null;
      try { localSt = await fsp.stat(path.join(localRoot(), rel)); } catch (e) { /* 本地无此文件 */ }
      if (!rec) {
        if (localSt) {
          // 两侧均有（首次对齐）：大小相同且 mtime 接近 → 仅登记；否则冲突
          if (localSt.size === node.size && Math.abs(localSt.mtimeMs - remoteMtime) < 2000) {
            index[rel] = { remoteId: node.id, localMtime: localSt.mtimeMs, remoteMtime, size: node.size };
            saveIndex();
          } else if (localSt.mtimeMs > remoteMtime) {
            // 本地更新 → 上传覆盖
            if (!pendingOps.has('u:' + rel)) scheduleUpload(rel, localSt.mtimeMs, localSt.size, remoteTree.dirs);
          } else {
            await handleConflict(rel, node);
          }
        } else {
          if (!pendingOps.has('d:' + rel)) scheduleDownload(rel, node);
        }
      } else if (rec.remoteId !== node.id) {
        // 远端对象替换（如删除后重建）
        if (!pendingOps.has('d:' + rel)) scheduleDownload(rel, node);
      } else if (remoteMtime > (rec.remoteMtime || 0) + 1000) {
        if (localSt && localSt.mtimeMs > (rec.localMtime || 0) + 1000) {
          await handleConflict(rel, node); // 两侧都新 → 冲突
        } else if (!pendingOps.has('d:' + rel)) {
          scheduleDownload(rel, node);
        }
      }
    }

    // 2) 远端删除 → 删本地（twoway 双向；'down' 只拉删除到本地）
    if (mode === 'twoway' || mode === 'down') {
      for (const [rel, rec] of Object.entries(index)) {
        if (!rec.remoteId || remoteIds.has(rec.remoteId)) continue;
        if (inflight.has(rel)) continue;
        try {
          await fsp.unlink(path.join(localRoot(), rel));
          delete index[rel];
          saveIndex();
          log('delete-local', '已删除本地文件（远端已删除）：' + rel);
        } catch (e) {
          delete index[rel];
          saveIndex();
        }
      }
    }
  }

  async function scanNow() {
    if (scanning) return;
    scanning = true;
    try {
      await localScan();
      await remoteScan();
      state.lastScan = new Date().toISOString();
      state.lastError = null;
      emitStatus();
    } catch (e) {
      state.lastError = e.message || String(e);
      log('error', '扫描失败：' + state.lastError);
    } finally {
      scanning = false;
    }
  }

  /* ---------------- 监听与生命周期 ---------------- */
  function startLocalWatch() {
    const root = localRoot();
    stopLocalWatch();
    watchOk = true;
    try {
      watcher = fs.watch(root, { recursive: true }, () => {
        // 变更去抖：500ms 后做一次本地扫描（watch 只给信号，快照比对做决策）
        if (localTimer) clearTimeout(localTimer);
        localTimer = setTimeout(() => localScan().catch((e) => {
          state.lastError = e.message; log('error', '本地扫描失败：' + e.message);
        }), 500);
      });
      watcher.on('error', () => {
        // watch 异常（句柄耗尽、网络盘、平台不支持递归等）→ 回退 3 秒轮询
        if (watchOk) { watchOk = false; log('warn', '本地监听异常，已回退为 3 秒轮询快照'); }
        try { watcher.close(); } catch (e) { /* 忽略 */ }
        watcher = null;
        if (localTimer) clearInterval(localTimer);
        localTimer = setInterval(() => localScan().catch(() => {}), 3000);
      });
    } catch (e) {
      watchOk = false;
      watcher = null;
      localTimer = setInterval(() => localScan().catch(() => {}), 3000);
      log('warn', '当前平台不支持递归监听，使用 3 秒轮询快照');
    }
  }

  function stopLocalWatch() {
    if (localTimer) { clearTimeout(localTimer); clearInterval(localTimer); localTimer = null; }
    if (watcher) { try { watcher.close(); } catch (e) { /* 忽略 */ } watcher = null; }
  }

  function configure(next) {
    const c = Object.assign({}, cfg(), next);
    settings.set('sync', c);
    if (state.running) {
      stop();
      if (c.enabled) start().catch((e) => log('error', '同步重启失败：' + e.message));
    }
    return cfg();
  }

  async function start() {
    const c = cfg();
    if (state.running) return state;
    if (!c.localRoot) throw { code: 'INVALID_INPUT', message: '请先选择本地同步目录' };
    await fsp.mkdir(c.localRoot, { recursive: true });
    await loadIndex();
    state.running = true;
    startLocalWatch();
    remoteTimer = setInterval(() => remoteScan().catch(() => {}), Math.max(5, c.intervalSec || 30) * 1000);
    emitStatus();
    log('info', '同步已启动：' + c.localRoot + '（模式：' + c.mode + '）');
    await scanNow();
    return state;
  }

  function stop() {
    if (!state.running) return state;
    state.running = false;
    stopLocalWatch();
    if (remoteTimer) { clearInterval(remoteTimer); remoteTimer = null; }
    for (const [, p] of pendingOps) clearTimeout(p.timer);
    pendingOps.clear();
    state.pending = 0;
    log('info', '同步已停止');
    emitStatus();
    return state;
  }

  /** 传输任务终态回调：上传完成回填 remoteId，下载完成回填本地 mtime；失败则重置时间戳以便下一轮重试。 */
  queue.onTaskFinal((task) => {
    try {
      const root = cfg().localRoot;
      if (!root) return;
      if (task.kind === 'upload' && task.source && task.source.type === 'local') {
        const rel = path.relative(root, task.source.localPath);
        if (!rel || rel.startsWith('..')) return;
        if (task.status === 'done' && task.fileId && index[rel]) {
          index[rel].remoteId = task.fileId;
          index[rel].remoteMtime = Date.now();
          saveIndex();
        } else if (task.status === 'error' && index[rel]) {
          index[rel].localMtime = 0; // 下一轮扫描重新调度
          saveIndex();
        }
        inflight.delete(rel);
      } else if (task.kind === 'download' && task.source && task.source.type === 'file' && task.destPath) {
        const rel = path.relative(root, task.destPath);
        if (!rel || rel.startsWith('..')) return;
        inflight.delete(rel);
        if (task.status === 'done') {
          fsp.stat(task.destPath).then((st) => {
            if (index[rel]) {
              index[rel].localMtime = st.mtimeMs;
              index[rel].size = st.size;
              saveIndex();
            }
          }).catch(() => {});
        } else if (task.status === 'error' && index[rel]) {
          index[rel].remoteMtime = 0; // 下一轮扫描重新调度
          saveIndex();
        }
      }
    } catch (e) { /* 忽略 */ }
  });

  return { start, stop, configure, scanNow, status: () => Object.assign({}, state, { events: state.events.slice(0, 20) }), loadIndex };
}

module.exports = { createSyncService };
