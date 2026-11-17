'use strict';
/**
 * baidu.js —— 百度网盘公开分享解析器（合规骨架）
 *
 * 【合规边界（硬性要求，本文件严格遵守）】
 *   1. 只允许：GET 匿名公开分享页（无需登录、不携带任何账号 Cookie），
 *      从页面公开内嵌的 JSON / 初始数据中提取「匿名访客可见」的文件列表。
 *   2. 提取码：仅提示用户输入，并只调用该公开页面自身同源的「公开校验接口」；
 *      本实现只做“同源表单提交”这一通用动作，不包含任何签名算法。
 *   3. 绝不实现任何逆向签名（如 logid、sign 等算法）；绝不使用/保存任何账号 Cookie；
 *      绝不涉及会员 / VIP / 私密资源破解。
 *   4. 当页面要求登录、或不存在匿名直链时，一律抛中文错误：
 *      『该资源不提供匿名公开直链，按合规要求无法解析，请使用官方客户端』。
 *
 * 说明：网盘页面结构随平台改版而变，本骨架的「公开 JSON 提取」是通用实现：
 *   只做最保守的子串匹配（在 <script> 文本中寻找形如 "file_list":[...] 的公开字段），
 *   字段一律白名单（name/size/isdir），正则提取 JSON 子串极其谨慎——仅截取公开字段值，
 *   不含任何密钥/算法。默认禁用，用户需在设置中自行开启并承担平台条款责任。
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
    req.setTimeout(10000, () => req.destroy(new Error('请求超时')));
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
      res.on('data', (d) => {
        if (body.length < 2000000) body += d; // 页面体积上限 2MB，防止异常大响应拖垮进程
      });
      res.on('end', () => resolve({ text: body, url: res.responseUrl || url, status: res.statusCode }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * 通用公开数据提取：
 * 只在页面文本中寻找公开字段白名单（name/size/isdir），逐字符谨慎匹配
 * "file_list" 之类的公开数组子串，并尽力用括号配对法截取完整 JSON 对象/数组。
 * 不解析任何签名字段，不做任何解密/还原。
 */
function extractPublicFileList(text) {
  const files = [];
  if (!text) return files;
  const keyRe = /["']?(?:file_list|fileList|list|fileListArr)["']?\s*:\s*(\[)/g;
  let m;
  let guard = 0;
  while ((m = keyRe.exec(text)) && guard++ < 5) {
    const start = m.index + m[0].length; // 指向 '['
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
    // 仅提取公开白名单字段；解析失败则放弃该子串，绝不猜测
    try {
      const parsed = JSON.parse(slice);
      if (Array.isArray(parsed)) {
        for (const it of parsed) {
          if (it && typeof it === 'object' && typeof it.name === 'string' && it.name) {
            files.push({
              name: it.name.slice(0, 255),
              size: Number.isFinite(Number(it.size)) ? Number(it.size) : null,
              isDir: !!it.isdir,
              directUrl: null // 匿名直链存在与否由页面决定；默认无
            });
          }
        }
      }
    } catch (e) { /* 非标准 JSON：放弃，走合规错误 */ }
    if (files.length) break;
  }
  return files;
}

/** 提取码：仅调用分享页同源的公开校验接口（通用同源表单提交，无任何签名）。 */
async function verifyCode(pageUrl, code) {
  const u = new URL(pageUrl);
  const origin = u.origin;
  const endpoint = origin + u.pathname; // 同源公开页面自身；真实平台如需专用接口由用户确认后替换
  const body = new URLSearchParams({ pwd: String(code || ''), vcode: '', verify: '1' });
  return new Promise((resolve, reject) => {
    const req = pickRequestor(origin + '/').request(endpoint, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: pageUrl
      }
    });
    req.setTimeout(10000, () => req.destroy(new Error('请求超时')));
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
  // 登录墙 / 私密资源判定：出现这些公开标记即视为需要账号，按合规要求拒绝
  if (/请登录|立即登录|登录百度|passport\.baidu\.com|用户登录|登录后查看/i.test(text.slice(0, 20000))) {
    throw { code: 'PARSER_LOGIN_REQUIRED', message: COMPLIANCE_ERROR };
  }
  let files = extractPublicFileList(text);
  if (!files.length) {
    // 公开页面带提取码：要求用户输入，仅做同源公开校验
    if (/提取码|请输入提取码|access-code|pwd/i.test(text.slice(0, 20000))) {
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
    provider: 'baidu',
    title: (files[0] && files[0].name) || '百度网盘分享',
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
