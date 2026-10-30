/* GPL-3.0-or-later */
(() => {
  'use strict';
  if (globalThis.WTPage) return;
  const C = WTCore;
  const textState = WTText;
  const protectedSelector = 'script,style,noscript,pre,code,kbd,samp,textarea,input,select,option,[contenteditable]:not([contenteditable="false"]),[translate="no"],.notranslate,[role="textbox"],[role="log"],[role="feed"],[data-private],[data-sensitive],[data-device-name],[data-username],[data-token],[data-secret],.device-name,.device_name,.username,.user-name,.account-name,.account-id,.monaco-editor,.cm-editor,.CodeMirror';
  const managedNodes = new Set();
  const managedAttributes = new Map();
  const attributeNames = ['placeholder','aria-label','title'];
  let captureTimer, capturePending = false, captureAgain = false, lastCapture = '', captureRetries = 0;
  function scheduleCapture(delay=150) {
    if(!captureTimer)captureTimer=setTimeout(()=>{captureTimer=null;capture();},delay);
  }
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
    if (!state?.captureId) return;
    if (capturePending) {captureAgain=true;return;}
    const captureId=state.captureId;
    const scan=collect(), signature=JSON.stringify(scan);
    if(signature===lastCapture)return;
    capturePending=true;
    try {
      const r=await chrome.runtime.sendMessage({type:'wt:capture-data',captureId,scan});
      if(r?.ok && r.result===true && state?.captureId===captureId){lastCapture=signature;captureRetries=0;}
      else if(!r?.ok && state?.captureId===captureId && captureRetries++<2)scheduleCapture(500);
    }
    catch {if(state?.captureId===captureId && captureRetries++<2)scheduleCapture(500);}
    finally {capturePending=false;if(captureAgain){captureAgain=false;scheduleCapture(0);}}
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
  function allowed(node,selected=false) {
    const el = node.parentElement;
    const identity=`${el?.className || ''} ${el?.id || ''}`;
    return el && !el.closest(protectedSelector) && !el.closest('[hidden],[aria-hidden="true"]') && !/(?:user|account|device|machine|host)[-_]?(?:name|id)(?:\b|_)/i.test(identity) && (selected || !/(?:user|account|device|machine|hostname|identifier|address|token|secret)(?:[-_ ]?name|[-_ ]?id)?/i.test(identity));
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
  // Keep an adjacent email entirely local. Only a colon-delimited label is a reusable entry.
  function emailLabel(value){
    const match=/^(\s*)([^:\r\n@]{1,120}?)(\s*:\s*[\w.+-]+@[\w.-]+\.[a-z]{2,}\s*)$/i.exec(value);
    if(!match || protectedText(match[2]))return null;
    return {sourceText:match[2],leading:match[1],suffix:match[3],end:match[1].length+match[2].length,mailStart:value.indexOf('@')-value.slice(0,value.indexOf('@')).match(/[\w.+-]+$/)[0].length};
  }
  function nodes() {
    const list = [], walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) { const n = walker.currentNode;
      if(!allowed(n,true) || protectedText(original(n)))continue;
      if(allowed(n) || state?.site?.entries[C.entryKey({path:location.pathname,context:context(n),sourceText:template(n).sourceText,targetLanguage:state.site.targetLanguage})]?.userSelected===true)list.push(n);
    }
    for (const n of managedNodes) if (!n.isConnected) managedNodes.delete(n);
    return list;
  }
  function collect() {
    if (state?.site?.excludedPaths.some(p => location.pathname.startsWith(p))) return { origin: location.origin, path:location.pathname, items: [], truncated: false };
    const items = new Map(); let size = 0, truncated = false, reused=0;
    const limits=C.captureLimits(state?.captureLimits),site=state?.site,reuse=C.reuseIndex(site?.entries || {});
    const known=item=>{const target={...item,targetLanguage:site?.targetLanguage || 'zh-Hans'};const cached=site?.entries[C.entryKey(target)] || C.reusableEntry(site?.entries || {},target,reuse);if(cached){reused++;return true;}return false;};
    for (const node of nodes()) {
      if (textState.owner(node) === 'builtin') continue;
      const item = { sourceText: template(node).sourceText, context: context(node), path: location.pathname };
      if(known(item))continue;
      const key = C.canonical(item); if (items.has(key)) continue;
      if (items.size >= limits.pageCaptureItems || size + item.sourceText.length > limits.pageCaptureChars) { truncated = true; break; }
      size += item.sourceText.length; items.set(key, { id: `t${items.size}`, ...item });
    }
    for (const {sourceText,context,path} of attributeItems()) {
      const item={sourceText,context,path},key=C.canonical(item); if(known(item) || items.has(key))continue;
      if(items.size>=limits.pageCaptureItems || size+sourceText.length>limits.pageCaptureChars){truncated=true;break;}
      size+=sourceText.length;items.set(key,{id:`t${items.size}`,...item});
    }
    return { origin: location.origin, path:location.pathname, items: [...items.values()], truncated, reused };
  }
  function restore() {
    for(const [el,names] of managedAttributes) if(el.isConnected) for(const name of names) textState.restoreAttribute(el,name,'managed');
    managedAttributes.clear();
    for (const node of managedNodes) if (node.isConnected) {textState.restore(node, 'managed');textState.restore(node,'managed-selected');}
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
        if (textState.owner(node) === 'builtin' && !entry.userSelected) continue;
        let translated = entry.translation;
        for (const [token, value] of shaped.values) translated = translated.split(token).join(value);
        textState.writeText(node, translated, entry.userSelected?'managed-selected':'managed'); managedNodes.add(node); count++;
      }
      const walker=document.createTreeWalker(document.body || document.documentElement,NodeFilter.SHOW_TEXT);
      while(walker.nextNode()){
        const node=walker.currentNode;if(!allowed(node,true))continue;
        const label=emailLabel(original(node));if(!label)continue;
        const entry=s.entries[C.entryKey({path:location.pathname,context:context(node)+'/@label-prefix',sourceText:label.sourceText,targetLanguage:s.targetLanguage})];
        if(entry?.userSelected!==true || entry.action!=='translate')continue;
        textState.writeText(node,label.leading+entry.translation+label.suffix,'managed-selected');managedNodes.add(node);count++;
      }
      if (count) { originalLang = document.documentElement.getAttribute('lang'); langSet = s.targetLanguage; document.documentElement.lang = langSet; document.head?.append(marker); }
    } finally { applying = false; observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['contenteditable','translate','class','hidden','aria-hidden',...attributeNames] }); }
  }
  const observer = new MutationObserver(() => {
    clearTimeout(timer); timer = setTimeout(apply, 80);
    scheduleCapture();
  });
  observer.observe(document, { subtree: true, childList: true, characterData: true });
  function update(next) {
    if(next.captureId!==state?.captureId){lastCapture='';captureRetries=0;}
    const old = state?.site; state = next;
    if (old?.builtinId && (old.enabled !== next.site?.enabled || old.deleted !== next.site?.deleted || old.targetLanguage !== next.site?.targetLanguage || JSON.stringify(old.excludedPaths) !== JSON.stringify(next.site?.excludedPaths))) { location.reload(); return; }
    apply();
    capture();
  }
  let selectionSnapshot=null,noticeTimer;
  function selectedSnapshot(){
    const selection=getSelection();if(!selection?.rangeCount || selection.isCollapsed)return null;
    const range=selection.getRangeAt(0),items=[],seen=new Set();let size=0,blocked=0;
    const walker=document.createTreeWalker(document.body || document.documentElement,NodeFilter.SHOW_TEXT);
    while(walker.nextNode()){
      const node=walker.currentNode;
      if(!range.intersectsNode(node) || (range.startContainer===node && range.startOffset===node.length) || (range.endContainer===node && range.endOffset===0) || !original(node).trim())continue;
      if(!allowed(node,true)){blocked++;continue;}
      let item={sourceText:template(node).sourceText,context:context(node),path:location.pathname};
      if(protectedText(original(node))){
        const label=emailLabel(original(node)),visible=emailLabel(node.data);
        const start=range.startContainer===node?range.startOffset:0,end=range.endContainer===node?range.endOffset:node.length;
        if(!label || !visible || start>=visible.end || end>visible.mailStart){blocked++;continue;}
        item={sourceText:label.sourceText,context:context(node)+'/@label-prefix',path:location.pathname};
      }
      const key=C.canonical(item);if(seen.has(key))continue;seen.add(key);
      size+=item.sourceText.length;
      if(items.length>=500 || size>80000)return {error:'选中文字过多，请缩小选区后重试'};
      items.push({node,original:original(node),contextBase:context(node),item});
    }
    return {raw:selection.toString(),path:location.pathname,time:Date.now(),items,blocked};
  }
  document.addEventListener('contextmenu',()=>{selectionSnapshot=selectedSnapshot();},true);
  function selectionItems(raw){
    const snapshot=selectionSnapshot || selectedSnapshot();selectionSnapshot=null;
    if(snapshot?.error)throw new Error(snapshot.error);
    if(!snapshot || snapshot.path!==location.pathname || Date.now()-snapshot.time>60000 || snapshot.raw.trim()!==String(raw || '').trim())throw new Error('选区已改变，请重新选择文字并右键添加');
    if(snapshot.items.some(({node,original:source,contextBase})=>!node.isConnected || !allowed(node,true) || original(node)!==source || context(node)!==contextBase))throw new Error('网页内容已改变，请重新选择');
    if(!snapshot.items.length)throw new Error('未找到可添加的普通页面文字；输入、代码、受保护内容和内置词库已覆盖内容不加入待翻译');
    return {origin:location.origin,path:location.pathname,items:snapshot.items.map(({item})=>item),blocked:snapshot.blocked};
  }
  function notice(message){
    let el=document.getElementById('wt-selection-notice');
    if(!el){el=document.createElement('div');el.id='wt-selection-notice';el.setAttribute('data-private','');el.setAttribute('role','status');el.style.cssText='position:fixed;right:20px;bottom:20px;z-index:2147483647;max-width:420px;padding:14px 18px;background:#172c43;color:#fff;border-radius:10px;font:14px/1.6 sans-serif;box-shadow:0 6px 24px #0004';document.documentElement.append(el);}
    el.textContent=message;clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>el.remove(),8000);
  }
  chrome.runtime.onMessage.addListener((m, sender, reply) => {
    if (sender.id !== chrome.runtime.id) return;
    if(m.type==='wt:selection'){try{reply({ok:true,result:selectionItems(m.selectionText)});}catch(e){reply({ok:false,error:e.message});}return false;}
    if(m.type==='wt:selection-notice'){notice(m.message);return false;}
    if (m.type === 'wt:collect') { if(m.site)state={...state,site:m.site,captureLimits:m.captureLimits || state?.captureLimits};reply(collect()); return false; }
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
