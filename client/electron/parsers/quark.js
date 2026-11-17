'use strict';
/**
 * quark.js —— 夸克网盘公开分享解析器（合规骨架）
 *
 * 【合规边界（硬性要求，本文件严格遵守）】
 *   1. 只允许：GET 匿名公开分享页（无需登录、不携带任何账号 Cookie），
 *      从页面公开内嵌的 JSON / 初始数据中提取「匿名访客可见」的文件列表。
 *   2. 提取码：仅提示用户输入，并只调用该公开页面自身同源的「公开校验接口」。
 *   3. 绝不实现任何逆向签名算法；绝不使用/保存任何账号 Cookie；
 *      绝不涉及会员 / VIP / 私密资源破解。
 *   4. 当页面要求登录、或不存在匿名直链时，一律抛中文错误：
 *      『该资源不提供匿名公开直链，按合规要求无法解析，请使用官方客户端』。
 *
 * 说明：本骨架只做通用公开字段提取（白名单字段 name/size/dir 等，括号配对法截取
 * JSON 子串，极其谨慎、只取公开字段），不含任何平台混淆 JS 复刻算法与签名密钥。
 * 默认禁用，用户需在设置中自行开启并承担平台条款责任。
 */
const http = require('http');
const https = require('https');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const COMPLIANCE_ERROR = '该资源不提供匿名公开直链，按合规要求无法解析，请使用官方客户端';

function pickRequestor(u) { return u.startsWith('https:') ? https : http; }

/** 匿名 GET 页面文本（跟随重定向；不带任何 Cookie）。 */
function fetchText(url, redirects) {
  return new Promise((resolve, reject) => {
    const req = pickRequestor(url).request(url, {
      method: 'GET',
      headers: { 'User-Agent': UA, Accept: 'text/html,application/json' }
    });
    req.setTimeout(15000, () => req.destroy(new Error('请求超时')));
    req.on('response', (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 3) {
        res.resume();
        resolve(fetchText(new URL(res.headers.location, url).toString(), redirects + 1));
        return;
      }
      if (res.statusCode >= 400) {
        res.resume();
        reject(new Error('HTTP ' + res.statusCode));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ text: body, url: res.responseUrl || url, status: res.statusCode }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

/** 通用公开数据提取：只匹配公开白名单字段（name/size/dir），括号配对截取 JSON 子串。 */
function extractPublicFileList(text) {
  const files = [];
  if (!text) return files;
  const keyRe = /["']?(?:fileList|files|file_list)["']?\s*:\s*(\[)/g;
  let m;
  let guard = 0;
  while ((m = keyRe.exec(text)) && guard++ < 5) {
    const start = m.index + m[0].length;
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let i = start - 1; i < text.length && i < start + 500000; i++) {
      const ch = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === '[' || ch === '{') depth++;
      else if (ch === ']' || ch === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    if (end < 0) continue;
    const slice = text.slice(start - 1, end);
    try {
      const parsed = JSON.parse(slice);
      if (Array.isArray(parsed)) {
        for (const it of parsed) {
          if (it && typeof it === 'object' && typeof it.name === 'string' && it.name) {
            files.push({
              name: it.name.slice(0, 255),
              size: Number.isFinite(Number(it.size)) ? Number(it.size) : null,
              isDir: !!(it.dir || it.is_dir || it.isdir),
              directUrl: null // 匿名直链不可得
            });
          }
        }
      }
    } catch (e) { /* 放弃该子串 */ }
    if (files.length) break;
  }
  return files;
}

/** 提取码：仅调用分享页同源的公开校验接口（通用同源表单提交，无任何签名）。 */
async function verifyCode(pageUrl, code) {
  const u = new URL(pageUrl);
  const endpoint = u.origin + u.pathname;
  const body = new URLSearchParams({ passcode: String(code || '') });
  return new Promise((resolve, reject) => {
    const req = pickRequestor(u.origin + '/').request(endpoint, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: pageUrl
      }
    });
    req.setTimeout(15000, () => req.destroy(new Error('请求超时')));
    req.on('response', (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { b += d; });
      res.on('end', () => resolve({ status: res.statusCode, text: b }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body.toString());
  });
}

async function resolve(link, code) {
  let page;
  try {
    page = await fetchText(link, 0);
  } catch (e) {
    throw { code: 'PARSER_FETCH', message: '访问分享页失败：' + (e.message || '网络错误') };
  }
  const text = page.text || '';
  if (/请登录|登录夸克|立即登录|手机号登录|扫码登录/i.test(text.slice(0, 20000))) {
    throw { code: 'PARSER_LOGIN_REQUIRED', message: COMPLIANCE_ERROR };
  }
  let files = extractPublicFileList(text);
  if (!files.length) {
    if (/提取码|访问码|passcode|输入密码/i.test(text.slice(0, 20000))) {
      if (!code) {
        throw { code: 'SHARE_CODE_REQUIRED', message: '该分享需要提取码，请输入后重试' };
      }
      try {
        const res = await verifyCode(page.url || link, code);
        files = extractPublicFileList(res.text || '');
      } catch (e) {
        throw { code: 'PARSER_FETCH', message: '提取码校验请求失败：' + (e.message || '') };
      }
    }
  }
  if (!files.length) {
    throw { code: 'PARSER_NO_ANON', message: COMPLIANCE_ERROR };
  }
  return {
    provider: 'quark',
    title: (files[0] && files[0].name) || '夸克网盘分享',
    needsCode: !code,
    files: files.map((f) => ({
      name: f.name,
      size: f.size,
      directUrl: f.directUrl,   // 匿名直链不可得时为 null，渲染层将提示使用官方客户端
      headers: {}
    }))
  };
}

module.exports = { resolve };
