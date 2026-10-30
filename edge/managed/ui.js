/* GPL-3.0-or-later */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const collectionDefaults={pageCaptureItems:500,pageCaptureChars:80000,sessionCaptureItems:3000,sessionCaptureChars:400000,inputContextK:200};
  let current;
  const aiFields=['endpoint','apiKey','model','region','reasoningEffort'];
  const drafts={};let selectedProvider='api';
  const aiValues=()=>({provider:$('provider').value,...Object.fromEntries(aiFields.map(k=>[k,$(k).value.trim()]))});
  function providerUI(){
    const id=$('provider').value,p=WTProviders.catalog[id],subscription=id==='chatgpt',machine=p.kind==='mt';
    for(const [field,show] of Object.entries({endpointField:!subscription,keyField:!subscription,regionField:id==='azure',modelField:!machine || p.model,reasoningField:subscription})){
      $(field).hidden=!show;for(const control of $(field).querySelectorAll('input,select,textarea'))control.disabled=!show;
    }
    $('helper').hidden=!subscription;
    $('modelLabel').htmlFor=subscription?'modelSelect':'model';$('modelLabel').textContent=subscription?'ChatGPT 模型':'模型 ID';
    $('model').hidden=subscription;$('model').disabled=subscription || (machine && !p.model);$('modelSelect').hidden=!subscription;$('modelSelect').disabled=!subscription;$('modelSelect').required=subscription;
    $('endpoint').required=!subscription;$('apiKey').required=!subscription;$('model').required=!machine || !!p.model;
    $('endpointLabel').textContent=p.kind==='chat' || id==='qwen_mt'?'Chat Completions API 地址':'翻译 API 地址';
    for(const id of ['login','models','nativeStatus','logout'])$(id).hidden=!subscription;
    $('promptHint').textContent=machine?'提示词统一保存且始终可编辑；当前机器翻译接口不使用这段提示词。切换到对话模型或 ChatGPT 订阅后使用。':'所有对话模型与 ChatGPT 订阅共用此提示词。输出格式与隐私保护规则始终保留。';
    $('providerHint').textContent=subscription?'通过本地连接程序使用 ChatGPT 订阅。思考强度支持范围由所选模型决定，模型默认不额外指定强度。':machine?'机器翻译仅发送明确的界面控件和输入框提示，不发送无法判断的正文；此接口不接受通用 AI 提示词。':'API Key 仅保存在本机。支持服务商地址或兼容网关，模型 ID 以服务商提供的为准。';
  }
  function loadProvider(id,profile={}){
    selectedProvider=id;$('provider').value=id;
    for(const key of aiFields)$(key).value=profile[key] || (key==='endpoint'?WTProviders.catalog[id].endpoint:key==='prompt'?current?.defaultPrompt || '':key==='reasoningEffort'?'auto':'');
    renderModels(current?.wt_subscription_models || [],profile.model || '');providerUI();
  }
  function renderModels(models,selected=$('model').value){
    const list=$('modelSelect');list.replaceChildren();const empty=document.createElement('option');empty.value='';empty.textContent=models.length?'请选择模型':'请先读取订阅模型';list.append(empty);
    const seen=new Set();for(const model of models){if(!model.slug || seen.has(model.slug))continue;seen.add(model.slug);const option=document.createElement('option');option.value=model.slug;option.textContent=model.display_name && model.display_name!==model.slug?model.display_name+' · '+model.slug:model.slug;list.append(option);}
    if(selected && !seen.has(selected)){const option=document.createElement('option');option.value=selected;option.textContent=selected+'（已保存）';list.append(option);}
    list.value=selected;list.onchange=()=>{$('model').value=list.value;};
  }
  async function saveAI(){
    const ai=aiValues();
    if(ai.provider!=='chatgpt'){ai.endpoint=WTProviders.normalizeEndpoint(ai.provider,ai.endpoint);const u=new URL(ai.endpoint);if(!await chrome.permissions.request({origins:[u.protocol+'//'+u.hostname+'/*']}))throw new Error('API 主机权限未授予');}
    await request('config',{ai});drafts[ai.provider]=ai;
  }
  const expandedGroups=new Set(),expandedSites=new Set();
  const request = async (type, data = {}) => { const r = await chrome.runtime.sendMessage({ type: `wt:${type}`, ...data }); if (!r?.ok) throw new Error(r?.error || '后台没有响应'); return r.result; };
  const statusNames = { running:'进行中', completed:'完成', interrupted:'中断', partial:'部分完成', failed:'失败' };
  const syncText = (s,config) => !config?.enabled ? '浏览器本机副本已保留 · OneDrive 自动保存未启用' : !config.confirmedAt ? '浏览器本机已保存 · 请重新确认 OneDrive 目录后启用自动保存' :
    '浏览器本机已保存 · '+(s?.directorySaved?'已写入 OneDrive 文件夹':'OneDrive 文件夹尚未保存，等待写入')+(s?.error?' · 将自动重试：'+s.error:'')+(s?.invalid?' · 存在未应用的非法文件':'')+(s?.pending?' · 等待同步依赖补齐':'')+' · '+(s?.peerConfirmed?'收到另一台设备的合并确认':'云端上传及另一台设备接收尚未确认')+' · '+config.directory;
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
  function taskText(t) { return `${statusNames[t.status] || t.status} · ${t.siteId} · ${t.targetLanguage} · ${t.completed}/${t.total} 项，翻译 ${t.translated} 项 · 本地复用 ${t.reused || 0} 项 / 跨页去重 ${t.deduplicated || 0} 项${t.batchTotal!==undefined?' · 动态批次 '+t.batchCompleted+'/'+t.batchTotal+' · 重试 '+(t.retries || 0)+' 次':''}${t.contextBudget?' · 输入上限 '+(t.contextBudget/1000)+'K':''}${t.requestTimeoutMinutes?' · 单次超时 '+t.requestTimeoutMinutes+' 分钟':''}${t.truncated ? ' · 采集已达到上限' : ''} ${t.message || ''}`; }
  function renderTasks(tasks){
    $('taskList').replaceChildren();for(const t of Object.values(tasks || {}).sort((a,b)=>b.updatedAt-a.updatedAt)){const row=document.createElement('article'),p=document.createElement('p');p.textContent=taskText(t);row.append(p);if(t.canRetry)row.append(button('重试剩余内容',()=>request('retry-task',{taskId:t.id})));$('taskList').append(row);}
  }
  function renderQueue(state){
    const list=$('manualQueue');if(!list)return;list.replaceChildren();
    const rows=state.wt_manual_queue || [];
    if(!rows.length){list.textContent='暂无手动待翻译内容';return;}
    for(const row of rows){
      const box=document.createElement('article'),info=document.createElement('p'),text=document.createElement('p');
      info.className='detail';info.textContent=`${row.siteId}${row.path} · ${row.targetLanguage}`;
      text.textContent=row.sourceText;
      const remove=button('移除',()=>request('manual-remove',{id:row.id}));remove.disabled=Object.values(state.wt_tasks || {}).some(task=>task.siteId===row.siteId && task.status==='running');
      box.append(info,text,remove);list.append(box);
    }
  }
  async function refresh(forms = false) {
    const state = await request('state'); current = state;
    if ($('siteList')) {
      renderSites(state.sites);renderTasks(state.wt_tasks);renderQueue(state);
      const sync = state.wt_sync_status;
      $('syncStatus').textContent = syncText(sync,state.wt_sync);
      if (forms) { const a=state.wt_ai || {};loadProvider(WTProviders.catalog[a.provider]?a.provider:'api',a);$('prompt').value=state.wt_prompt || a.prompt || state.defaultPrompt || ''; $('directory').value=state.wt_sync?.directory || ''; $('syncEnabled').checked=!!state.wt_sync?.enabled;const language=state.wt_preferences?.targetLanguage || 'zh-Hans';if(![...$('targetLanguage').options].some(o=>o.value===language)){const o=document.createElement('option');o.value=language;o.textContent=language;$('targetLanguage').append(o);}$('targetLanguage').value=language;$('requestTimeoutMinutes').value=state.wt_preferences?.requestTimeoutMinutes ?? 3;for(const [key,value] of Object.entries(collectionDefaults))$(key).value=state.wt_preferences?.[key] ?? value;$('globalEnabled').checked=state.globalEnabled!==false;$('syncEnabled').onchange(); }
    } else if ($('wtProgress')) {
      const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
      const origin = /^https?:/.test(tab?.url || '') ? new URL(tab.url).origin : null;
      $('wtSite').textContent=origin || '请打开普通网页';
      let pending=$('wtPending');if(!pending){pending=document.createElement('p');pending.id='wtPending';pending.className='usage-note';$('wtProgress').after(pending);}
      const count=(state.wt_manual_queue || []).filter(row=>row.siteId===origin && row.targetLanguage===(state.wt_preferences?.targetLanguage || 'zh-Hans')).length;
      pending.textContent='当前语言手动待翻译：'+count+' 项';
      if(state.wt_selection_status?.siteId===origin && Date.now()-state.wt_selection_status.at<60000)pending.textContent+=' · '+state.wt_selection_status.message;
      const task=Object.values(state.wt_tasks || {}).filter(t=>t.siteId===origin).sort((a,b)=>b.updatedAt-a.updatedAt)[0];
      const c=state.wt_capture,collecting=c?.status==='collecting';
      $('wtProgress').textContent=collecting ? '正在采集 '+c.group+' · '+c.pages.length+' 页 / '+c.items.length+' 项'+(c.lastError?' · 采集未成功：'+c.lastError:'')+(c.truncated?' · 已达到上限，请完成翻译':'') : task ? taskText(task) : '添加当前页面，或先采集多个页面再翻译。';
      $('wtSaveStatus').textContent=syncText(state.wt_sync_status,state.wt_sync);
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
    $('generalForm').onsubmit=e=>{e.preventDefault();action(async()=>{await request('config',{preferences:{...Object.fromEntries(Object.keys(collectionDefaults).map(key=>[key,Number($(key).value)])),targetLanguage:$('targetLanguage').value.trim(),requestTimeoutMinutes:Number($('requestTimeoutMinutes').value)}});await chrome.storage.sync.set({enable_extension:$('globalEnabled').checked});});};
    $('promptForm').onsubmit=e=>{e.preventDefault();action(()=>request('config',{prompt:$('prompt').value}),e.submitter);};
    $('resetPrompt').onclick=()=>{$('prompt').value=current.defaultPrompt;};
    for(const box of document.querySelectorAll('.native-setup')){
      const select=box.querySelector('[data-native-browser]'),command=box.querySelector('[data-install-command]'),result=box.querySelector('[data-native-result]');
      select.value=/Firefox\//.test(navigator.userAgent)?'firefox':/Edg\//.test(navigator.userAgent)?'edge':'chrome';
      box.querySelector('[data-native-id]').textContent=chrome.runtime.id;
      const update=()=>{command.textContent='powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\\local-helper\\native\\install.ps1 -Browser '+select.value+(select.value==='firefox'?'':' -ExtensionId '+chrome.runtime.id);};
      select.onchange=update;update();
      box.querySelector('[data-copy-install]').onclick=()=>action(async()=>{await navigator.clipboard.writeText(command.textContent);return '已复制安装命令，请在项目源码目录执行';});
      const check=box.querySelector('[data-check-native]');check.onclick=()=>action(async()=>{
        result.textContent='正在检查本地连接…';
        try{const r=await request('native',{action:'ping'});if(r.connected!==true)throw new Error('本地程序响应无效，请更新程序');result.textContent='本地连接正常 · 程序版本 '+r.version+' · 无需 ChatGPT 登录即可使用文件保存';}
        catch(e){result.textContent=e.message;throw e;}
      },check);
    }
    $('aiForm').onsubmit=e=>{e.preventDefault();action(saveAI,e.submitter);};
    $('testConnection').onclick=()=>{if(!$('aiForm').reportValidity())return;action(async()=>{await saveAI();await request('test');return '连接测试通过，测试译文已校验';},$('testConnection'));};
    $('syncEnabled').onchange=()=>{$('saveSync').textContent=$('syncEnabled').checked?'确认目录并启用自动保存':'保存（暂停自动写入）';};
    $('syncForm').onsubmit=e=>{e.preventDefault();action(async()=>{await request('config',{sync:{enabled:$('syncEnabled').checked,directory:$('directory').value.trim()}});const state=await request('state');$('directory').value=state.wt_sync.directory;return state.wt_sync.enabled?'目录已确认，自动保存已启用':'自动写入已暂停，本机词库保留';},e.submitter);};
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
    $('models').onclick=()=>action(async()=>{const models=await request('native',{action:'models'});renderModels(models);return `已读取 ${models.length} 个模型，请从完整列表选择并保存`;},$('models'));
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
    if(changes.wt_tasks || changes.wt_task_inputs || changes.wt_manual_queue || changes.wt_view)request('state').then(state=>{current=state;renderTasks(state.wt_tasks);renderQueue(state);}).catch(()=>{});
    if(changes.wt_sync_status || changes.wt_sync) request('state').then(state=>{
      $('syncStatus').textContent=syncText(state.wt_sync_status,state.wt_sync);
    }).catch(()=>{});
  });
})();
