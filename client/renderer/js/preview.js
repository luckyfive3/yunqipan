/* preview.js —— 在线预览弹层（window.Preview）
 * 职责：对可预览文件先 POST /files/{id}/preview-token 换取临时 URL（iframe 免 Bearer），
 *       再在 iframe 中展示图片/视频/音频/PDF/文本/Markdown 等；
 *       加密文件隐藏预览入口，服务端对非白名单类型返回 415。
 */
(function () {
  'use strict';

  var Preview = {
    init: function () { /* 弹层按需创建，无需预绑定 */ },

    open: async function (file) {
      if (!file || file.is_dir) return;
      if (file.encrypted) {
        UI.toast('加密文件不支持在线预览（可下载后本地解密查看）', 'warn');
        return;
      }
      if (!UI.previewable(file)) {
        UI.toast('该文件类型不支持在线预览', 'warn');
        return;
      }
      var data = await UI.wp('files:previewToken', { id: file.id, ttlSeconds: 300 });
      if (!data || !data.url) return;

      var mask = UI.openModal({
        title: file.name,
        wide: true,
        // 注意：iframe 不设 sandbox —— Chromium 内置 PDF 查看器等插件在沙箱 iframe 中无法渲染；
        // 内容来自「本人文件 + 临时签名 token」的预览接口，风险可控。
        body: '<iframe class="preview-frame" referrerpolicy="no-referrer"></iframe>',
        buttons: [
          { label: '下载此文件', cls: 'primary', onClick: function () { Files.download(file); } },
          { label: '关闭', cls: 'ghost' }
        ]
      });
      mask.querySelector('iframe').src = data.url;
    }
  };

  window.Preview = Preview;
})();
