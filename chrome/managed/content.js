/* GPL-3.0-or-later */
(() => {
  'use strict';
  if (globalThis.WTPage) return;
  const C = WTCore;
  const textState = WTText;
  const protectedSelector = 'script,style,noscript,pre,code,kbd,samp,textarea,input,select,option,[contenteditable]:not([contenteditable="false"]),[translate="no"],.notranslate,[role="textbox"],[role="log"],[role="feed"],[data-private],[data-sensitive],[data-device-name],[data-username],.monaco-editor,.cm-editor,.CodeMirror';
  const managedNodes = new Set();
  const managedAttributes = new Map();
  const attributeNames = ['placeholder','aria-label','title'];
  let captureTimer, capturePending = false, lastCapture = '';
  function attributeItems() {
    const result=[];
    for(const el of document.querySelectorAll('[placeholder],[aria-label],[title]')) {
      if(el.closest('script,style,pre,code,[contenteditable]:not([contenteditable="false"]),[translate="no"],.notranslate,[data-private],[data-sensitive],[hidden],[aria-hidden="true"],[role="log"],[role="feed"]')) continue;
      for(const name of attributeNames) {
        const sourceText=textState.sourceAttribute(el,name);
        if(!sourceText || protectedText(sourceText) || textState.attributeOwner(el,name)==='builtin') continue;
        result.push({el,name,sourceText,context:`${el.closest('nav,header,footer,main,aside,dialog,form')?.tagName.toLowerCase() || 'page'}/${el.tagName.toLowerCase()}/@${name}`,path:location.pathname});
      }
    }
    return result;
  }
  async function capture() {
    if (!state?.captureId || capturePending) return;
    const scan=collect(), signature=JSON.stringify(scan);
    if(signature===lastCapture)return;
    capturePending=true;
    try { const r=await chrome.runtime.sendMessage({type:'wt:capture-data',captureId:state.captureId,scan}); if(r?.ok)lastCapture=signature; }
    catch {} finally { capturePending=false; }
  }
  let state = null, applying = false, timer, originalLang, langSet = null, lastRoute = location.pathname;
  const marker = document.createElement('meta'); marker.name = 'google'; marker.content = 'notranslate'; marker.dataset.websiteTranslator = 'managed';
  function protectedText(value) {
    return !value.trim() || value.length > 4096 || /(?:https?:\/\/|www\.|\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b|\b\d{1,3}(?:\.\d{1,3}){3}\b|[A-Z]:\\|\/[\w.-]+\/|\b[0-9a-f]{8}-[0-9a-f-]{27,}\b|\b[A-Za-z0-9_-]{32,}\b)/i.test(value);
  }
  function context(node) {
    const el = node.parentElement;
    const landmark = el.closest('nav,header,footer,main,aside,dialog,form,[role="navigation"],[data-sidebar]');
    const region=landmark?.matches('[role="navigation"],[data-sidebar]')?'nav':landmark?.tagName.toLowerCase() || 'page';
    return `${region}/${el.tagName.toLowerCase()}/${el.getAttribute('role') || 'text'}`.slice(0,256);
  }
  function allowed(node) {
    const el = node.parentElement;
    return el && !el.closest(protectedSelector) && !el.closest('[hidden],[aria-hidden="true"]') && !/(?:user|account|device|machine|hostname|identifier|address|token|secret)(?:[-_ ]?name|[-_ ]?id)?/i.test(`${el.className || ''} ${el.id || ''}`);
  }
  function original(node) {
    return textState.source(node);
  }
  function template(node) {
    const source = original(node), values = [];
    // Numeric templates are limited to explicit UI regions; arbitrary prose is not generalized.
    if (!node.parentElement.closest('nav,button,[role="button"],[role="status"],[role="tab"]') || source.includes('{WTN')) return { sourceText: source, values };
    const sourceText = source.replace(/(?<![\w{])\d+(?:[.,]\d+)?(?![\w}])/g, value => {
      const token = `{WTN${values.length}}`; values.push([token, value]); return token;
    });
    return { sourceText, values };
  }
  function nodes() {
    const list = [], walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) { const n = walker.currentNode; if (allowed(n) && !protectedText(original(n))) list.push(n); }
    for (const n of managedNodes) if (!n.isConnected) managedNodes.delete(n);
    return list;
  }
  function collect() {
    if (state?.site?.excludedPaths.some(p => location.pathname.startsWith(p))) return { origin: location.origin, items: [], truncated: false };
    const items = new Map(); let size = 0, truncated = false;
    for (const node of nodes()) {
      if (textState.owner(node) === 'builtin') continue;
      const item = { sourceText: template(node).sourceText, context: context(node), path: location.pathname };
      const key = C.canonical(item); if (items.has(key)) continue;
      if (items.size >= 500 || size + item.sourceText.length > 80000) { truncated = true; break; }
      size += item.sourceText.length; items.set(key, { id: `t${items.size}`, ...item });
    }
    for (const {sourceText,context,path} of attributeItems()) {
      const item={sourceText,context,path},key=C.canonical(item); if(items.has(key))continue;
      if(items.size>=500 || size+sourceText.length>80000){truncated=true;break;}
      size+=sourceText.length;items.set(key,{id:`t${items.size}`,...item});
    }
    return { origin: location.origin, items: [...items.values()], truncated };
  }
  function restore() {
    for(const [el,names] of managedAttributes) if(el.isConnected) for(const name of names) textState.restoreAttribute(el,name,'managed');
    managedAttributes.clear();
    for (const node of managedNodes) if (node.isConnected) textState.restore(node, 'managed');
    managedNodes.clear();
    marker.remove();
    if (langSet && document.documentElement.lang === langSet) {
      if (originalLang === null) document.documentElement.removeAttribute('lang'); else document.documentElement.lang = originalLang;
    }
    langSet = null;
  }
  function apply() {
    if (!document.documentElement || applying) return;
    applying = true; observer.disconnect();
    try {
      restore();
      const s = state?.site;
      if (!s || s.deleted || !s.enabled || state.globalEnabled === false || s.excludedPaths.some(p => location.pathname.startsWith(p))) return;
      let count = 0;
      const reuse=C.reuseIndex(s.entries);
      for(const item of attributeItems()) {
        const target={...item,targetLanguage:s.targetLanguage},entry=s.entries[C.entryKey(target)] || C.reusableEntry(s.entries,target,reuse);
        if(entry?.action!=='translate')continue;
        textState.writeAttribute(item.el,item.name,entry.translation,'managed');
        if(!managedAttributes.has(item.el))managedAttributes.set(item.el,new Set());
        managedAttributes.get(item.el).add(item.name);count++;
      }
      for (const node of nodes()) {
        const shaped = template(node), key = C.entryKey({ path: location.pathname, context: context(node), sourceText: shaped.sourceText, targetLanguage: s.targetLanguage });
        const entry = s.entries[key] || C.reusableEntry(s.entries,{path:location.pathname,context:context(node),sourceText:shaped.sourceText,targetLanguage:s.targetLanguage},reuse);
        if (!entry || entry.action !== 'translate') continue;
        // Existing hand-maintained builtin translations win over AI additions.
        if (textState.owner(node) === 'builtin') continue;
        let translated = entry.translation;
        for (const [token, value] of shaped.values) translated = translated.split(token).join(value);
        textState.writeText(node, translated, 'managed'); managedNodes.add(node); count++;
      }
      if (count) { originalLang = document.documentElement.getAttribute('lang'); langSet = s.targetLanguage; document.documentElement.lang = langSet; document.head?.append(marker); }
    } finally { applying = false; observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['contenteditable','translate','class','hidden','aria-hidden',...attributeNames] }); }
  }
  const observer = new MutationObserver(() => {
    clearTimeout(timer); timer = setTimeout(apply, 80);
    if(!captureTimer)captureTimer=setTimeout(()=>{captureTimer=null;capture();},150);
  });
  observer.observe(document, { subtree: true, childList: true, characterData: true });
  function update(next) {
    if(next.captureId!==state?.captureId)lastCapture='';
    const old = state?.site; state = next;
    if (old?.builtinId && (old.enabled !== next.site?.enabled || old.deleted !== next.site?.deleted || old.targetLanguage !== next.site?.targetLanguage || JSON.stringify(old.excludedPaths) !== JSON.stringify(next.site?.excludedPaths))) { location.reload(); return; }
    apply();
    capture();
  }
  chrome.runtime.onMessage.addListener((m, sender, reply) => {
    if (sender.id !== chrome.runtime.id) return;
    if (m.type === 'wt:collect') { reply(collect()); return false; }
    if (m.type === 'wt:apply') update(m);
  });
  globalThis.WTPage = { collect, apply, protectedText };
  chrome.runtime.sendMessage({ type: 'wt:page' }).then(r => { if (r.ok) update(r.result); }).catch(() => {});
  document.addEventListener('DOMContentLoaded', apply, { once: true });
  setInterval(() => { if (lastRoute !== location.pathname) {
    const excluded = p => state?.site?.excludedPaths.some(prefix => p.startsWith(prefix));
    if (state?.site?.builtinId && excluded(lastRoute) !== excluded(location.pathname)) { location.reload(); return; }
    lastRoute = location.pathname; apply(); capture();
  } }, 500);
})();
