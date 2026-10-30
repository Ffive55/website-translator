/* GPL-3.0-or-later */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let current;
  const aiFields=['endpoint','apiKey','model','region','prompt','reasoningEffort'];
  const drafts={};let selectedProvider='api';
  const aiValues=()=>({provider:$('provider').value,...Object.fromEntries(aiFields.map(k=>[k,$(k).value.trim()]))});
  function providerUI(){
    const id=$('provider').value,p=WTProviders.catalog[id],subscription=id==='chatgpt',machine=p.kind==='mt';
    for(const [field,show] of Object.entries({endpointField:!subscription,keyField:!subscription,regionField:id==='azure',modelField:!machine || p.model,reasoningField:subscription,promptField:!machine})){
      $(field).hidden=!show;for(const control of $(field).querySelectorAll('input,select,textarea'))control.disabled=!show;
    }
    $('helper').hidden=!subscription;
    $('endpoint').required=!subscription;$('apiKey').required=!subscription;$('model').required=!machine || !!p.model;
    $('endpointLabel').textContent=p.kind==='chat' || id==='qwen_mt'?'Chat Completions API 地址':'翻译 API 地址';
    for(const id of ['login','models','nativeStatus','logout'])$(id).hidden=!subscription;
    $('resetPrompt').hidden=machine;$('promptHint').hidden=machine;
    $('providerHint').textContent=subscription?'通过本地连接程序使用 ChatGPT 订阅。思考强度支持范围由所选模型决定，模型默认不额外指定强度。':machine?'机器翻译仅发送明确的界面控件和输入框提示，不发送无法判断的正文；此接口不接受通用 AI 提示词。':'API Key 仅保存在本机。支持服务商地址或兼容网关，模型 ID 以服务商提供的为准。';
  }
  function loadProvider(id,profile={}){
    selectedProvider=id;$('provider').value=id;
    for(const key of aiFields)$(key).value=profile[key] || (key==='endpoint'?WTProviders.catalog[id].endpoint:key==='prompt'?current?.defaultPrompt || '':key==='reasoningEffort'?'auto':'');
    $('modelList').replaceChildren();providerUI();
  }
  async function saveAI(){
    const ai=aiValues();
    if(ai.provider!=='chatgpt'){ai.endpoint=WTProviders.normalizeEndpoint(ai.provider,ai.endpoint);const u=new URL(ai.endpoint);if(!await chrome.permissions.request({origins:[u.protocol+'//'+u.hostname+'/*']}))throw new Error('API 主机权限未授予');}
    await request('config',{ai});drafts[ai.provider]=ai;
  }
  const expandedGroups=new Set(),expandedSites=new Set();
  const request = async (type, data = {}) => { const r = await chrome.runtime.sendMessage({ type: `wt:${type}`, ...data }); if (!r?.ok) throw new Error(r?.error || '后台没有响应'); return r.result; };
  const statusNames = { running:'进行中', completed:'完成', interrupted:'中断', partial:'部分完成', failed:'失败' };
  const syncText = s => !s ? '尚未检查同步' : s.error ? `本机已保存；同步未完成：${s.error}` :
    `本机已保存 · ${s.pendingLocal ? '存在待交换修改' : s.invalid ? '存在未应用文件' : s.pending ? '等待依赖补齐' : '本轮文件交换完成'} · 已导出 ${s.exported || 0} 条 · 等待依赖 ${s.pending || 0} 条 · 非法文件 ${s.invalid || 0} 个 · ${s.peerConfirmed ? '收到对端合并确认' : '尚无对端确认'} · ${s.directory || ''}`;
  const button = (label, fn) => { const b = document.createElement('button'); b.textContent = label; b.onclick = () => action(fn, b); return b; };
  async function action(fn, b) { if (b) b.disabled = true; try { const msg = await fn(); if ($('message')) $('message').textContent = typeof msg === 'string' ? msg : '已保存'; await refresh(false); } catch(e) { ($('message') || $('wtProgress')).textContent = e.message; } finally { if(b) b.disabled = false; } }
  async function change(site, kind, payload) { await request('change', { siteId: site.id, kind, payload }); }
  function renderSites(sites) {
    $('siteList').replaceChildren();
    const groups = new Map();
    for (const s of Object.values(sites).filter(s => !s.deleted).sort((a,b) => a.group.localeCompare(b.group))) { if (!groups.has(s.group)) groups.set(s.group, []); groups.get(s.group).push(s); }
    for (const [name, values] of groups) {
      const group=document.createElement('details');group.className='domain-group';group.open=expandedGroups.has(name);
      group.ontoggle=()=>group.open?expandedGroups.add(name):expandedGroups.delete(name);
      const heading=document.createElement('summary'),label=document.createElement('strong');label.textContent=name;
      const count=document.createElement('span');count.className='detail';count.textContent=values.length+' 个网址';
      const controls=document.createElement('span');controls.className='group-actions';
      const enabled=values.every(s=>s.enabled);
      for(const b of [button(enabled?'停用':'启用',()=>request('group-change',{group:name,action:'enabled',enabled:!enabled})),button('删除',()=>request('group-change',{group:name,action:'delete'}))]){b.addEventListener('click',e=>e.stopPropagation());controls.append(b);}
      heading.append(label,count,controls);group.append(heading);$('siteList').append(group);
      const grid=document.createElement('div');grid.className='site-grid';group.append(grid);
      for (const s of values) {
        const row = document.createElement('article'); row.className = 'site';
        const title = document.createElement('strong'); title.textContent = `${s.name} · ${s.origin}`;
        const info = document.createElement('p'); info.className = 'detail';
        const language=current?.wt_preferences?.targetLanguage || 'zh-Hans';
        const entries = Object.values(s.entries).filter(e => e.targetLanguage === language);
        info.textContent = `${s.authorized ? '已授权' : '待本机授权'} · ${language} · 增量 ${entries.filter(e => e.action === 'translate').length} 条 / 跳过 ${entries.filter(e => e.action === 'skip').length} 条 · 冲突 ${Object.keys(s.conflicts).length} 组${s.builtinId ? ' · 含随扩展分发的中文基础词库' : ''}`;
        const link=document.createElement('a');link.href=s.origin;link.target='_blank';link.rel='noopener';link.textContent=s.origin;row.append(link,info);
        if (!s.authorized) row.append(button('授予此主机权限', async () => { const u = new URL(s.origin); if (!await chrome.permissions.request({ origins:[`${u.protocol}//${u.hostname}/*`] })) throw new Error('未授予权限'); }));
        const details = document.createElement('details'), summary = document.createElement('summary'); summary.textContent = '词库与排除路径'; details.append(summary);details.open=expandedSites.has(s.id);details.ontoggle=()=>details.open?expandedSites.add(s.id):expandedSites.delete(s.id);
        const excludes = document.createElement('textarea'); excludes.value = s.excludedPaths.join('\n'); excludes.setAttribute('aria-label','排除路径，每行一个路径前缀');
        details.append(excludes, button('保存排除路径', () => change(s,'setting',{key:'excludedPaths',value:excludes.value.split('\n').map(v=>v.trim()).filter(Boolean)})));
        for (const e of entries.slice(0,100)) {
          const item = document.createElement('details'), label = document.createElement('summary'); label.textContent = `${e.sourceText.slice(0,90)} · ${e.path} · ${e.context}`;
          const edit = document.createElement('textarea'); edit.value = e.translation || ''; edit.setAttribute('aria-label','人工译文');
          item.append(label, edit, button('保存人工译文', () => change(s,'entry',{...e, origin:'manual',category:'ui',action:'translate',translation:edit.value})));
          const conflict = Object.values(s.conflicts).find(rows => rows[0]?.sourceText === e.sourceText && rows[0]?.context === e.context && rows[0]?.path === e.path && rows[0]?.targetLanguage === e.targetLanguage);
          if (conflict) { const p = document.createElement('p'); p.textContent = `并发候选：${conflict.map(c=>c.translation || '跳过').join(' / ')}。保存人工译文可解决当前已收到的候选。`; item.append(p); }
          details.append(item);
        }
        if (entries.length > 100) { const p = document.createElement('p'); p.textContent = `仅展示前 100 条；共有 ${entries.length} 条，其他词条仍保留。`; details.append(p); }
        row.append(details); grid.append(row);
      }
    }
    if(!groups.size)$('siteList').textContent='尚未添加网站，在网页打开插件开始添加或采集。';
  }
  function taskText(t) { return `${statusNames[t.status] || t.status} · ${t.siteId} · ${t.targetLanguage} · ${t.completed}/${t.total} 项，翻译 ${t.translated} 项 · 本地复用 ${t.reused || 0} 项 / 跨页去重 ${t.deduplicated || 0} 项${t.truncated ? ' · 采集已达到单页上限' : ''} ${t.message || ''}`; }
  async function refresh(forms = false) {
    const state = await request('state'); current = state;
    if ($('siteList')) {
      renderSites(state.sites); $('taskList').replaceChildren();
      for (const t of Object.values(state.wt_tasks || {}).sort((a,b)=>b.updatedAt-a.updatedAt)) { const p=document.createElement('p'); p.textContent=taskText(t); $('taskList').append(p); }
      const sync = state.wt_sync_status;
      $('syncStatus').textContent = syncText(sync);
      if (forms) { const a=state.wt_ai || {};loadProvider(WTProviders.catalog[a.provider]?a.provider:'api',a); $('directory').value=state.wt_sync?.directory || ''; $('syncEnabled').checked=!!state.wt_sync?.enabled;$('targetLanguage').value=state.wt_preferences?.targetLanguage || 'zh-Hans';$('globalEnabled').checked=state.globalEnabled!==false; }
    } else if ($('wtProgress')) {
      const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
      const origin = /^https?:/.test(tab?.url || '') ? new URL(tab.url).origin : null;
      $('wtSite').textContent=origin || '请打开普通网页';
      const task=Object.values(state.wt_tasks || {}).filter(t=>t.siteId===origin).sort((a,b)=>b.updatedAt-a.updatedAt)[0];
      const c=state.wt_capture,collecting=c?.status==='collecting';
      $('wtProgress').textContent=collecting ? '正在采集 '+c.group+' · '+c.pages.length+' 页 / '+c.items.length+' 项'+(c.truncated?' · 已达到上限，请完成翻译':'') : task ? taskText(task) : '添加当前页面，或先采集多个页面再翻译。';
      $('wtCapture').textContent=collecting?'完成并翻译':'开始采集';$('wtCancel').hidden=!collecting;$('wtStart').disabled=collecting;
      $('enable_extension').checked=state.globalEnabled!==false;$('status').textContent=state.globalEnabled!==false?'已开启':'已关闭';$('status').classList.toggle('is-on',state.globalEnabled!==false);
    }
  }
  if ($('siteList')) {
    for(const [id,p] of Object.entries(WTProviders.catalog)){const option=document.createElement('option');option.value=id;option.textContent=p.label;$('provider').append(option);}
    $('provider').onchange=()=>{drafts[selectedProvider]={...aiValues(),provider:selectedProvider};loadProvider($('provider').value,drafts[$('provider').value] || current.wt_ai_profiles?.[$('provider').value] || {});};
    $('version').textContent='v'+(chrome.runtime.getManifest?.().version || '');
    const tabs=[...document.querySelectorAll('[data-tab]')];
    function selectTab(id){if(!tabs.some(t=>t.dataset.tab===id))id='general';for(const tab of tabs){const active=tab.dataset.tab===id;tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;$(tab.dataset.tab).hidden=!active;}history.replaceState(null,'','#'+id);}
    for(const [i,tab] of tabs.entries()){tab.onclick=()=>selectTab(tab.dataset.tab);tab.onkeydown=e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();const next=e.key==='Home'?0:e.key==='End'?tabs.length-1:(i+(e.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;selectTab(tabs[next].dataset.tab);tabs[next].focus();};}
    selectTab(location.hash.slice(1));
    $('generalForm').onsubmit=e=>{e.preventDefault();action(async()=>{await request('config',{preferences:{targetLanguage:$('targetLanguage').value.trim()}});await chrome.storage.sync.set({enable_extension:$('globalEnabled').checked});});};
    $('resetPrompt').onclick=()=>{$('prompt').value=current.defaultPrompt;};
    $('installCommand').textContent=`npm ci\npwsh -File .\\native\\install.ps1 -Browser chrome -ExtensionId ${chrome.runtime.id}\n# Edge 使用 -Browser edge；Firefox 使用 -Browser firefox`;
    $('aiForm').onsubmit=e=>{e.preventDefault();action(saveAI,e.submitter);};
    $('testConnection').onclick=()=>{if(!$('aiForm').reportValidity())return;action(async()=>{await saveAI();await request('test');return '连接测试通过，测试译文已校验';},$('testConnection'));};
    $('syncForm').onsubmit=e=>{e.preventDefault();action(()=>request('config',{sync:{enabled:$('syncEnabled').checked,directory:$('directory').value.trim()}}));};
    $('syncNow').onclick=()=>action(()=>request('sync'));
    $('login').onclick=()=>action(async()=>{
      // A persistent port keeps the native process and callback listener alive during login.
      const port=chrome.runtime.connectNative('local.website_translator');
      await new Promise((resolve,reject)=>{
        let settled=false;
        const finish=(error)=>{if(settled)return;settled=true;clearTimeout(timeout);window.removeEventListener('pagehide',cancel);if(error){$('accountStatus').textContent=error.message;reject(error);}else resolve();port.disconnect();};
        const cancel=()=>finish(new Error('登录已取消'));
        const timeout=setTimeout(()=>finish(new Error('登录超时，请重试')),210000);
        window.addEventListener('pagehide',cancel,{once:true});
        port.onMessage.addListener(m=>{
          if(!m.ok){finish(new Error(m.error));return;}
          if(m.result?.authorizeUrl){
            let u;try{u=new URL(m.result.authorizeUrl);}catch{finish(new Error('登录地址无效'));return;}
            if(u.origin!=='https://auth.openai.com' || u.pathname!=='/api/accounts/authorize') {finish(new Error('登录地址无效'));return;}
            chrome.tabs.create({url:u.href}).catch(()=>finish(new Error('无法打开授权页，请重试')));
            $('accountStatus').textContent='等待在浏览器完成 ChatGPT 登录；关闭管理页将取消本次登录…';
          }else if(m.result?.signedIn===true){$('accountStatus').textContent='登录已完成；请读取模型并保存。';finish();}
          else finish(new Error('登录未返回已验证身份'));
        });
        port.onDisconnect.addListener(()=>{const error=chrome.runtime.lastError;finish(new Error(error?.message || '本地连接已断开，登录未完成'));});
        port.postMessage({action:'login'});
      });
    },$('login'));
    $('models').onclick=()=>action(async()=>{const models=await request('native',{action:'models'});$('modelList').replaceChildren(...models.map(m=>{const o=document.createElement('option');o.value=m.slug;o.label=m.display_name;return o;}));return `已读取 ${models.length} 个模型，请选择模型并保存`;});
    for (const [id, actionName] of [['logout','logout'],['nativeStatus','status']]) $(id).onclick=()=>action(async()=>{const r=await request('native',{action:actionName});$('accountStatus').textContent=r.signedIn?`ChatGPT 已登录：${r.email || '账号信息不可用'}（模型访问需实际请求验证）`:`本地程序已连接，ChatGPT 未登录${actionName==='logout' && !r.revoked?'；远端撤销未确认，可在 ChatGPT 设置中断开此应用':''}`;});
  } else {
    $('enable_extension').onchange=()=>action(()=>chrome.storage.sync.set({enable_extension:$('enable_extension').checked}));
    $('wtCancel').onclick=()=>action(()=>request('capture-cancel'),$('wtCancel'));
    $('wtCapture').onclick=()=>action(async()=>{
      if(current?.wt_capture?.status==='collecting')return request('capture-finish');
      const [tab]=await chrome.tabs.query({active:true,currentWindow:true}),u=new URL(tab.url);
      if(!['http:','https:'].includes(u.protocol))throw new Error('请打开普通网页');
      const domain=tldts.getDomain(u.hostname,{allowPrivateDomains:true});
      const origins=domain?['https://*.'+domain+'/*','http://*.'+domain+'/*']:[u.protocol+'//'+u.hostname+'/*'];
      if(!await chrome.permissions.request({origins}))throw new Error('未授予采集域名权限');
      await request('capture-start',{tabId:tab.id});
    },$('wtCapture'));
    $('wtManage').onclick=()=>chrome.tabs.create({url:chrome.runtime.getURL('managed/managed.html')});
    $('wtStart').onclick=()=>action(async()=>{
      const [tab]=await chrome.tabs.query({active:true,currentWindow:true}); const u=new URL(tab.url);
      if(!await chrome.permissions.request({origins:[`${u.protocol}//${u.hostname}/*`]})) throw new Error('未授予网站权限');
      await request('start',{tabId:tab.id});
    },$('wtStart'));
    setInterval(()=>refresh(false).catch(()=>{}),1500);
  }
  refresh(true).catch(e=>{($('message') || $('wtProgress')).textContent=e.message;});
  if ($('siteList')) chrome.storage.onChanged.addListener((changes,area)=>{
    if(area!=='local')return;
    if(changes.wt_tasks){const list=$('taskList');list.replaceChildren();for(const t of Object.values(changes.wt_tasks.newValue || {})){const p=document.createElement('p');p.textContent=taskText(t);list.append(p);}}
    if(changes.wt_sync_status) request('state').then(state=>{
      $('syncStatus').textContent=syncText(state.wt_sync_status);
    }).catch(()=>{});
  });
})();
