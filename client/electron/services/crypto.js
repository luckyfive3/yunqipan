'use strict';
/**
 * crypto.js —— AES-256-GCM 流式端到端加密（E2E）
 *
 * 职责：
 *   1. 提供 encryptFile(src, dst, pass, onProgress) / decryptFile(src, dst, pass, onProgress)，
 *      整文件分块独立加密/认证（GCM），支持“随机解密任意块”而无需从头顺序解密。
 *   2. 文件格式（按字节序）：
 *      magic "WPENC1"(6B) + version(1B=1) + salt(16B) + ivBase(12B) + chunkSize(4B LE=1048576)
 *      + 每块 [ iv(12B = ivBase 前 4 字节为大端块序号 + 其余字节) + 密文 + tag(16B) ]
 *   3. 密钥 = scrypt(passphrase, salt, 32, {N:2^15, r:8, p:1})。
 *   4. 解密失败（坏 magic / 认证标签不匹配）抛出中文错误。
 *   5. 注意：加密文件不参与服务端预览（encrypted=true 时服务端一律 415）。
 *
 * 实现说明：采用“手动分块循环 + fs.open/read/write”而非 createReadStream 管道，
 * 是为了精确控制每块字节数（GCM 块格式需要固定长度），并能在解密时定位损坏块序号。
 */
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');

const MAGIC = Buffer.from('WPENC1', 'ascii');
const VERSION = 1;
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const CHUNK_SIZE = 1048576;          // 1 MiB
const HEADER_LEN = 6 + 1 + 16 + 12 + 4; // 39 字节
const SCRYPT_OPTS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }; // N = 2^15；显式 maxmem 兼容 Node 26 的默认内存上限

/** 精确读取 len 字节（不足返回实际读取量，文件尾返回 0）。 */
async function readFull(fd, buf, len) {
  let off = 0;
  while (off < len) {
    const { bytesRead } = await fd.read(buf, off, len - off, null);
    if (bytesRead === 0) break;
    off += bytesRead;
  }
  return off;
}

async function writeAll(fd, buf) {
  let off = 0;
  while (off < buf.length) {
    const { bytesWritten } = await fd.write(buf, off, buf.length - off, null);
    off += bytesWritten;
  }
}

async function encryptFile(src, dst, pass, onProgress) {
  const salt = crypto.randomBytes(SALT_LEN);
  const ivBase = crypto.randomBytes(IV_LEN);
  const key = await new Promise((resolve, reject) => {
    crypto.scrypt(String(pass), salt, 32, SCRYPT_OPTS, (e, k) => (e ? reject(e) : resolve(k)));
  });
  const header = Buffer.alloc(HEADER_LEN);
  MAGIC.copy(header, 0);
  header.writeUInt8(VERSION, 6);
  salt.copy(header, 7);
  ivBase.copy(header, 23);
  header.writeUInt32LE(CHUNK_SIZE, 35);

  const rfd = await fsp.open(src, 'r');
  const wfd = await fsp.open(dst, 'w');
  try {
    await writeAll(wfd, header);
    const total = (await rfd.stat()).size;
    let done = 0;
    let index = 0;
    const buf = Buffer.allocUnsafe(CHUNK_SIZE);
    for (;;) {
      const n = await readFull(rfd, buf, CHUNK_SIZE);
      if (n === 0) break;
      // 每块 IV：ivBase 的前 4 字节替换为大端块序号（保证同口令下每块 IV 唯一）
      const iv = Buffer.from(ivBase);
      iv.writeUInt32BE(index, 0);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([cipher.update(buf.subarray(0, n)), cipher.final()]);
      const tag = cipher.getAuthTag();
      await writeAll(wfd, Buffer.concat([iv, ct, tag]));
      done += n;
      if (onProgress) onProgress(done, total);
      index++;
    }
  } finally {
    await rfd.close().catch(() => {});
    await wfd.close().catch(() => {});
  }
}

async function decryptFile(src, dst, pass, onProgress) {
  const total = (await fsp.stat(src)).size;
  const rfd = await fsp.open(src, 'r');
  const wfd = await fsp.open(dst, 'w');
  try {
    const head = Buffer.alloc(HEADER_LEN);
    const hn = await readFull(rfd, head, HEADER_LEN);
    if (hn < HEADER_LEN || !head.subarray(0, 6).equals(MAGIC)) {
      throw new Error('不是有效的云栖盘加密文件（magic 校验失败）');
    }
    const version = head.readUInt8(6);
    if (version !== 1) throw new Error('加密文件版本不支持（version=' + version + '）');
    const salt = Buffer.from(head.subarray(7, 23));
    const ivBase = Buffer.from(head.subarray(23, 35));
    const chunkSize = head.readUInt32LE(35);
    if (chunkSize <= 0 || chunkSize > 64 * 1024 * 1024) throw new Error('加密文件已损坏（非法块大小）');

    // 块数推导：总长 = 头39 + k*(块明文 + 28)，且 (k-1)*chunkSize < 明文 <= k*chunkSize
    let k = Math.max(1, Math.ceil((total - HEADER_LEN) / (chunkSize + IV_LEN + TAG_LEN)));
    let plain = total - HEADER_LEN - k * (IV_LEN + TAG_LEN);
    while (plain > k * chunkSize) { k++; plain -= IV_LEN + TAG_LEN; }
    while (k > 1 && plain <= (k - 1) * chunkSize) { k--; plain += IV_LEN + TAG_LEN; }
    if (plain <= 0) throw new Error('加密文件已损坏（内容长度非法）');

    const key = await new Promise((resolve, reject) => {
      crypto.scrypt(String(pass), salt, 32, SCRYPT_OPTS, (e, kk) => (e ? reject(e) : resolve(kk)));
    });
    let done = 0;
    const meta = Buffer.alloc(IV_LEN + TAG_LEN);
    for (let i = 0; i < k; i++) {
      const ctLen = i < k - 1 ? chunkSize : plain - (k - 1) * chunkSize;
      const iv = Buffer.alloc(IV_LEN);
      if (await readFull(rfd, iv, IV_LEN) < IV_LEN) throw new Error('加密文件已损坏（块 ' + i + ' 头部不完整）');
      const ct = Buffer.allocUnsafe(ctLen);
      if (await readFull(rfd, ct, ctLen) < ctLen) throw new Error('加密文件已损坏（块 ' + i + ' 密文不完整）');
      const tag = Buffer.alloc(TAG_LEN);
      if (await readFull(rfd, tag, TAG_LEN) < TAG_LEN) throw new Error('加密文件已损坏（块 ' + i + ' 认证标签缺失）');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      let out;
      try {
        out = Buffer.concat([decipher.update(ct), decipher.final()]);
      } catch (e) {
        throw new Error('数据完整性校验失败：第 ' + i + ' 块认证标签不匹配（密码错误或文件被篡改）');
      }
      await writeAll(wfd, out);
      done += out.length;
      if (onProgress) onProgress(done, plain);
    }
  } finally {
    await rfd.close().catch(() => {});
    await wfd.close().catch(() => {});
  }
}

module.exports = {
  encryptFile,
  decryptFile,
  CHUNK_SIZE,
  MAGIC
};
