// 内容脚本、弹窗和设置页共用开关逻辑。每站点单独存储，避免多窗口保存互相覆盖。
(() => {
  'use strict';
  const keyFor = id => `site_enabled_${id}`;
  const defaults = Object.fromEntries(SUPPORTED_SITES.map(site => [keyFor(site.id), true]));
  defaults.enable_extension = true;
  const listeners = new Set();
  const pending = {};
  let settings = null;
  let managedSite = null;

  function matches(pattern) {
    const [scheme, rest] = pattern.split('://');
    const host = rest.slice(0, -2);
    return location.protocol === `${scheme}:` && (location.hostname === host ||
      (host.startsWith('*.') && (location.hostname === host.slice(2) || location.hostname.endsWith(host.slice(1)))));
  }
  const currentSite = SUPPORTED_SITES.find(site => site.matches.some(matches));
  function isEnabled(values = settings, id = currentSite?.id) {
    if(globalThis.WTLoadDictionary && (!managedSite || managedSite.dictionaryAvailable===false))return false;
    const managedEnabled = !managedSite || (!managedSite.deleted && managedSite.enabled && managedSite.targetLanguage === 'zh-Hans' && !managedSite.excludedPaths.some(p => location.pathname.startsWith(p)));
    return managedEnabled && !!values && !!id && values.enable_extension !== false && (!!managedSite || values[keyFor(id)] !== false);
  }
  function notify(previous) {
    for (const listener of listeners) listener(settings, previous);
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    const updates = {};
    for (const [key, change] of Object.entries(changes)) {
      if (key in defaults) updates[key] = change.newValue ?? defaults[key];
    }
    if (!Object.keys(updates).length) return;
    if (!settings) Object.assign(pending, updates);
    else {
      const previous = settings;
      settings = { ...settings, ...updates };
      notify(previous);
    }
  });
  const ready = chrome.storage.sync.get(defaults).then(async values => {
    if (globalThis.WTCore && currentSite && chrome.runtime?.sendMessage) {
      const response = await chrome.runtime.sendMessage({ type: 'wt:page' });
      if (response?.ok) managedSite = response.result.site;
    }
    settings = { ...defaults, ...values, ...pending };
    notify(null);
    return settings;
  });
  // 即便没有订阅者，也不产生未处理的 Promise 拒绝；调用方仍能捕获 ready 的错误。
  ready.catch(error => console.warn('[网站翻译] 读取网站开关失败', error));
  globalThis.FixedSitePreferences = {
    currentSite, keyFor, isEnabled, ready,
    get settings() { return settings; },
    subscribe(listener) {
      listeners.add(listener);
      if (settings) listener(settings, null);
      return () => listeners.delete(listener);
    }
  };
})();
