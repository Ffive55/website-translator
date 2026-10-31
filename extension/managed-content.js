/* GPL-3.0-or-later */
(() => {
  'use strict';
  if (globalThis.WTPage) return;
  const C = WTCore;
  const textState = WTText;
  const protectedSelector = 'script,style,noscript,pre,code,kbd,samp,textarea,input,select,option,[contenteditable]:not([contenteditable="false"]),[translate="no"],.notranslate,[role="textbox"],[role="log"],[role="feed"],[data-private],[data-sensitive],[data-device-name],[data-username],[data-token],[data-secret],.device-name,.device_name,.username,.user-name,.account-name,.account-id,.monaco-editor,.cm-editor,.CodeMirror';
  const managedNodes = new Set();
  const managedAttributes = new Map();
  const attributeNames = ['placeholder','aria-label','title','label'];
  const transientSelector = '[role="tooltip"],[role="menu"],[role="listbox"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="option"],[popover],[data-radix-popper-content-wrapper],[data-tippy-root],[data-base-ui-portal] [data-base-ui-focusable][data-side],[data-base-ui-portal] [role="dialog"]';
  const transientItems = new Map();
  let transientPath = location.pathname, transientSize = 0, transientTruncated = false;
  function resetTransient() { transientItems.clear();transientSize=0;transientTruncated=false;transientPath=location.pathname; }
  function hiddenOutsideUI(el) {
    for(let parent=el;parent;parent=parent.parentElement) {
      if(parent.matches('[hidden],[aria-hidden="true"]') && !parent.closest(transientSelector))return true;
    }
    return false;
  }
  function rememberTransient() {
    if(transientPath!==location.pathname)resetTransient();
    if(!state || state.globalEnabled===false || state.site?.enabled===false || state.site?.deleted || state.site?.excludedPaths.some(p=>location.pathname.startsWith(p))){resetTransient();return;}
    const limits=C.captureLimits(state.captureLimits);
    const entries=state.site?.entries || {},reuse=C.reuseIndex(entries);
    const known=item=>{const target={...item,targetLanguage:state.site?.targetLanguage || 'zh-Hans'};return entries[C.entryKey(target)] || C.reusableEntry(entries,target,reuse);};
    for(const [key,{node,root,item}] of transientItems)if(node.isConnected || root.isConnected || known(item)){transientSize-=item.sourceText.length;transientItems.delete(key);}
    // Retain only semantic popup text, locally and within the page's existing budget.
    for(const root of document.querySelectorAll(transientSelector)) {
      const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
      while(walker.nextNode()) {
        const node=walker.currentNode;
        if(!allowed(node) || protectedText(original(node)) || textState.owner(node)==='builtin')continue;
        const item={sourceText:template(node).sourceText,context:context(node),path:location.pathname};
        if(known(item))continue;
        const key=C.canonical(item),previous=transientItems.get(key);
        if(previous){transientSize-=previous.item.sourceText.length;transientItems.delete(key);}
        if(transientItems.size>=limits.pageCaptureItems || transientSize+item.sourceText.length>limits.pageCaptureChars){transientTruncated=true;continue;}
        transientItems.set(key,{node,root,item});transientSize+=item.sourceText.length;
      }
    }
  }
  let captureTimer, capturePending = false, captureAgain = false, lastCapture = '', captureRetries = 0;
  function scheduleCapture(delay=150) {
    if(!captureTimer)captureTimer=setTimeout(()=>{captureTimer=null;capture();},delay);
  }
  function attributeItems() {
    const result=[];
    for(const el of document.querySelectorAll('[placeholder],[aria-label],[title],select option,select optgroup')) {
      if(el.closest('script,style,pre,code,[contenteditable]:not([contenteditable="false"]),[translate="no"],.notranslate,[data-private],[data-sensitive],[data-device-name],[data-username],[data-token],[data-secret],.device-name,.username,.account-name,.account-id,[role="log"],[role="feed"]') || hiddenOutsideUI(el)) continue;
      if(el.matches('option,optgroup') && Array.from(ancestors(el)).some(p=>/(?:user|account|device|machine|hostname|identifier|address|token|secret)/i.test(`${p.className} ${p.id} ${p.getAttribute('name') || ''}`)))continue;
      for(const name of attributeNames) {
        if(name==='label' && !el.matches('option,optgroup'))continue;
        if(name==='label' && el.matches('option') && !textState.sourceAttribute(el,name) && Array.from(el.childNodes).some(node=>node.nodeType===Node.TEXT_NODE && textState.owner(node)==='builtin'))continue;
        // An option without value derives its submitted value from textContent.
        // Translate label instead, restoring the absent attribute when disabled.
        const sourceText=textState.sourceAttribute(el,name) || (name==='label' && el.matches('option') ? textState.content(el).replace(/\s+/g,' ').trim() : null);
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
  function* ancestors(el) { for(;el;el=el.parentElement)yield el; }
  function allowed(node,selected=false) {
    const el = node.parentElement;
    const identity=`${el?.className || ''} ${el?.id || ''}`;
    return el && !el.closest(protectedSelector) && !hiddenOutsideUI(el) && !/(?:user|account|device|machine|host)[-_]?(?:name|id)(?:\b|_)/i.test(identity) && (selected || !/(?:user|account|device|machine|hostname|identifier|address|token|secret)(?:[-_ ]?name|[-_ ]?id)?/i.test(identity));
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
    rememberTransient();
    if (state?.site?.excludedPaths.some(p => location.pathname.startsWith(p))) return { origin: location.origin, path:location.pathname, items: [], truncated: false };
    const items = new Map(); let size = 0, truncated = false, reused=0;
    const limits=C.captureLimits(state?.captureLimits),site=state?.site,reuse=C.reuseIndex(site?.entries || {});
    const known=item=>{const target={...item,targetLanguage:site?.targetLanguage || 'zh-Hans'};const cached=site?.entries[C.entryKey(target)] || C.reusableEntry(site?.entries || {},target,reuse);if(cached){reused++;return true;}return false;};
    // Short-lived controls get budget before the surrounding long page.
    for(const {node,item} of transientItems.values()) {
      if(!allowed(node))continue;
      const key=C.canonical(item);if(known(item) || items.has(key))continue;
      if(items.size>=limits.pageCaptureItems || size+item.sourceText.length>limits.pageCaptureChars){truncated=true;break;}
      size+=item.sourceText.length;items.set(key,{id:`t${items.size}`,...item});
    }
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
    truncated ||= transientTruncated;
    return { origin: location.origin, path:location.pathname, items: [...items.values()], truncated, reused };
  }
  let exploration=null, explored=new WeakMap(), exploredMenus=new Map(), explorationScope='';
  function collectExpanded() {
    if(exploration)return exploration;
    exploration=explore().finally(()=>{exploration=null;});return exploration;
  }
  async function explore() {
    const path=location.pathname,focused=document.activeElement,started=Date.now(),visited=new Set();
    const durationMs=C.autoExpandSeconds(state?.autoExpandSeconds)*1000;
    const scope=JSON.stringify([path,state?.site?.targetLanguage || 'zh-Hans',state?.site?.generation]);
    if(scope!==explorationScope){explored=new WeakMap();exploredMenus.clear();explorationScope=scope;}
    const entries=state?.site?.entries || {},reuse=C.reuseIndex(entries),revision=JSON.stringify([Object.keys(entries).length,C.captureLimits(state?.captureLimits)]);
    const available=item=>{const target={...item,targetLanguage:state?.site?.targetLanguage || 'zh-Hans'};return transientItems.has(C.canonical(item)) || entries[C.entryKey(target)] || C.reusableEntry(entries,target,reuse);};
    const choice=el=>el.matches('[role="combobox"],[aria-haspopup="listbox"]');
    const label=el=>JSON.stringify([textState.sourceAttribute(el,'aria-label'),(el.getAttribute('aria-labelledby') || '').split(/\s+/).map(id=>document.getElementById(id)).filter(node=>node && !el.contains(node)).map(node=>textState.content(node)),el.getAttribute('name'),el.getAttribute('data-testid')]);
    const stableId=el=>el.id && !/^(?:base-ui-|radix-|headlessui-|react-aria-|:|_r_)/.test(el.id)?el.id:null;
    // A selected caption and a generated popup ID are state, not the identity of a choice control.
    const fingerprint=el=>JSON.stringify([choice(el)?null:textState.content(el),label(el),el.getAttribute('aria-haspopup'),el.getAttribute('role')]);
    const moreButton=el=>el.matches('button[type="button"]') && !el.hasAttribute('aria-haspopup') && !el.hasAttribute('formaction') && !el.closest('form,[role="dialog"],[role="menu"],[role="listbox"]') && /^(?:show more|load more|显示更多|加载更多)$/i.test(textState.content(el).replace(/\s+/g,' ').trim());
    function moreRegion(el){let root=el.parentElement;while(root?.parentElement && root!==document.body && root.children.length<2)root=root.parentElement;return root || document.body;}
    const moreSize=root=>root?.querySelectorAll('*').length ?? 0;
    function menuKey(el) {
      if((!el.matches(menuSelector) && !moreButton(el)) || el.closest(protectedSelector))return null;
      if(!moreButton(el) && !stableId(el) && !textState.sourceAttribute(el,'aria-label') && !el.hasAttribute('aria-labelledby') && !el.hasAttribute('name') && !el.hasAttribute('data-testid'))return null;
      const address=[];
      for(let node=el;node && node!==document.documentElement;node=node.parentElement){
        const id=stableId(node);if(id){address.push(['id',id]);break;}
        let index=0;for(let prev=node.previousElementSibling;prev;prev=prev.previousElementSibling)if(prev.tagName===node.tagName)index++;
        address.push([node.tagName,index]);
      }
      return JSON.stringify([address,fingerprint(el)]);
    }
    function progress(el) {
      const signature=fingerprint(el),key=menuKey(el);let record=explored.get(el) || (key && exploredMenus.get(key));
      if(!record || record.signature!==signature)record={signature,attempts:0,items:[],complete:false,revision};
      explored.set(el,record);if(key)exploredMenus.set(key,record);
      if(moreButton(el) && record.moreSize!==undefined && record.moreSize!==moreSize(moreRegion(el))){record.attempts=0;record.complete=false;}
      if(record.revision!==revision){if(record.items.length && !record.complete)record.attempts=0;record.revision=revision;}
      if(record.complete && !record.items.every(available)){record.complete=false;record.attempts=0;}
      return record;
    }
    const hoverCardSelector='[data-base-ui-click-trigger][aria-haspopup="dialog"]';
    const tooltipSelector=`[data-base-ui-tooltip-trigger],[data-slot="tooltip-trigger"],[data-tooltip],[data-tooltip-content],${hoverCardSelector}`;
    const menuSelector='[aria-haspopup="menu"],[aria-haspopup="listbox"],[aria-haspopup="true"],[role="combobox"][aria-controls]';
    const selector=`${menuSelector},[aria-describedby],[data-state="closed"],${tooltipSelector}`;
    // Keep remount reuse local to controls still represented on this page.
    const currentMenus=new Set(Array.from(document.querySelectorAll(menuSelector+',button[type="button"]'),menuKey).filter(Boolean));
    for(const key of exploredMenus.keys())if(!currentMenus.has(key))exploredMenus.delete(key);
    // Continue unseen controls first. Dropdowns must not starve behind chart tooltips.
    const priority=el=>progress(el).attempts*10+(moreButton(el)?-1:el.matches(menuSelector)?0:el.matches(tooltipSelector)&&!el.textContent.trim()?1:2);
    const active=()=>location.pathname===path && state?.globalEnabled!==false && state?.site?.enabled!==false && !state?.site?.deleted && !state?.site?.excludedPaths.some(p=>location.pathname.startsWith(p));
    const eligible=el=>el.isConnected && !el.closest(protectedSelector) && !hiddenOutsideUI(el) && !el.closest('a,[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="option"]') && !el.matches(':disabled,[aria-disabled="true"],[aria-expanded="true"]') && el.getClientRects().length>0 && getComputedStyle(el).visibility!=='hidden';
    const eventOptions=(el,type)=>{const rect=el.getBoundingClientRect();return {bubbles:!type.endsWith('enter') && !type.endsWith('leave'),cancelable:true,clientX:rect.x+rect.width/2,clientY:rect.y+rect.height/2,button:0,buttons:type.endsWith('down')?1:0};};
    const pointer=(el,type)=>el.dispatchEvent(new PointerEvent(type,{...eventOptions(el,type),pointerType:'mouse',pointerId:1,isPrimary:true}));
    const mouse=(el,type)=>el.dispatchEvent(new MouseEvent(type,eventOptions(el,type)));
    const popupSnapshot=()=>new Map(Array.from(document.querySelectorAll(transientSelector)).filter(el=>el.getClientRects().length && !el.closest('[hidden],[aria-hidden="true"]') && getComputedStyle(el).visibility!=='hidden').map(el=>[el,textState.content(el)]));
    function popupItems(before) {
      const items=new Map();
      for(const [root,source] of popupSnapshot()) {
        if(before.get(root)===source)continue;
        const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
        while(walker.nextNode()) {
          const node=walker.currentNode;if(!allowed(node) || protectedText(original(node)) || textState.owner(node)==='builtin')continue;
          const item={sourceText:template(node).sourceText,context:context(node),path};
          items.set(C.canonical(item),item);
        }
      }
      return [...items.values()];
    }
    async function toggleMenu(el) {
      const before=el.getAttribute('aria-expanded');
      pointer(el,'pointerdown');mouse(el,'mousedown');pointer(el,'pointerup');mouse(el,'mouseup');
      // React/Radix selects commonly open on pointerdown, others on click.
      // Let the first handler commit before deciding whether click is needed.
      await new Promise(resolve=>setTimeout(resolve,0));
      if(active() && el.isConnected && el.getAttribute('aria-expanded')===before)el.click();
    }
    async function closeMenu(el,allowToggle=true) {
      const target=document.activeElement || el;
      target.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true,cancelable:true}));
      target.dispatchEvent(new KeyboardEvent('keyup',{key:'Escape',code:'Escape',bubbles:true}));
      await new Promise(resolve=>setTimeout(resolve,0));
      if(allowToggle && active() && el.isConnected && el.getAttribute('aria-expanded')==='true')await toggleMenu(el);
    }
    async function expandMore(el,record){
      const root=moreRegion(el),before=moreSize(root),deadline=Math.min(started+durationMs,Date.now()+2000);
      record.moreSize=before;el.click();
      let current=root;
      do {
        await new Promise(resolve=>setTimeout(resolve,Math.min(100,Math.max(0,deadline-Date.now()))));
        if(!active())return;
        current=el.isConnected?moreRegion(el):root.isConnected?root:root.id?document.getElementById(root.id):null;
        if(!el.isConnected || !moreButton(el) || moreSize(current)>before)break;
      }while(Date.now()<deadline);
      record.moreSize=moreSize(current);
      record.complete=el.isConnected && !moreButton(el);
      // Keep newly revealed rows on the page. A continuing loader may advance again,
      // but only after real DOM growth and within this round's time budget.
      if(!record.complete && record.moreSize>before){record.attempts=0;record.moreContinue=true;}
    }
    let limited=false;
    try {
      while(active()) {
        const el=Array.from(document.querySelectorAll(selector+',button[type="button"]')).filter(el=>(el.matches(selector) || moreButton(el)) && eligible(el) && (!visited.has(el) || (moreButton(el) && progress(el).moreContinue)) && !progress(el).complete && progress(el).attempts<2).sort((a,b)=>priority(a)-priority(b))[0];
        if(!el)break;
        if(Date.now()-started>=durationMs){limited=true;break;}
        visited.add(el);const record=progress(el),before=popupSnapshot();record.attempts++;record.moreContinue=false;let clicked=false;
        try {
          if(moreButton(el)){await expandMore(el,record);continue;}
          pointer(el,'pointerover');pointer(el,'pointerenter');pointer(el,'pointermove');mouse(el,'mouseover');mouse(el,'mouseenter');mouse(el,'mousemove');
          // Only explicit menu/listbox buttons may be clicked; never activate an option,
          // link, submit button or a generic action button inferred from its text.
          if(active() && eligible(el) && el.getAttribute('aria-expanded')==='false' && el.matches(menuSelector) && (el.matches('button')?el.type==='button':el.matches('[role="combobox"],[role="button"]'))) {
            clicked=true;await toggleMenu(el);
          } else if(active() && el.matches('button[type="button"],[tabindex="0"]'))el.focus({preventScroll:true});
          await new Promise(resolve=>setTimeout(resolve,800));
          if(active()){
            rememberTransient();record.items=popupItems(before);
            record.complete=record.items.length>0 && record.items.every(available);
          }
        } finally {
          pointer(el,'pointerout');pointer(el,'pointerleave');mouse(el,'mouseout');mouse(el,'mouseleave');
          if(clicked && active() && el.isConnected && el.getAttribute('aria-expanded')==='true')await closeMenu(el);
          else if(active() && el.isConnected && el.matches(hoverCardSelector) && el.getAttribute('aria-expanded')==='true')await closeMenu(el,false);
          if(document.activeElement===el)el.blur();
          // Some libraries assign aria-controls only on their first opening.
          if(record.complete && el.isConnected)record.signature=fingerprint(el);
        }
      }
    } finally {
      if(active() && focused?.isConnected && (document.activeElement===document.body || visited.has(document.activeElement)))focused.focus({preventScroll:true});
    }
    if(location.pathname!==path)throw new Error('展开扫描期间页面已跳转，请在当前页面重试');
    return {...collect(),exploration:{attempted:visited.size,limited}};
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
    } finally { applying = false; observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['contenteditable','translate','class','hidden','aria-hidden','role','popover',...attributeNames] }); }
  }
  const observer = new MutationObserver(() => {
    rememberTransient();
    clearTimeout(timer); timer = setTimeout(apply, 80);
    scheduleCapture();
  });
  observer.observe(document, { subtree: true, childList: true, characterData: true });
  function update(next) {
    if(next.captureId!==state?.captureId){lastCapture='';captureRetries=0;resetTransient();}
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
    if (m.type === 'wt:collect') {
      if(m.site)state={...state,site:m.site,captureLimits:m.captureLimits || state?.captureLimits};
      if(m.autoExpandSeconds!==undefined)state={...state,autoExpandSeconds:C.autoExpandSeconds(m.autoExpandSeconds)};
      if(m.expand){collectExpanded().then(reply).catch(error=>reply({error:error.message}));return true;}
      reply(collect());return false;
    }
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
