'use strict';
/**
 * http-direct.js —— 通用直链解析器（合规参考实现）
 *
 * 职责：
 *   1. 支持两类输入：
 *      a) http(s):// 直链；
 *      b) 浏览器「复制为 cURL(bash)」命令（curl 'https://...' -H 'Name: value' ...）。
 *   2. HEAD 探针（失败则 GET Range: bytes=0-0）获取 size / accept-ranges / content-type。
 *   3. 返回 {provider:'http-direct', title, files:[{name, size, directUrl, headers}]}。
 *
 * 合规说明：
 *   - 直链/请求头只来自用户显式输入；cURL 导入的 Referer/Cookie 属于用户自有登录会话，
 *     仅用于本次下载（等价于用户用多线程下载器加速自己浏览器里的官方下载链接），
 *     本解析器不保存、不复用、不外传任何凭据。
 *   - 不实现任何签名算法，不绕过任何平台鉴权。
 */
const http = require('http');
const https = require('https');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) YunQiPan-Client/1.0';

function pickRequestor(u) { return u.startsWith('https:') ? https : http; }

function nameFromUrl(u) {
  try {
    const p = new URL(u).pathname.split('/').filter(Boolean).pop() || 'download';
    return decodeURIComponent(p);
  } catch (e) {
    return 'download';
  }
}

/** 解析「复制为 cURL(bash)」命令：提取 URL、请求头与输出文件名。 */
function parseCurl(cmd) {
  const urlMatch = /(?:^|\s)curl\s+(?:-[A-Za-z]\s+\S+\s+)*['"]?(https?:\/\/[^\s'"]+)['"]?/i.exec(cmd);
  if (!urlMatch) {
    throw { code: 'INVALID_INPUT', message: '无法从该命令中识别下载地址（请使用浏览器「复制为 cURL(bash)」）' };
  }
  const url = urlMatch[1];
  const headers = { 'User-Agent': UA };
  const hRe = /(?:^|\s)(?:-H|--header)\s+['"]?([^'"\r\n]+?)['"]?(?=\s+(?:-|\\|$))/gi;
  let m;
  while ((m = hRe.exec(cmd))) {
    const idx = m[1].indexOf(':');
    if (idx > 0) {
      const name = m[1].slice(0, idx).trim();
      const value = m[1].slice(idx + 1).trim();
      if (name) headers[name] = value;
    }
  }
  let outName = null;
  const oRe = /(?:^|\s)(?:-o|--output)\s+['"]?([^'"\s]+)['"]?/i.exec(cmd);
  if (oRe) {
    try { outName = decodeURIComponent(oRe[1].split(/[\\/]/).pop()); } catch (e) { outName = oRe[1].split(/[\\/]/).pop(); }
  }
  return { url, headers, outName };
}

function headOnce(url, method, range, headers) {
  const req = pickRequestor(url).request(url, {
    method,
    headers: Object.assign({ 'User-Agent': UA, Accept: '*/*' }, headers || {}, range ? { Range: range } : {})
  });
  return new Promise((resolve, reject) => {
    req.setTimeout(12000, () => { req.destroy(new Error('探针超时')); });
    req.on('response', resolve);
    req.on('error', reject);
    req.end();
  });
}

async function probe(url, headers) {
  let res = null;
  try { res = await headOnce(url, 'HEAD', null, headers); } catch (e) { res = null; }
  if (!res || res.statusCode < 200 || res.statusCode >= 300) {
    if (res && res.readable) res.destroy();
    res = await headOnce(url, 'GET', 'bytes=0-0', headers);
  }
  const size = res.headers['content-length'] ? parseInt(res.headers['content-length'], 10) : null;
  const acceptRanges = String(res.headers['accept-ranges'] || '').toLowerCase() === 'bytes';
  const contentType = res.headers['content-type'] || '';
  let title = null;
  const cd = res.headers['content-disposition'] || '';
  const m = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(cd);
  if (m) {
    try { title = decodeURIComponent(m[1]); } catch (e) { title = m[1]; }
  }
  if (res.readable) res.destroy();
  return { size, acceptRanges, contentType, title };
}

async function resolve(link, _code) {
  const input = String(link || '').trim();
  let url = input;
  let userHeaders = {};
  let outName = null;

  if (/^curl\s/i.test(input)) {
    const c = parseCurl(input);
    url = c.url;
    userHeaders = c.headers;
    outName = c.outName;
  }

  if (!/^https?:\/\//i.test(url)) {
    throw { code: 'INVALID_INPUT', message: '直链必须以 http(s):// 开头（也支持粘贴浏览器「复制为 cURL(bash)」命令）' };
  }

  let info = null;
  try {
    info = await probe(url, userHeaders);
  } catch (e) {
    throw { code: 'PROBE_FAILED', message: '链接探针失败：' + (e.message || '无法访问该地址') };
  }

  const name = info.title || outName || nameFromUrl(url);
  return {
    provider: 'http-direct',
    title: name,
    files: [{
      name: name,
      size: info.size,               // 可能为 null（服务器未给 Content-Length）
      directUrl: url,
      headers: userHeaders           // 用户提供的 UA/Referer/Cookie（仅本次下载使用）
    }]
  };
}

module.exports = { resolve, parseCurl };
