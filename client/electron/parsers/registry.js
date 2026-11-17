'use strict';
/**
 * registry.js —— 解析器注册表与路由
 *
 * 职责：
 *   1. 注册各链接适配器，resolve(link, code) 按 URL 路由分发：
 *      - http(s):// 直链            → http-direct
 *      - pan.baidu.com / *.baidu.com/s/* → baidu（受 settings.parsers.baidu 开关控制）
 *      - pan.quark.cn               → quark（受 settings.parsers.quark 开关控制）
 *      - 自家服务端 /s/{token} 分享链接 → 返回 {type:'share', token}，由 parse.js（IPC 层）
 *        特判走服务端 shares.resolve，绝不走第三方解析。
 *   2. 【合规硬性要求】整个解析模块默认禁用（settings.parsers 全 false），
 *      禁用不影响任何私有云盘功能；未启用的适配器直接返回中文错误提示。
 *   3. 所有适配器只处理“匿名访客可见”的公开资源；不实现任何签名算法、
 *      不使用/保存任何账号 Cookie。
 */
const httpDirect = require('./http-direct');
const baidu = require('./baidu');
const quark = require('./quark');

function createRegistry({ settings, api }) {
  const serverBase = () => String(settings.get('serverBase') || 'http://127.0.0.1:8080').replace(/\/+$/, '');

  function enabled(provider) {
    const parsers = settings.get('parsers') || {};
    return !!parsers[provider];
  }

  function route(link) {
    if (!link || typeof link !== 'string') {
      throw { code: 'INVALID_INPUT', message: '请输入要解析的链接' };
    }
    const l = link.trim().split('#')[0]; // 去掉 URL 片段（#list/path=... 仅客户端使用，不参与请求）
    // 自家服务端分享链接：/s/{token} → 交给服务端 shares.resolve（parse.js 特判）
    if (l.startsWith(serverBase() + '/s/')) {
      const token = l.slice((serverBase() + '/s/').length).split(/[/?#]/)[0];
      if (token) return { type: 'share', token };
    }
    if (/^https?:\/\//i.test(l)) {
      const host = (() => { try { return new URL(l).hostname; } catch (e) { return ''; } })();
      if (host === 'pan.baidu.com' || (host.endsWith('.baidu.com') && /\/s\//.test(l))) return { type: 'baidu', link: l };
      if (host === 'pan.quark.cn') return { type: 'quark', link: l };
      return { type: 'http-direct', link: l };
    }
    // 浏览器「复制为 cURL(bash)」命令 → 直链解析器（提取用户自会话的官方下载链接）
    if (/^curl\s/i.test(l)) return { type: 'http-direct', link: l };
    throw { code: 'NOT_SUPPORTED', message: '不支持的链接类型：仅支持 http(s) 直链、百度/夸克公开分享页或云栖盘分享链接' };
  }

  async function resolve(link, code) {
    const r = route(link);
    if (r.type === 'share') return r;
    if (r.type === 'http-direct') return httpDirect.resolve(r.link, code);
    if (r.type === 'baidu') {
      if (!enabled('baidu')) {
        throw {
          code: 'PARSER_DISABLED',
          message: '百度网盘解析器未启用（默认关闭，可在设置中开启；请自行确认符合平台条款）'
        };
      }
      return baidu.resolve(r.link, code);
    }
    if (r.type === 'quark') {
      if (!enabled('quark')) {
        throw {
          code: 'PARSER_DISABLED',
          message: '夸克网盘解析器未启用（默认关闭，可在设置中开启；请自行确认符合平台条款）'
        };
      }
      return quark.resolve(r.link, code);
    }
    throw { code: 'NOT_SUPPORTED', message: '不支持的链接类型' };
  }

  return { resolve, route };
}

module.exports = { createRegistry };
