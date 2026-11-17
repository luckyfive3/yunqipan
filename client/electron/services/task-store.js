'use strict';
/**
 * task-store.js —— 任务持久化存储
 *
 * 职责：
 *   1. 读写 userData/tasks.json（上传/下载任务全量快照）。
 *   2. 任何任务变更调用 save(task) 后防抖 500ms 原子写盘（tmp + rename），避免高频磁盘抖动。
 *   3. 提供 all/get/save/remove/flushNow/flushSync，供传输队列与 main.js 的
 *      启动恢复（running→paused、autoResume 自动继续）与退出持久化使用。
 */
const fs = require('fs');
const path = require('path');

function createTaskStore({ userDataDir }) {
  const file = path.join(userDataDir, 'tasks.json');
  const tasks = new Map();
  let dirty = false;
  let timer = null;

  function schedule() {
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => { timer = null; flushNow().catch(() => {}); }, 500);
  }

  /** 启动时加载全部历史任务。 */
  async function load() {
    try {
      const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(arr)) {
        for (const t of arr) if (t && t.id) tasks.set(String(t.id), t);
      }
    } catch (e) { /* 无历史任务或文件损坏 */ }
  }

  async function flushNow() {
    if (!dirty) return;
    dirty = false;
    const tmp = file + '.tmp';
    await fs.promises.writeFile(tmp, JSON.stringify([...tasks.values()]), 'utf8');
    await fs.promises.rename(tmp, file);
  }

  /** 退出前同步落盘（quit 流程中不允许再等异步）。 */
  function flushSync() {
    if (!dirty) return;
    dirty = false;
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify([...tasks.values()]), 'utf8');
    try { fs.renameSync(tmp, file); } catch (e) { fs.copyFileSync(tmp, file); }
  }

  function save(task) {
    task.updatedAt = new Date().toISOString();
    tasks.set(String(task.id), task);
    schedule();
  }

  function remove(id) { tasks.delete(String(id)); schedule(); }
  function get(id) { return tasks.get(String(id)) || null; }
  function all() { return [...tasks.values()]; }

  return { load, flushNow, flushSync, save, remove, get, all, file };
}

module.exports = { createTaskStore };
