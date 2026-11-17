'use strict';
/**
 * events.js —— 主进程事件总线（状态变化向渲染层推送的唯一出口）
 *
 * 职责：
 *   1. 统一出口 emit(type, payload)；所有主进程状态变化（任务进度、同步状态、
 *      认证变化等）都必须经这里推送为 wp:event {type, payload}。
 *   2. 200ms 节流：事件先入队，定时批量经 webContents.send('wp:event', ...) 发送；
 *      单条发对象、多条发数组，由 preload 拆包后分发给渲染层订阅者（wp.on）。
 *   3. 同时支持主进程内部订阅 on/off（供同步服务等本地消费），不影响渲染层推送。
 */
let getWindows = () => [];
let queue = [];
let timer = null;
const local = new Map(); // type -> Set<cb>

/** main.js 注入窗口获取函数（通常是 () => BrowserWindow.getAllWindows()）。 */
function init(winGetter) { getWindows = winGetter; }

function on(type, cb) {
  if (!local.has(type)) local.set(type, new Set());
  local.get(type).add(cb);
}

function off(type, cb) {
  const s = local.get(type);
  if (s) s.delete(cb);
}

function emit(type, payload) {
  queue.push({ type, payload });
  // 主进程内部订阅者立即同步通知
  const subs = [...(local.get(type) || []), ...(local.get('*') || [])];
  for (const cb of subs) {
    try { cb(payload, type); } catch (e) { /* 本地订阅异常不影响推送 */ }
  }
  if (timer) return;
  timer = setTimeout(flush, 200);
}

function flush() {
  timer = null;
  if (!queue.length) return;
  const batch = queue;
  queue = [];
  const msg = batch.length === 1 ? batch[0] : batch;
  for (const win of getWindows()) {
    if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
      try { win.webContents.send('wp:event', msg); } catch (e) { /* 窗口销毁竞态 */ }
    }
  }
}

module.exports = { init, on, off, emit, flush };
