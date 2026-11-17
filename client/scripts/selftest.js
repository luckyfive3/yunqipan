'use strict';
/* 临时自测脚本：验证 crypto（E2E 加解密回环/错误分支）、settings（深度合并/原子写）、task-store（持久化）。 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-selftest-'));
  const { encryptFile, decryptFile } = require(path.join(__dirname, '..', 'electron', 'services', 'crypto'));

  // 1) crypto 回环
  const src = path.join(tmp, 'src.bin');
  const enc = path.join(tmp, 'enc.bin');
  const dec = path.join(tmp, 'dec.bin');
  const data = Buffer.concat([Buffer.from('hello 云栖盘 '), Buffer.from(require('crypto').randomBytes(2 * 1024 * 1024 + 12345))]);
  fs.writeFileSync(src, data);
  let p1 = 0;
  await encryptFile(src, enc, '测试口令', (d, t) => { p1 = d / t; });
  assert.strictEqual(p1, 1, 'encrypt progress 应到 1');
  let p2 = 0;
  await decryptFile(enc, dec, '测试口令', (d, t) => { p2 = d / t; });
  assert.strictEqual(p2, 1, 'decrypt progress 应到 1');
  assert.ok(fs.readFileSync(dec).equals(data), '解密结果应与原文一致');
  console.log('[OK] crypto 加解密回环（含中文口令/进度）');

  // 坏密码 → 中文错误
  let wrongErr = null;
  try { await decryptFile(enc, dec + '.bad', '错误口令'); } catch (e) { wrongErr = e.message; }
  assert.ok(wrongErr && wrongErr.indexOf('校验失败') >= 0, '坏密码应抛中文校验错误，实际：' + wrongErr);
  console.log('[OK] crypto 坏密码中文报错：' + wrongErr);

  // 坏 magic → 中文错误
  fs.writeFileSync(enc + '.magic', Buffer.concat([Buffer.from('XXXXXX'), fs.readFileSync(enc).subarray(6)]));
  let magicErr = null;
  try { await decryptFile(enc + '.magic', dec + '.bad', '测试口令'); } catch (e) { magicErr = e.message; }
  assert.ok(magicErr && magicErr.indexOf('magic') >= 0, '坏 magic 应报中文错误，实际：' + magicErr);
  console.log('[OK] crypto 坏 magic 中文报错：' + magicErr);

  // 2) settings 深度合并 + 原子写
  const { createSettings } = require(path.join(__dirname, '..', 'electron', 'services', 'settings'));
  const s = createSettings({ userDataDir: tmp });
  await s.load();
  s.set('parsers', { baidu: true });
  s.set('theme', 'dark');
  assert.strictEqual(s.get('parsers.baidu'), true);
  assert.strictEqual(s.get('parsers.quark'), false, '深度合并不应覆盖未提及键');
  assert.strictEqual(s.get('theme'), 'dark');
  await s.flushNow();
  const s2 = createSettings({ userDataDir: tmp });
  await s2.load();
  assert.strictEqual(s2.get('parsers.baidu'), true);
  assert.strictEqual(s2.get('theme'), 'dark');
  assert.strictEqual(s2.get('maxDownloadTasks'), 3, '默认值应保留');
  console.log('[OK] settings 深度合并 / 原子替换 / 默认值');

  // 3) task-store 持久化
  const { createTaskStore } = require(path.join(__dirname, '..', 'electron', 'services', 'task-store'));
  const st = createTaskStore({ userDataDir: tmp });
  await st.load();
  st.save({ id: 't1', kind: 'download', status: 'running', name: 'a.bin' });
  await st.flushNow();
  const st2 = createTaskStore({ userDataDir: tmp });
  await st2.load();
  assert.strictEqual(st2.get('t1').kind, 'download');
  st2.remove('t1');
  await st2.flushNow();
  const st3 = createTaskStore({ userDataDir: tmp });
  await st3.load();
  assert.strictEqual(st3.get('t1'), null);
  console.log('[OK] task-store 保存/加载/删除');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('全部冒烟测试通过');
})().catch((e) => { console.error('自测失败：', e); process.exit(1); });
