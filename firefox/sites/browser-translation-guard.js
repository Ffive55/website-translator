// 在已注册站点的 document_start 阶段运行，防止浏览器自动翻译与词库互相覆盖。
// 使用 Chromium 支持的 meta 标记，不给 html/body 设置 translate=no，避免影响本插件。
(() => {
  'use strict';
  const preferences = globalThis.FixedSitePreferences;
  if (!preferences?.currentSite) return;
  let enabled = false;
  const marker = document.createElement('meta');
  marker.name = 'google';
  marker.content = 'notranslate';
  marker.dataset.fixedSiteTranslation = 'browser-guard';

  function maintain() {
    if (enabled && document.head && !marker.isConnected) document.head.append(marker);
  }
  const observer = new MutationObserver(maintain);
  function apply() {
    observer.disconnect();
    if (enabled) {
      maintain();
      // 兼容 HTML 尚未解析，以及 SPA 替换 head 的情况。
      observer.observe(document, { childList: true, subtree: true });
    } else {
      marker.remove();
    }
  }
  preferences.subscribe((settings, previous) => {
    enabled = preferences.isEnabled(settings);
    apply();
    // 全页恢复是必要的：GitHub 会改变 lang 和大量文本，浏览器也需重新检测原文语言。
    // 初次读取配置不刷新；只有当前站点的实际启用状态变化才刷新一次。
    if (previous && preferences.isEnabled(previous) !== enabled) window.location.reload();
  });
})();
