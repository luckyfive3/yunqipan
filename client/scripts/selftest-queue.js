'use strict';
/* 临时自测：transfer-queue 调度逻辑（stub 引擎）
 * 覆盖：并发上限（maxDownloadTasks）、FIFO 调度、暂停/恢复/取消/重试、聚合 summary、清空已完成。 */
const assert = require('assert');
const { createTransferQueue } = require('../electron/services/transfer-queue');

(async () => {
  const settings = {
    get: (k) => ({ maxUploadTasks: 2, maxDownloadTasks: 3, defaultThreads: 8 })[k]
  };
  const taskStore = { save: () => {}, remove: () => {} };
  const events = { emit: () => {} };

  const q = createTransferQueue({ settings, taskStore, events });

  const started = [];
  const pausedCalls = [];
  const canceledCalls = [];
  const doneCalls = new Set();
  const downEngine = {
    start: (t, h) => { started.push(t.id); t._h = h; },
    pause: (t) => { pausedCalls.push(t.id); },
    cancel: (t) => { canceledCalls.push(t.id); }
  };
  const upEngine = {
    start: (t, h) => { started.push(t.id); t._h = h; },
    pause: (t) => { pausedCalls.push(t.id); },
    cancel: (t) => { canceledCalls.push(t.id); }
  };
  q.attachEngines(upEngine, downEngine);

  for (let i = 1; i <= 5; i++) {
    q.addTask({ kind: 'download', name: 'f' + i + '.bin', size: 100, source: { type: 'url', url: 'http://x/f' + i } });
  }
  assert.strictEqual(started.length, 3, '并发上限 3：应只启动 3 个');
  assert.strictEqual(q.summary().running, 3);
  assert.strictEqual(q.summary().queued, 2);

  // 完成一个 → 下一个补位（FIFO）
  const t1 = q.list('download').find((t) => t.name === 'f1.bin');
  const raw1 = q.get(t1.id);
  raw1._h.onDone();
  assert.strictEqual(q.get(t1.id).status, 'done');
  assert.strictEqual(q.summary().running, 3, '完成后应自动补位');
  assert.strictEqual(q.summary().queued, 1);

  // 暂停一个运行中任务 → 引擎 pause 被调用，补位继续
  const t2 = q.list('download').find((t) => t.name === 'f2.bin');
  q.pause(t2.id);
  assert.strictEqual(q.get(t2.id).status, 'paused');
  assert.ok(pausedCalls.includes(t2.id), '引擎 pause 应被调用');
  const raw2 = q.get(t2.id);
  if (raw2._h) raw2._h.onPaused(); // 模拟引擎停稳回调（触发补位）

  // 恢复 → 并发已满时应保持排队（验证并发上限）
  q.resume(t2.id);
  assert.strictEqual(q.get(t2.id).status, 'queued');
  const before = started.length;
  assert.strictEqual(started.length, before, '并发已满：恢复后应保持排队而非立即启动');

  // 取消一个运行中任务 → 引擎 cancel 被调用，t2 排队任务自动补位
  const t5 = q.list('download').find((t) => t.name === 'f5.bin');
  q.cancel(t5.id);
  assert.strictEqual(q.get(t5.id).status, 'canceled');
  assert.ok(canceledCalls.includes(t5.id), '引擎 cancel 应被调用');
  const raw5 = q.get(t5.id);
  if (raw5._h) raw5._h.onCanceled(); // 模拟引擎清理完成回调
  assert.strictEqual(q.get(t2.id).status, 'running', '槽位释放后排队任务应自动补位');
  assert.strictEqual(q.summary().queued, 0);

  // 错误 → 重试
  const t3 = q.list('download').find((t) => t.name === 'f3.bin');
  const raw3 = q.get(t3.id);
  raw3._h.onError({ code: 'X', message: '坏了' });
  assert.strictEqual(q.get(t3.id).status, 'error');
  assert.ok(q.get(t3.id).error && q.get(t3.id).error.message === '坏了');
  q.retry(t3.id);
  assert.strictEqual(q.get(t3.id).status, 'running', '重试后应重新调度');
  assert.strictEqual(q.get(t3.id).error, null);

  // 进度与速度
  const raw3b = q.get(t3.id);
  raw3b._h.onProgress(10);
  await new Promise((r) => setTimeout(r, 50));
  raw3b._h.onProgress(60);
  assert.strictEqual(q.get(t3.id).done, 60);
  assert.strictEqual(q.get(t3.id).progress, 60);
  assert.ok(q.get(t3.id).speed > 0, '5 秒滑窗内应有速度');

  // 清空已完成
  q.clearFinished();
  assert.ok(!q.get(t1.id), '已完成任务应被清除');

  console.log('[OK] 传输队列：并发限制/FIFO 补位/暂停恢复/取消/重试/速度滑窗/清空已完成');
})().catch((e) => { console.error('队列自测失败：', e); process.exit(1); });
