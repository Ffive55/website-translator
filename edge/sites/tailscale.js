// 自动生成，请修改 sites/tailscale/site.json 和 extension/site-runtime.js
(() => {
const SITE = {
  "id": "tailscale",
  "name": "Tailscale",
  "matches": [
    "https://tailscale.com/*",
    "https://www.tailscale.com/*",
    "https://login.tailscale.com/*",
    "https://console.tailscale.com/*"
  ]
};
// SITE 由构建器注入；不加载远程词库，不执行配置中的脚本。
'use strict';

const protectedSelector = [
  'script', 'style', 'noscript', 'code', 'pre', 'kbd', 'samp', 'textarea', 'option:not([value])',
  'svg', 'math', '[contenteditable]:not([contenteditable="false"])',
  '[translate="no"]', '.notranslate', '.monaco-editor', '.cm-editor', '.CodeMirror'
].join(',');
let attributes = SITE.attributes || ['title', 'placeholder', 'aria-label'];
const originals = new WeakMap();
const pending = new Set();
let enabled = false;
let timer = null;
let pageUrl = location.href;
let config;
let observer;

function normalizeText(text) {
  return text.replace(/\s+/g, ' ').replace(/[‘’]/g, "'").replace(/…/g, '...').trim();
}

function matchesUrl(pattern) {
  const [scheme, rest] = pattern.split('://');
  const host = rest.slice(0, -2);
  return location.protocol === `${scheme}:` && (location.hostname === host ||
    (host.startsWith('*.') && (location.hostname === host.slice(2) || location.hostname.endsWith(host.slice(1)))));
}

function pageConfig() {
  const pages = (SITE.pages || []).filter(page => page.exact
    ? location.pathname === page.pathPrefix : location.pathname.startsWith(page.pathPrefix));
  const blocks = [SITE, ...pages];
  // 后面的页面规则覆盖公共词条；页面 selectors 可以缩小翻译范围。
  const selectors = [...blocks].reverse().find(block => block.selectors !== undefined)?.selectors || [];
  const extraIgnore = blocks.flatMap(block => block.ignore || []);
  const ignore = [protectedSelector, ...extraIgnore].join(',');
  const attributeIgnore = [protectedSelector.split(',').filter(selector => selector !== 'svg').join(','), ...extraIgnore].join(',');
  const ignoreText = blocks.flatMap(block => block.ignoreText || []).join(',');
  for (const selector of [...selectors, ignore, ...(ignoreText ? [ignoreText] : [])]) document.querySelector(selector);
  const dictionary = Object.create(null);
  for (const block of blocks) {
    for (const [source, target] of Object.entries(block.dictionary || {})) {
      const key = normalizeText(source);
      dictionary[SITE.caseInsensitive ? key.toLowerCase() : key] = target;
    }
  }
  return {
    dictionary,
    regexp: blocks.slice().reverse().flatMap(block => (block.regexp || []).map(rule => ({
      expression: new RegExp(rule.pattern, rule.flags || ''), replacement: rule.replacement
    }))),
    selectors: selectors.join(','), ignore, ignoreText, attributeIgnore
  };
}

function translate(source) {
  const normalized = normalizeText(source);
  if (!normalized) return source;
  let translated = config.dictionary[SITE.caseInsensitive ? normalized.toLowerCase() : normalized];
  if (translated === undefined) {
    for (const rule of config.regexp) {
      const match = rule.expression.exec(normalized);
      // 正则只替换整个文本节点，避免局部词条污染邮箱、地址、设备名称。
      if (match && match.index === 0 && match[0] === normalized) {
        translated = normalized.replace(rule.expression, rule.replacement);
        break;
      }
    }
  }
  if (translated === undefined || translated === normalized) return source;
  return source.match(/^\s*/)[0] + translated + source.match(/\s*$/)[0];
}

function rewrite(node, key, current, write, active) {
  if (current === null) return;
  if (key === 'text' && globalThis.WTText) {
    const source = WTText.source(node);
    const output = active ? translate(source) : source;
    if (output !== source) WTText.writeText(node, output, 'builtin');
    // An unmatched manual rule must not undo a managed translation of the same node.
    else WTText.restore(node, 'builtin');
    return;
  }
  if (key !== 'text' && globalThis.WTText && ['placeholder','aria-label','title'].includes(key)) {
    const source=WTText.sourceAttribute(node,key);
    const output=active ? translate(source) : source;
    if(output!==source)WTText.writeAttribute(node,key,output,'builtin');
    else WTText.restoreAttribute(node,key,'builtin');
    return;
  }
  let records = originals.get(node);
  const previous = records?.get(key);
  // 站点自行重渲染后，以最新原文为准，不能回填旧设备状态。
  const source = previous && current === previous.output ? previous.source : current;
  const output = active ? translate(source) : source;
  if (output !== current) write(output);
  if (output !== source) {
    if (!records) originals.set(node, records = new Map());
    records.set(key, { source, output });
  } else {
    records?.delete(key);
  }
}

function handle(node) {
  const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  if (!element) return;
  const active = enabled && !element.closest(config.ignore) &&
    (!config.selectors || !!element.closest(config.selectors));
  if (node.nodeType === Node.TEXT_NODE) {
    const textActive = active && (!config.ignoreText || !element.closest(config.ignoreText));
    rewrite(node, 'text', node.data, value => { node.data = value; }, textActive);
  } else if (node.nodeType === Node.ELEMENT_NODE) {
    // SVG 图标的 aria-label/title 也是界面文案；只处理属性，仍保护图形和图中文字。
    const attributeActive = enabled && !element.closest(config.attributeIgnore) &&
      (!config.selectors || !!element.closest(config.selectors));
    for (const attribute of attributes) {
      rewrite(node, attribute, node.getAttribute(attribute), value => node.setAttribute(attribute, value), attributeActive);
    }
  }
}

function scan(root) {
  if (!root?.isConnected) return;
  handle(root);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) handle(walker.currentNode);
}

function observe() {
  if (!enabled) return;
  observer.observe(document.documentElement, {
    subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: [...attributes, 'class', 'id', 'contenteditable', 'translate']
  });
}

function flush() {
  timer = null;
  // disconnect 前必须保留刚刚到达的站点变更。
  collect(observer.takeRecords());
  observer.disconnect();
  const roots = [...pending];
  pending.clear();
  for (const root of roots) {
    if (!roots.some(other => other !== root && other.contains?.(root))) scan(root);
  }
  observe();
}

function schedule(root) {
  if (root) pending.add(root);
  if (timer === null) timer = window.setTimeout(flush, 60);
}

function collect(mutations) {
  for (const mutation of mutations) {
    if (mutation.type === 'childList') {
      mutation.addedNodes.forEach(node => pending.add(node));
    } else {
      pending.add(mutation.target);
    }
  }
}

function refreshRoute() {
  if (pageUrl === location.href) return;
  pageUrl = location.href;
  config = pageConfig();
  if (enabled) schedule(document.documentElement);
}

async function start() {
  if(globalThis.WTLoadDictionary) {
    const loaded=await globalThis.WTLoadDictionary();
    if(!loaded)return;
    Object.assign(SITE,loaded);attributes=SITE.attributes || attributes;
  }
  if (!SITE.matches.some(matchesUrl)) return;
  config = pageConfig();
  observer = new MutationObserver(mutations => {
    collect(mutations);
    if (pending.size) schedule();
  });
  chrome.runtime.onMessage.addListener(message => {
    if (message?.type === 'refresh-page') location.reload();
  });
  const preferences = globalThis.FixedSitePreferences;
  preferences.subscribe(settings => {
    enabled = preferences.isEnabled(settings, SITE.id);
    schedule(document.documentElement);
  });
  await preferences.ready;
  window.addEventListener('popstate', refreshRoute);
  window.addEventListener('hashchange', refreshRoute);
  // 内容脚本在隔离环境运行，轮询 URL 可兼容站点的 pushState 而无需改写站点代码。
  window.setInterval(refreshRoute, 500);
}

const launch = () => start().catch(error => console.error(`[网站翻译:${SITE.id}] 初始化失败`, error));
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', launch, { once: true });
else launch();

})();
