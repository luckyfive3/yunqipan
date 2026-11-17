'use strict';
/**
 * native-downloader.js —— 自研多线程分块下载内核（本项目核心）
 *
 * 职责：
 *   1. 探针：HEAD（失败则 GET Range: bytes=0-0）获取 Content-Length / Accept-Ranges / ETag / Last-Modified。
 *   2. 多线程分块：线程数 t = min(threads, ceil(size/1MiB))，块大小 = ceil(size/t) 并按 64KiB 对齐；
 *      不支持 Range 时降级单线程顺序下载到 .part 再改名。
 *   3. 断点续传：控制文件 <dest>.wpdl.json 记录每块已写偏移，暂停/崩溃后只下未完成块。
 *   4. 动态自适应调度：5 秒采样各活动块速度，慢块（< 中位数 30% 且持续两个采样周期）
 *      剩余区间一分为二交给空闲线程，同一块最多分裂 3 次。
 *   5. 暂停（AbortController 逐线程中止并等待退出）、完成校验（总大小 + 可选 sha256 流式）、
 *      单块失败重试 3 次指数退避（0.5/1/2s），连续失败 3 块判任务 error（保留控制文件可 retry）。
 *
 * 安全约束：本模块只使用 node:http/https 发请求，支持自定义 headers（UA/Referer/Bearer 等），
 * 绝不携带任何 Cookie 凭据（构造函数强制剔除 Cookie 头）。
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');

const KI64 = 64 * 1024;
const MI1 = 1024 * 1024;
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) YunQiPan-Client/1.0';
const SAMPLE_MS = 5000;                 // 动态调度采样周期
const RETRY_BACKOFF = [500, 1000, 2000]; // 单块重试指数退避
const MAX_SPLITS = 3;                   // 同一块最多分裂次数（防抖动）
const MAX_CHUNK_FAIL_STREAK = 3;        // 连续失败块数阈值
const MAX_REDIRECTS = 3;

function controlFile(dest) { return dest + '.wpdl.json'; }
function partFile(dest) { return dest + '.part'; }
function pickRequestor(u) { return u.startsWith('https:') ? https : http; }

async function atomicWrite(file, data) {
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, file);
}

/* =====================================================================================
 * 分块策略（大段注释，说明原理）
 * -------------------------------------------------------------------------------------
 * 目标：在「线程开销」与「并行度」之间取平衡。
 *   - 线程数 t：不能超过用户设置（settings.defaultThreads / 每任务 threads），也不能超过
 *     文件本身的分块需求，因此 t = min(threads, ceil(size/1MiB))——小于 1MiB 的文件只开
 *     一个线程，避免无谓的开销。
 *   - 块大小：先按 ceil(size/t) 均分，再向上对齐到 64KiB。对齐的原因：
 *       a) 64KiB 是常见磁盘/网络缓冲边界，位置对齐后 fs.write(position) 落盘更高效；
 *       b) 服务端 Range 按字节精确切片，块边界对齐不影响正确性，只是减少碎块。
 *   - 最后一块自然收尾到 size-1（不足一块也单独作为一块）。
 *   - 不支持 Range（Accept-Ranges 缺失或探针失败且无法分段）时降级为单线程顺序下载：
 *     顺序写 .part，完成后 rename 为最终文件，兼容所有直链服务器。
 * ===================================================================================== */
function buildChunks(size, threads) {
  const t = Math.min(threads, Math.max(1, Math.ceil(size / MI1)));
  const raw = Math.ceil(size / t);
  const cs = Math.ceil(raw / KI64) * KI64;
  const chunks = [];
  for (let s = 0; s < size; s += cs) {
    chunks.push({ start: s, end: Math.min(s + cs, size) - 1, done: 0, splits: 0 });
  }
  return { chunkSize: cs, chunks };
}

class NativeDownload {
  constructor({ url, headers, destPath, threads, expectedSha256, baseDone }) {
    this.url = url;
    // 请求头全部由任务来源显式提供：云栖盘/公开直链无凭据；
    // cURL 导入场景下 Referer/Cookie 为用户自有登录会话凭据，仅用于本次下载。
    this.headers = Object.assign({}, headers || {});
    this.destPath = destPath;
    this.threads = Math.max(1, Math.min(threads || 8, 32));
    this.expectedSha256 = expectedSha256 || null;
    this.baseDone = baseDone || 0;
    this.totalDone = 0;                 // 本次会话新下载字节数
    this.size = null;
    this.etag = null;
    this.lastModified = null;
    this.acceptRanges = false;
    this.sequential = false;
    this.chunkSize = null;
    this.chunks = [];                   // [{start,end,done,splits}] start 会随断点推进
    this.pending = [];                  // 待下载块（对象引用）
    this.active = new Map();            // chunk -> {controller}
    this.chunkStats = new Map();        // chunk -> {samples,speed,slowStreak}
    this.splitRequests = new Map();     // chunk -> {mid, oldEnd}
    this.paused = false;
    this.canceled = false;
    this.failed = false;
    this.finished = false;
    this.notified = false;              // paused/canceled/error 只通知一次
    this.failedStreak = 0;
    this.sampler = null;
    this.h = null;
    this.startedAt = new Date().toISOString();
    this._saveChain = Promise.resolve(); // 控制文件写入链：多线程并发保存时串行化，避免 tmp 竞争
  }

  /* ---------------- 探针 ---------------- */
  async start(handlers) {
    this.h = handlers;
    try {
      const ctrl = await this.loadControl();
      if (ctrl) {
        this.size = ctrl.size;
        this.etag = ctrl.etag;
        this.lastModified = ctrl.lastModified;
        this.acceptRanges = !!ctrl.acceptRanges;
        this.sequential = !!ctrl.sequential;
        this.chunkSize = ctrl.chunkSize;
        this.chunks = ctrl.chunks || [];
      } else {
        await this.probe();
        if (this.size === null || !this.acceptRanges) {
          this.sequential = true;
          this.threads = 1;
          this.chunks = [{ start: 0, end: this.size !== null ? this.size - 1 : null, done: 0, splits: 0 }];
        } else {
          const built = buildChunks(this.size, this.threads);
          this.chunkSize = built.chunkSize;
          this.chunks = built.chunks;
        }
      }
      if (this.canceled) return;
      if (!this.sequential) {
        await this.ensurePartAllocated();
        this.rebuildPending();
        await this.saveControl();
        for (let i = 0; i < this.threads; i++) this.spawnWorker();
        this.startSampler();
      } else {
        this.rebuildPending();
        await this.saveControl();
        this.spawnWorker();
      }
    } catch (e) {
      this.failTask(e);
    }
  }

  buildHeaders(range) {
    const h = Object.assign({ 'User-Agent': DEFAULT_UA, Accept: '*/*' }, this.headers);
    if (range) h.Range = range;
    return h;
  }

  /** 请求一次并解析响应头；支持最多 3 次重定向。 */
  async requestHead(method, range, redirects) {
    const req = pickRequestor(this.url).request(this.url, {
      method,
      headers: this.buildHeaders(range)
    });
    return new Promise((resolve, reject) => {
      req.setTimeout(15000, () => { req.destroy(new Error('探针超时')); });
      req.on('response', (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < MAX_REDIRECTS) {
          res.resume();
          this.url = new URL(res.headers.location, this.url).toString();
          resolve(this.requestHead(method, range, redirects + 1));
          return;
        }
        resolve(res);
      });
      req.on('error', reject);
      req.end();
    });
  }

  async probe() {
    let res = null;
    try { res = await this.requestHead('HEAD', null, 0); } catch (e) { res = null; }
    if (!res || res.statusCode < 200 || res.statusCode >= 300) {
      // HEAD 失败（405 等）→ 退化为 GET Range: bytes=0-0 探针
      res = await this.requestHead('GET', 'bytes=0-0', 0);
      if (res.statusCode === 206) {
        const m = /bytes 0-0\/(\d+)/.exec(res.headers['content-range'] || '');
        this.size = m ? parseInt(m[1], 10) : null;
        this.acceptRanges = true;
      } else if (res.statusCode === 200) {
        this.size = res.headers['content-length'] ? parseInt(res.headers['content-length'], 10) : null;
        this.acceptRanges = String(res.headers['accept-ranges'] || '').toLowerCase() === 'bytes';
      } else {
        res.resume();
        const e = new Error('HTTP ' + res.statusCode);
        e.code = 'HTTP_' + res.statusCode;
        throw e;
      }
      if (res.readable) res.destroy();
    } else {
      this.size = res.headers['content-length'] ? parseInt(res.headers['content-length'], 10) : null;
      this.acceptRanges = String(res.headers['accept-ranges'] || '').toLowerCase() === 'bytes';
      if (res.readable) res.destroy();
    }
    if (res) {
      this.etag = res.headers.etag || null;
      this.lastModified = res.headers['last-modified'] || null;
    }
  }

  /* ---------------- 控制文件与断点续传 ----------------
   * 断点续传（大段注释，说明原理）
   * -----------------------------------------------------------------------------
   * 控制文件 <dest>.wpdl.json 记录 {url, headers, size, etag, lastModified,
   * chunkSize, chunks:[{start,end,done}], startedAt, updatedAt}。
   *   - “块已完成”用 start > end 表达（start 被推进到 end+1）；
   *   - 进行中的块在每次保存时把 start 推进为「当前已写入偏移」，done 清零。
   *     于是 resume 时只需要对 start <= end 的块发 Range: bytes=start-end 即可，
   *     已经写入的字节（无论整块还是块内一部分）都不会重复下载——
   *     这就是“把 chunks 的 start 推进为当前已写入偏移即可”的断点续传本质。
   *   - 保存时机：每完成一块 + 暂停/中止时 + 定时兜底（每 10s），
   *     崩溃后最多损失最近 10s 的块内进度，其余全部精确保留。
   *   - 已下载字节总数由队列持久化的 task.done 提供（baseDone），
   *     控制文件只表达「剩余工作」，两者分工避免重复记账。
   * ----------------------------------------------------------------------------- */
  async loadControl() {
    try {
      const raw = await fsp.readFile(controlFile(this.destPath), 'utf8');
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  snapshotChunks() {
    return this.chunks.map((c) => {
      if (this.active.has(c)) {
        // 进行中的块：start 推进到已写偏移（done 清零），实现“精确到块内”的断点
        return { start: c.start + c.done, end: c.end, done: 0, splits: c.splits };
      }
      return { start: c.start, end: c.end, done: c.done, splits: c.splits };
    });
  }

  async saveControl() {
    const ctrl = {
      url: this.url,
      headers: this.headers,
      size: this.size,
      etag: this.etag,
      lastModified: this.lastModified,
      acceptRanges: this.acceptRanges,
      sequential: this.sequential,
      chunkSize: this.chunkSize,
      chunks: this.snapshotChunks(),
      startedAt: this.startedAt,
      updatedAt: new Date().toISOString()
    };
    // 串行化：多个 worker 完成块时可能并发触发保存
    const write = () => atomicWrite(controlFile(this.destPath), JSON.stringify(ctrl, null, 2));
    this._saveChain = this._saveChain.then(write, write);
    return this._saveChain;
  }

  async ensurePartAllocated() {
    // 预分配：稀疏文件（ftruncate 到目标大小），各线程按 offset 随机写，互不干扰。
    // 注意：不能用 'w+' 打开已存在的续传文件（'w+' 会先清空文件，毁掉已下载数据）；
    // 已存在时用 'r+'，不存在时用 'w' 创建，再统一 ftruncate 到目标大小（无数据损失）。
    let fh;
    try {
      fh = await fsp.open(partFile(this.destPath), 'r+');
    } catch (e) {
      fh = await fsp.open(partFile(this.destPath), 'w');
    }
    try {
      await fh.truncate(this.size);
    } finally {
      await fh.close().catch(() => {});
    }
  }

  rebuildPending() {
    this.pending = [];
    for (const c of this.chunks) {
      if (c.start <= (c.end === null ? c.start : c.end)) this.pending.push(c);
    }
    // 若外部未提供 baseDone（旧任务），由控制文件反推
    if (!this.baseDone && this.size !== null && this.chunks.length) {
      let remain = 0;
      for (const c of this.chunks) if (c.end !== null && c.start <= c.end) remain += c.end - c.start + 1;
      this.baseDone = Math.max(0, this.size - remain);
    }
  }

  /* ---------------- 工作线程池 ---------------- */
  spawnWorker() {
    if (this.paused || this.canceled || this.failed || this.finished) return;
    if (this.active.size >= this.threads) return;
    const chunk = this.pending.shift();
    if (!chunk) { this.maybeFinish(); return; }
    this.active.set(chunk, {});
    this.runWorker(chunk)
      .catch(() => {})
      .finally(() => {
        this.active.delete(chunk);
        if (this.paused || this.canceled || this.failed) {
          this.maybeAllStopped();
        } else {
          this.spawnWorker();
          this.maybeFinish();
        }
      });
  }

  async runWorker(chunk) {
    let attempt = 0;
    let lastErr = null;
    if (!this.chunkStats.has(chunk)) this.chunkStats.set(chunk, { samples: [], speed: 0, slowStreak: 0 });
    while (attempt <= 3) {
      if (this.paused || this.canceled) { await this.saveControl(); return; }
      const ctl = new AbortController();
      this.active.set(chunk, { controller: ctl });
      try {
        const result = await this.downloadChunkOnce(chunk, ctl);
        if (result === 'done') {
          this.markChunkDone(chunk);
          this.failedStreak = 0;
          await this.saveControl();
          return;
        }
        if (result === 'aborted') { await this.saveControl(); return; }
        if (result === 'fallback') {
          // 服务器对分段请求返回 200：整体降级为单线程顺序下载
          this.applySequentialFallback();
          return;
        }
      } catch (err) {
        if (this.paused || this.canceled) { await this.saveControl(); return; }
        const aborted = err && (err.name === 'AbortError' || err.code === 'ABORT_ERR');
        if (aborted && this.splitRequests.has(chunk)) {
          this.applySplit(chunk);
          return;
        }
        if (this.splitRequests.has(chunk)) { this.applySplit(chunk); return; }
        if (err && err.fatal) {
          // 4xx 等不可恢复错误：跳过重试，直接计入块失败
          lastErr = err;
          attempt = 4;
          continue;
        }
        lastErr = err;
        attempt++;
        if (attempt <= 3) {
          const ok = await this.sleepBackoff(RETRY_BACKOFF[attempt - 1]);
          if (!ok) { await this.saveControl(); return; }
        }
      }
    }
    await this.saveControl();
    this.chunkFailed(chunk, lastErr);
  }

  /** 下载一个块（或块内剩余区间）。返回 'done'|'aborted'|'fallback'。 */
  async downloadChunkOnce(chunk, ctl) {
    const reqStart = chunk.start + chunk.done;
    const range = chunk.end !== null ? 'bytes=' + reqStart + '-' + chunk.end : 'bytes=' + reqStart + '-';
    const req = pickRequestor(this.url).request(this.url, {
      method: 'GET',
      headers: this.buildHeaders(range),
      signal: ctl.signal
    });
    req.end(); // http.request 必须显式 end 才会真正发出请求
    // 关键：必须在任何 await 之前挂上 response/error 监听——本地高速响应可能在
    // 事件循环让出期间（如 await fs.open）就已到达，晚挂监听会丢事件导致永久挂起。
    req.setTimeout(60000, () => req.destroy(new Error('下载请求超时')));
    const respPromise = new Promise((resolve, reject) => {
      req.on('response', resolve);
      req.on('error', reject);
    });
    // 顺序模式（未预分配）下 .part 可能不存在：'r+' 失败则 'w' 创建
    let fd;
    try {
      fd = await fsp.open(partFile(this.destPath), 'r+');
    } catch (e) {
      fd = await fsp.open(partFile(this.destPath), 'w');
    }
    try {
      const resp = await respPromise;
      const st = resp.statusCode;
      if (st === 200) {
        // 服务器忽略 Range：仅当本块覆盖整个文件（单块全量）时接受，
        // 否则必须整体降级为顺序下载，避免把全文件数据写进小块区间造成错位。
        const fullFile = reqStart === 0 && (chunk.end === null || chunk.end >= this.size - 1);
        if (!fullFile) {
          resp.destroy();
          return 'fallback';
        }
      } else if (st !== 206) {
        resp.destroy();
        const e = new Error('HTTP ' + st);
        e.code = 'HTTP_' + st;
        if (st >= 400 && st < 500) e.fatal = true;
        throw e;
      }
      let pos = reqStart;
      await new Promise((resolve, reject) => {
        resp.on('data', (buf) => {
          resp.pause(); // 背压：写完再继续收，避免内存膨胀
          const p = pos;
          pos += buf.length;
          fd.write(buf, 0, buf.length, p) // FileHandle.write(buffer, offset, length, position)
            .then(() => {
              chunk.done += buf.length;
              this.totalDone += buf.length;
              this.h.onProgress(this.baseDone + this.totalDone);
              resp.resume();
            })
            .catch((err) => { resp.destroy(); reject(err); });
        });
        resp.on('end', resolve);
        resp.on('error', reject);
        resp.on('aborted', () => {
          const e = new Error('连接被中止');
          e.code = 'ABORT_ERR';
          reject(e);
        });
      });
      const received = pos - reqStart;
      const expected = chunk.end !== null ? chunk.end - reqStart + 1 : null;
      if (expected !== null && received < expected) {
        // 服务器提前断开：chunk.done 已累计到已收字节，抛错重试时自动从 start+done 续传
        const e = new Error('连接中断，已收 ' + received + '/' + expected + ' 字节');
        e.code = 'EARLY_CLOSE';
        throw e;
      }
      if (chunk.end === null) chunk.end = pos - 1; // 开区间（大小未知）流式到 EOF
      return 'done';
    } finally {
      await fd.close().catch(() => {});
    }
  }

  markChunkDone(chunk) {
    chunk.start = chunk.end + 1;
    chunk.done = 0;
    // 若该块曾被请求分裂但下载在分裂执行前完成，清除残留的分裂请求，避免状态泄漏
    this.splitRequests.delete(chunk);
  }

  async sleepBackoff(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (this.paused || this.canceled) return false;
      await new Promise((r) => setTimeout(r, Math.min(100, end - Date.now())));
    }
    return true;
  }

  chunkFailed(chunk, err) {
    this.failedStreak++;
    if (this.failedStreak >= MAX_CHUNK_FAIL_STREAK) {
      this.failTask({
        code: 'DOWNLOAD_FAILED',
        message: '连续 ' + MAX_CHUNK_FAIL_STREAK + ' 个分块下载失败，任务已停止（可重试续传）：' +
          ((err && err.message) || '网络错误')
      });
      return;
    }
    this.pending.push(chunk); // 单块失败且未达阈值：重新排队再试
  }

  /* =====================================================================================
   * 动态块大小（自适应调度，大段注释说明原理）
   * -------------------------------------------------------------------------------------
   * 固定分块的问题：多线程下载时，各连接的实际带宽并不均匀（拥塞、路由、服务器限速）。
   * 快的线程早早干完退出，慢的线程拖后腿，整体完成时间由最慢的块决定。
   *
   * 自适应策略（经典 work-stealing 变体）：
   *   1. 每 5 秒采样一次各「活动块」在本周期内的字节增量，得到块速度；
   *   2. 取所有块速度的中位数作为“正常速度”基准；
   *   3. 某块速度 < 中位数 30%，记一次“慢块”计数；连续两个采样周期都慢，说明不是
   *      瞬时抖动而是稳定慢速，触发分裂；
   *   4. 分裂：该块剩余区间从中间一分为二，下半段作为新块加入待下队列，交给空闲线程
   *      （仅在「活动线程数 < threads」（即存在空闲线程）时分裂，否则分裂无收益）；
   *   5. 同一块最多分裂 3 次，防止对同一区间无限抖动。
   * 分裂前会先 AbortController 中止该块的当前请求；已写入的字节按文件偏移精确归属，
   * 若已越过新边界，超出部分直接“让渡”给新块（推进新块 start），零重复下载。
   * ===================================================================================== */
  startSampler() {
    if (this.sampler) return;
    this.sampler = setInterval(() => this.sample(), SAMPLE_MS);
  }

  sample() {
    if (this.paused || this.canceled || this.failed || this.finished || this.sequential) return;
    const now = Date.now();
    const speeds = [];
    for (const c of this.active.keys()) {
      const st = this.chunkStats.get(c);
      if (!st) continue;
      st.samples.push({ t: now, b: c.done });
      while (st.samples.length > 2 && now - st.samples[0].t > SAMPLE_MS) st.samples.shift();
      if (st.samples.length < 2) continue;
      const a = st.samples[0];
      const b = st.samples[st.samples.length - 1];
      st.speed = b.t > a.t ? ((b.b - a.b) * 1000) / (b.t - a.t) : 0;
      speeds.push(st.speed);
    }
    if (speeds.length < 2) return; // 只有一个活动块时没有分裂意义
    const sorted = speeds.slice().sort((x, y) => x - y);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (median <= 0) return;
    for (const c of this.active.keys()) {
      const st = this.chunkStats.get(c);
      if (!st || st.samples.length < 2) continue;
      const remaining = c.end !== null ? c.end - (c.start + c.done) + 1 : 0;
      if (st.speed < median * 0.3 && remaining > 2 * KI64) st.slowStreak++;
      else st.slowStreak = 0;
      if (st.slowStreak >= 2 && c.splits < MAX_SPLITS && this.active.size < this.threads) {
        const mid = (c.start + c.done) + Math.floor(remaining / 2);
        c.splits++;
        this.splitRequests.set(c, { mid, oldEnd: c.end });
        const ent = this.active.get(c);
        if (ent && ent.controller) ent.controller.abort();
      }
    }
  }

  /** 分裂收口：中止的 worker 退出后执行，把已写字节精确归属到两块。 */
  async applySplit(chunk) {
    const req = this.splitRequests.get(chunk);
    this.splitRequests.delete(chunk);
    if (!req) {
      if (chunk.start <= chunk.end) this.pending.unshift(chunk);
      await this.saveControl();
      return;
    }
    // 已写字节可能越过新边界（mid）——超出部分属于新块，直接推进新块 start
    const surplus = Math.max(0, (chunk.start + chunk.done) - req.mid);
    chunk.done = Math.max(0, Math.min(chunk.done, req.mid - chunk.start));
    chunk.end = req.mid - 1;
    if (surplus > 0 && req.oldEnd !== null) {
      const newChunk = { start: req.mid + surplus, end: req.oldEnd, done: 0, splits: chunk.splits };
      if (newChunk.start <= newChunk.end) {
        this.chunks.push(newChunk);
        this.pending.push(newChunk);
      }
    } else if (req.oldEnd !== null) {
      const newChunk = { start: req.mid, end: req.oldEnd, done: 0, splits: chunk.splits };
      this.chunks.push(newChunk);
      this.pending.push(newChunk);
    }
    chunk.start += chunk.done;
    chunk.done = 0;
    if (chunk.start <= chunk.end) this.pending.unshift(chunk); // 剩余部分优先，尽快回填
    await this.saveControl();
  }

  /** 服务器对分段请求返回 200：整体降级为单线程顺序下载。 */
  applySequentialFallback() {
    this.sequential = true;
    this.threads = 1;
    this.baseDone = 0;
    this.totalDone = 0;
    for (const ent of this.active.values()) {
      if (ent.controller) ent.controller.abort();
    }
    this.pending = [];
    this.chunks = [{ start: 0, end: this.size !== null ? this.size - 1 : null, done: 0, splits: 0 }];
    this.pending.push(this.chunks[0]);
    // 顺序模式从 0 重下：清空已预分配的 .part
    fsp.truncate(partFile(this.destPath), 0).catch(() => {});
    this.saveControl().catch(() => {});
  }

  /* ---------------- 暂停 / 取消 / 完成 / 失败 ---------------- */
  pause() {
    if (this.paused || this.canceled || this.finished || this.failed) return;
    this.paused = true;
    this.stopSampler();
    for (const ent of this.active.values()) {
      if (ent.controller) ent.controller.abort(); // 逐线程中止，worker 退出时保存块内偏移
    }
    this.maybeAllStopped();
  }

  cancel() {
    if (this.canceled || this.finished) return;
    this.canceled = true;
    this.stopSampler();
    for (const ent of this.active.values()) {
      if (ent.controller) ent.controller.abort();
    }
    this.maybeAllStopped();
  }

  stopSampler() {
    if (this.sampler) { clearInterval(this.sampler); this.sampler = null; }
  }

  maybeAllStopped() {
    if (this.active.size > 0 || this.notified) return;
    this.notified = true;
    if (this.canceled) {
      this.cleanupFiles().then(() => this.h.onCanceled());
      return;
    }
    if (this.failed) {
      // 保留控制文件：任务标记 error，用户可 retry 续传
      this.h.onError(this.failErr);
      return;
    }
    if (this.paused) {
      this.saveControl().then(() => this.h.onPaused()).catch(() => this.h.onPaused());
    }
  }

  failTask(err) {
    if (this.failed || this.canceled || this.finished) return;
    this.failed = true;
    this.failErr = err || { code: 'DOWNLOAD_FAILED', message: '下载失败' };
    this.stopSampler();
    for (const ent of this.active.values()) {
      if (ent.controller) ent.controller.abort();
    }
    this.maybeAllStopped();
  }

  async cleanupFiles() {
    await fsp.unlink(controlFile(this.destPath)).catch(() => {});
    await fsp.unlink(partFile(this.destPath)).catch(() => {});
  }

  maybeFinish() {
    if (this.finished || this.paused || this.canceled || this.failed) return;
    if (this.active.size > 0 || this.pending.length > 0) return;
    this.finalize().catch((e) => this.failTask(e));
  }

  async finalize() {
    if (this.finished) return;
    this.finished = true;
    this.stopSampler();
    // 1) 总大小校验
    if (this.size !== null) {
      const st = await fsp.stat(partFile(this.destPath));
      if (st.size !== this.size) {
        const e = new Error('下载不完整：期望 ' + this.size + ' 字节，实际 ' + st.size + ' 字节');
        e.code = 'SIZE_MISMATCH';
        throw e;
      }
    }
    // 2) 可选 sha256 流式校验
    if (this.expectedSha256) {
      const hash = crypto.createHash('sha256');
      await new Promise((resolve, reject) => {
        const rs = fs.createReadStream(partFile(this.destPath));
        rs.on('data', (d) => hash.update(d));
        rs.on('end', resolve);
        rs.on('error', reject);
      });
      const got = hash.digest('hex');
      if (got.toLowerCase() !== String(this.expectedSha256).toLowerCase()) {
        const e = new Error('文件校验失败（SHA-256 不匹配）');
        e.code = 'SHA256_MISMATCH';
        // 数据源与期望哈希不符：保留 .part 重试也无意义，直接清理
        await this.cleanupFiles();
        throw e;
      }
    }
    // 3) 归位：.part → 最终文件，删除控制文件
    await fsp.unlink(this.destPath).catch(() => {});
    await fsp.rename(partFile(this.destPath), this.destPath);
    await fsp.unlink(controlFile(this.destPath)).catch(() => {});
    this.h.onDone();
  }
}

module.exports = { NativeDownload };
