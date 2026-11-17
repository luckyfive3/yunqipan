'use strict';
/**
 * transfer-queue.js —— 统一传输队列（上传 + 下载共用）
 *
 * 职责：
 *   1. 上传与下载共用一条任务队列；两类任务分别受 settings.maxUploadTasks /
 *      settings.maxDownloadTasks 并发限制，从 queued 中按 createdAt 顺序调度。
 *   2. 任务任何状态变更 → task-store 持久化 + 事件推送 wp:event
 *      {type:'transfer:update', payload:{task}}（内部字段剔除后再推送）。
 *   3. 速度统计：每任务维护 5 秒滑窗字节样本，速度 = 窗口内字节增量 / 时间增量；
 *      每秒心跳重算运行中任务速度并推送聚合 summary {downSpeed, upSpeed, running, queued, done}。
 *   4. 对外提供 add/pause/resume/cancel/retry/list/clearFinished/restore/updateTask，
 *      并向引擎注入 onProgress/onDone/onError/onPaused/onCanceled 回调；
 *      引擎完成/失败后自动调度下一条待办。
 */
const { EventEmitter } = require('events');
const crypto = require('crypto');

function createTransferQueue({ settings, taskStore, events }) {
  const tasks = new Map();          // id -> task
  const uploadPending = [];         // 待调度上传 id 队列
  const downloadPending = [];       // 待调度下载 id 队列
  let uploadRunning = 0;
  let downloadRunning = 0;
  let uploadEngine = null;
  let downloadEngine = null;
  const em = new EventEmitter();
  let heartbeat = null;

  /** 剥离内部字段（_samples 等）后推送/返回给渲染层。 */
  function publicTask(t) {
    const { _samples, _control, ...rest } = t;
    return rest;
  }

  function persist(t) {
    t.updatedAt = new Date().toISOString();
    taskStore.save(t);
    events.emit('transfer:update', { task: publicTask(t) });
  }

  /** 仅持久化并推送（引擎需要写入 uploadId 等扩展字段时使用），不改变状态。 */
  function updateTask(t) { persist(t); }

  function addTask(def) {
    const now = new Date().toISOString();
    const task = {
      id: def.id || crypto.randomUUID(),
      kind: def.kind,                    // 'upload' | 'download'
      status: 'queued',                  // queued|running|paused|done|error|canceled
      name: def.name,
      size: def.size || 0,
      done: def.done || 0,
      speed: 0,
      error: null,
      progress: 0,
      source: def.source,                // upload: {type:'local',...}; download: {type:'file'|'share'|'url',...}
      destPath: def.destPath,
      threads: def.threads || (settings.get('defaultThreads') || 8),
      encrypted: !!def.encrypted,
      createdAt: def.createdAt || now,
      updatedAt: now,
      _samples: []                       // [{t, d}] 5 秒滑窗
    };
    if (def.uploadId) task.uploadId = def.uploadId;
    tasks.set(task.id, task);
    persist(task);
    enqueue(task);
    return task;
  }

  function enqueue(task) {
    (task.kind === 'upload' ? uploadPending : downloadPending).push(task.id);
    schedule(task.kind);
  }

  function schedule(kind) {
    const max = kind === 'upload'
      ? (settings.get('maxUploadTasks') || 3)
      : (settings.get('maxDownloadTasks') || 3);
    let running = kind === 'upload' ? uploadRunning : downloadRunning;
    const pending = kind === 'upload' ? uploadPending : downloadPending;
    while (running < max && pending.length) {
      const id = pending.shift();
      const t = tasks.get(id);
      if (!t) continue;
      if (t.status !== 'queued') continue;
      t.status = 'running';
      t.error = null;
      t.speed = 0;
      t._samples = [];
      if (kind === 'upload') uploadRunning++; else downloadRunning++;
      running++; // 循环内必须同步递增，否则并发上限失效（一次性启动全部排队任务）
      persist(t);
      startTask(t);
    }
  }

  function startTask(t) {
    const engine = t.kind === 'upload' ? uploadEngine : downloadEngine;
    if (!engine) {
      finish(t, 'error', { code: 'INTERNAL', message: '传输引擎未初始化' });
      return;
    }
    const handlers = {
      onProgress: (totalDone) => recordProgress(t, totalDone),
      onDone: (result) => finish(t, 'done', null, result),
      onError: (err) => finish(t, 'error', err),
      onPaused: () => finish(t, 'paused', null),
      onCanceled: () => finish(t, 'canceled', null)
    };
    try {
      engine.start(t, handlers);
    } catch (e) {
      finish(t, 'error', { code: e.code || 'INTERNAL', message: e.message || String(e) });
    }
  }

  /** 终态统一收口：减并发计数、更新状态、持久化 + 推送、调度下一条。 */
  function finish(t, status, err, result) {
    if (t.kind === 'upload') uploadRunning = Math.max(0, uploadRunning - 1);
    else downloadRunning = Math.max(0, downloadRunning - 1);
    if (t.status === 'canceled') {
      // 用户已取消：引擎迟到的终态回调（如取消瞬间块恰好完成）只收口计数，不再改状态
      em.emit('task-final', t);
      schedule(t.kind);
      return;
    }
    if (status === 'paused' && t.status !== 'paused') {
      // 用户在引擎停稳前已点「继续」（状态已是 queued）：不覆盖状态，仅收口计数
      schedule(t.kind);
      return;
    }
    if (result && result.fileId) t.fileId = result.fileId;
    t.status = status;
    t.speed = 0;
    if (err) t.error = { code: err.code || 'UNKNOWN', message: err.message || String(err) };
    if (status === 'done') { t.done = t.size; t.progress = 100; }
    if (status !== 'running' && status !== 'queued' && status !== 'paused') t._samples = [];
    persist(t);
    em.emit('task-final', t);
    schedule(t.kind);
  }

  function recordProgress(t, totalDone) {
    const now = Date.now();
    t.done = Math.max(0, totalDone);
    t.progress = t.size > 0 ? Math.min(100, Math.round((t.done * 100) / t.size)) : 0;
    t._samples.push({ t: now, d: t.done });
    while (t._samples.length > 2 && now - t._samples[0].t > 5000) t._samples.shift();
    computeSpeed(t, now);
    persist(t);
  }

  function computeSpeed(t, now) {
    if (t._samples.length < 2) { t.speed = 0; return 0; }
    const a = t._samples[0];
    const b = t._samples[t._samples.length - 1];
    const dt = b.t - a.t;
    if (dt <= 0) { t.speed = 0; return 0; }
    t.speed = Math.max(0, Math.round(((b.d - a.d) * 1000) / dt));
    return t.speed;
  }

  // ---------------- 用户操作 ----------------

  function pause(id) {
    const t = tasks.get(id);
    if (!t) return;
    if (t.status === 'running') {
      // 立即置为 paused（引擎在块边界真正停稳后会再次回调 onPaused 收口并发计数）
      t.status = 'paused';
      persist(t);
      const engine = t.kind === 'upload' ? uploadEngine : downloadEngine;
      if (engine) engine.pause(t);
    } else if (t.status === 'queued') {
      t.status = 'paused';
      const pending = t.kind === 'upload' ? uploadPending : downloadPending;
      const i = pending.indexOf(t.id);
      if (i >= 0) pending.splice(i, 1);
      persist(t);
    }
  }

  function resume(id) {
    const t = tasks.get(id);
    if (!t) return;
    if (t.status === 'paused' || t.status === 'error') {
      t.status = 'queued';
      t.error = null;
      t._samples = [];
      persist(t);
      enqueue(t);
    }
  }

  function cancel(id) {
    const t = tasks.get(id);
    if (!t) return;
    if (t.status === 'queued') {
      const pending = t.kind === 'upload' ? uploadPending : downloadPending;
      const i = pending.indexOf(t.id);
      if (i >= 0) pending.splice(i, 1);
      t.status = 'canceled';
      persist(t);
      em.emit('task-final', t);
      return;
    }
    if (t.status === 'running' || t.status === 'paused' || t.status === 'error') {
      t.status = 'canceled';
      persist(t);
      const engine = t.kind === 'upload' ? uploadEngine : downloadEngine;
      if (engine) engine.cancel(t);
    }
  }

  function retry(id) {
    const t = tasks.get(id);
    if (!t) return;
    if (t.status === 'error') {
      t.status = 'queued';
      t.error = null;
      t._samples = [];
      persist(t);
      enqueue(t);
    }
  }

  // ---------------- 查询 ----------------

  function list(kind) {
    let arr = [...tasks.values()].map(publicTask);
    if (kind) arr = arr.filter(t => t.kind === kind);
    return arr.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  function summary() {
    let downSpeed = 0, upSpeed = 0, running = 0, queued = 0, done = 0;
    for (const t of tasks.values()) {
      if (t.status === 'running') {
        running++;
        if (t.kind === 'download') downSpeed += t.speed || 0;
        else upSpeed += t.speed || 0;
      } else if (t.status === 'queued') queued++;
      else if (t.status === 'done') done++;
    }
    return { downSpeed, upSpeed, running, queued, done };
  }

  function clearFinished() {
    for (const t of [...tasks.values()]) {
      if (t.status === 'done' || t.status === 'error' || t.status === 'canceled') {
        tasks.delete(t.id);
        taskStore.remove(t.id);
      }
    }
  }

  // ---------------- 生命周期 ----------------

  function attachEngines(up, down) { uploadEngine = up; downloadEngine = down; }

  function startHeartbeat() {
    if (heartbeat) return;
    heartbeat = setInterval(() => {
      const now = Date.now();
      for (const t of tasks.values()) {
        if (t.status !== 'running') continue;
        computeSpeed(t, now);
        events.emit('transfer:update', { task: publicTask(t) });
      }
      events.emit('transfers:summary', { summary: summary() });
    }, 1000);
  }

  function stopHeartbeat() {
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
  }

  /**
   * 启动恢复：
   *  - 所有 running 任务统一降级为 paused（进程退出时不可能仍在传输）；
   *  - settings.autoResume 为 true 时，把 paused/queued 任务重新入队自动继续
   *    （上传按 upload_id 续传，下载按 .wpdl.json / .aria2 控制文件续传）。
   */
  function restore(arr, autoResume) {
    for (const raw of arr || []) {
      const t = Object.assign({}, raw);
      if (t.status === 'running') t.status = 'paused';
      // 未开启自动继续时，排队中的任务也降为 paused，便于用户手动「继续」
      if (!autoResume && t.status === 'queued') t.status = 'paused';
      t.speed = 0;
      t._samples = [];
      if (t.error && typeof t.error === 'string') t.error = { code: 'UNKNOWN', message: t.error };
      tasks.set(t.id, t);
      if (autoResume && (t.status === 'paused' || t.status === 'queued')) {
        t.status = 'queued';
        persist(t);
        enqueue(t);
      } else {
        persist(t);
      }
    }
  }

  function onTaskFinal(fn) { em.on('task-final', fn); }

  return {
    addTask, updateTask, pause, resume, cancel, retry,
    list, summary, clearFinished, restore,
    attachEngines, startHeartbeat, stopHeartbeat,
    get: (id) => tasks.get(id) || null,
    onTaskFinal
  };
}

module.exports = { createTransferQueue };
