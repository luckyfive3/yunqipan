/* init.js —— 渲染层启动引导
 * 职责：在所有页面脚本（window 命名空间）挂载完成后启动应用壳。
 * （CSP script-src 'self' 禁止内联脚本，故引导逻辑独立成文件）
 */
window.addEventListener('DOMContentLoaded', function () {
  window.App.init();
});
