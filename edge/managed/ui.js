/* GPL-3.0-or-later */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const collectionDefaults={pageCaptureItems:500,pageCaptureChars:80000,sessionCaptureItems:3000,sessionCaptureChars:400000,inputContextK:200,autoExpandSeconds:12};
  let current,refreshFlight,refreshAgain=false,formsLoaded=false;const dirtyForms=new Set();
  document.addEventListener('input',event=>{const id=event.target.closest('form')?.id;if(id)dirtyForms.add(id);});
  document.addEventListener('change',event=>{const id=event.target.closest('form')?.id;if(id)dirtyForms.add(id);});
  const aiFields=['endpoint','apiKey','model','region','reasoningEffort'];
  const drafts={};let selectedProvider='api';
  let nativePlatform=null;
  async function ensureNativePermission(){
    if(nativePlatform && (nativePlatform.os!=='win'||nativePlatform.arch!=='x86-64'))throw new Error('ChatGPT 订阅本地程序目前仅支持 Windows x64；可选择 API 翻译服务');
    if(chrome.permissions?.request && !await chrome.permissions.request({permissions:['nativeMessaging']}))throw new Error('未授予本地通信权限；词库和 API 翻译仍可使用');
  }
  const nativeRequest=async action=>{await ensureNativePermission();return request('native',{action});};
  async function nativeDistribution(){
    if(chrome.runtime.getPlatformInfo)try{nativePlatform=await chrome.runtime.getPlatformInfo();}catch{}
    const supported=!nativePlatform || nativePlatform.os==='win'&&nativePlatform.arch==='x86-64';
    const platform=document.querySelector('[data-native-platform]');if(platform)platform.textContent=supported?'本地连接程序仅支持 Windows x64，供 ChatGPT 订阅使用。':'当前设备不支持 Windows x64 本地连接程序，请使用词库或 API 翻译。';
    if(!chrome.runtime.getURL || !globalThis.fetch)return;
    try{const config=await(await fetch(chrome.runtime.getURL('managed/distribution.json'))).json();const link=document.querySelector('[data-native-download]');
      if(link && config.helperDownloadUrl){const url=new URL(config.helperDownloadUrl);if(url.protocol==='https:'&&!url.username&&!url.password){link.href=url.href;link.hidden=false;document.querySelector('[data-native-unavailable]').hidden=true;}}
    }catch{}
  }
  const aiValues=()=>({provider:$('provider').value,...Object.fromEntries(aiFields.map(k=>[k,$(k).value.trim()]))});
  function providerUI(){
    const id=$('provider').value,p=WTProviders.catalog[id],subscription=id==='chatgpt',machine=p.kind==='mt';
    for(const [field,show] of Object.entries({endpointField:!subscription,keyField:!subscription,regionField:id==='azure',modelField:!machine || p.model,reasoningField:subscription})){
      $(field).hidden=!show;for(const control of $(field).querySelectorAll('input,select,textarea'))control.disabled=!show;
    }
    $('helper').hidden=!subscription;
    if($('clearApiKey'))$('clearApiKey').hidden=subscription;
    $('modelLabel').htmlFor=subscription?'modelSelect':'model';$('modelLabel').textContent=subscription?'ChatGPT 模型':'模型 ID';
    $('model').hidden=subscription;$('model').disabled=subscription || (machine && !p.model);$('modelSelect').hidden=!subscription;$('modelSelect').disabled=!subscription;$('modelSelect').required=subscription;
    $('endpoint').required=!subscription;$('apiKey').required=!subscription;$('model').required=!machine || !!p.model;
    $('endpointLabel').textContent=p.kind==='chat' || id==='qwen_mt'?'Chat Completions API 地址':'翻译 API 地址';
    for(const id of ['login','models','nativeStatus','logout'])$(id).hidden=!subscription;
    $('promptHint').textContent=machine?'提示词统一保存且始终可编辑；当前机器翻译接口不使用这段提示词。切换到对话模型或 ChatGPT 订阅后使用。':'所有对话模型与 ChatGPT 订阅共用此提示词。输出格式与隐私保护规则始终保留。';
    $('providerHint').textContent=subscription?'通过本地连接程序使用 ChatGPT 订阅。思考强度支持范围由所选模型决定，模型默认不额外指定强度。':machine?'机器翻译仅发送明确的界面控件和输入框提示，不发送无法判断的正文；此接口不接受通用 AI 提示词。':'API Key 随浏览器设置同步。支持服务商地址或兼容网关，模型 ID 以服务商提供的为准。';
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
  const request = async (type, data = {}) => { let timer;const r=await Promise.race([chrome.runtime.sendMessage({type:`wt:${type}`,...data}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('后台仍在启动或处理中，设置入口可继续使用；请稍后重试')),['state','popup-state'].includes(type)?8000:180000);})]).finally(()=>clearTimeout(timer)); if (!r?.ok) throw new Error(r?.error || '后台没有响应'); return r.result; };
  const statusNames = { running:'进行中', completed:'完成', interrupted:'中断', partial:'部分完成', failed:'失败' };
  const button = (label, fn) => { const b = document.createElement('button'); b.textContent = label; b.onclick = () => action(fn, b); return b; };
  let messageTimer,messageVersion=0;
  function clearMessage(){clearTimeout(messageTimer);messageVersion++;const el=$('message');if(el){el.hidden=true;el.textContent='';}}
  function showMessage(message,error=false){
    const el=$('message');if(!el){if($('wtProgress'))$('wtProgress').textContent=message;return;}
    clearMessage();const version=messageVersion;
    el.dataset.kind=error?'error':'success';el.setAttribute('role',error?'alert':'status');el.setAttribute('aria-live',error?'assertive':'polite');el.textContent=message;el.title=message;el.hidden=false;
    messageTimer=setTimeout(()=>{if(messageVersion===version)clearMessage();},error?8000:3000);
  }
  async function action(fn, b) { if (b) b.disabled = true;clearMessage();try { const msg = await fn();await refresh(false);if($('message'))showMessage(typeof msg === 'string' ? msg : msg?.message || '已保存',!!msg?.error); } catch(e) { await refresh(false).catch(()=>{});showMessage(e.message,true); } finally { if(b) b.disabled = false; } }
  let dictionaryUploading=false,catalogResult=null;const dictionaryDownloads=new Set();
  function uploadButtons(){for(const b of document.querySelectorAll('[data-dictionary-upload]'))b.disabled=dictionaryUploading;}
  let transferDialogBusy=false;
  function askTransfer(result){
    if(transferDialogBusy)return Promise.resolve(false);
    transferDialogBusy=true;
    if(!document.getElementById('dictionaryConfirmStyle')){const link=document.createElement('link');link.id='dictionaryConfirmStyle';link.rel='stylesheet';link.href=chrome.runtime.getURL?chrome.runtime.getURL('managed/dictionary-confirm.css'):'dictionary-confirm.css';document.head.append(link);}
    return new Promise(resolve=>{
      const upload=result.direction==='upload',dialog=document.createElement('dialog'),title=document.createElement('h2'),text=document.createElement('p'),reason=document.createElement('p'),buttons=document.createElement('div'),cancel=document.createElement('button'),accept=document.createElement('button');
      dialog.className='dictionary-confirm';title.id='dictionaryConfirmTitle';title.textContent=upload?'用本地词库覆盖仓库？':'用仓库词库覆盖本地？';dialog.setAttribute('aria-labelledby',title.id);
      reason.textContent=result.reason+'。范围：'+result.group+' · '+result.language+'。';
      text.textContent=result.full?(upload?'继续后，将以本地完整词库替换仓库中该分组、该语言的词库，仓库独有内容可能被移除。':'继续后，将以仓库完整词库替换本地该分组、该语言的词库，丢弃尚未上传的本地修改。'):
        ('检测到 '+result.conflicts+' 项冲突。'+(upload?'继续后，冲突项采用本地内容并上传，保留双方其余修改。':'继续后，冲突项采用仓库内容更新本地，保留其余本地修改。'));
      cancel.textContent='取消';accept.textContent=upload?'确认覆盖仓库并上传':'确认覆盖本地';accept.className='primary';
      const finish=value=>{dialog.remove();transferDialogBusy=false;resolve(value);};cancel.onclick=()=>finish(false);accept.onclick=()=>finish(true);dialog.oncancel=event=>{event.preventDefault();finish(false);};
      buttons.className='actions';buttons.append(cancel,accept);dialog.append(title,reason,text,buttons);document.body.append(dialog);if(dialog.showModal)dialog.showModal();else dialog.setAttribute('open','');cancel.focus();
    });
  }
  async function finishTransfer(result){
    if(result?.batch){
      const {direction,groups,context}=result.batch,messages=[];let done=0,error=false;
      for(const group of groups)try{
        const next=await finishTransfer(await request('dictionary-action',{action:direction,group,batchContext:context}));
        if(typeof next==='string'&&next.startsWith('已取消'))messages.push(group+'：'+next);else{done++;messages.push(typeof next==='string'?next:next?.message || group);}
      }catch(e){error=true;messages.push(group+'：'+e.message);}
      return {message:(direction==='upload'?'已上传 ':'已更新 ')+done+' 个主域名'+(messages.length?'；'+messages.join('；'):''),error};
    }
    if(result?.requiresConfirmation){
      if(!await askTransfer(result)){await request('dictionary-action',{action:'transfer-cancel',id:result.id});return '已取消覆盖，词库保留';}
      return request('dictionary-action',{action:'transfer-confirm',id:result.id});
    }
    return result;
  }
  async function updateDictionary(group){return finishTransfer(await request('dictionary-action',group?{action:'update',group}:{action:'all'}));}
  async function uploadDictionary(group){
    if(dictionaryUploading)return '正在上传，请等待当前操作完成';
    dictionaryUploading=true;uploadButtons();
    try{return await finishTransfer(await request('dictionary-action',group?{action:'upload',group}:{action:'upload-all'}));}
    finally{dictionaryUploading=false;uploadButtons();}
  }
  function renderCatalog(){
    const box=$('dictionaryResults');if(!box)return;box.replaceChildren();
    if(!catalogResult)return;
    const dictionary=current?.dictionary,language=current?.wt_preferences?.targetLanguage || 'zh-Hans';
    if(['provider','owner','repo','branch'].some(key=>dictionary?.repository?.[key]!==catalogResult.repository[key])||language!==catalogResult.targetLanguage){catalogResult=null;$('dictionarySearchStatus').textContent='仓库或目标语言已改变，请重新搜索。';return;}
    const rows=catalogResult.rows.filter(row=>!row.origins.every(origin=>dictionary?.groups[row.group]?.downloadedOrigins?.includes(origin)));
    $('dictionarySearchStatus').textContent=rows.length?'找到 '+rows.length+' 个未完整下载的主域名词库 · '+language:'没有符合条件的未下载主域名词库 · '+language;
    for(const row of rows){
      const item=document.createElement('article');item.className='dictionary-result';
      const text=document.createElement('div'),title=document.createElement('strong'),description=document.createElement('p');title.textContent=row.group;description.textContent=language+' · 主域名及子域名合并下载';description.className='detail';text.append(title,description);
      const download=button('下载',async()=>{
        if(dictionaryDownloads.has(row.group))return '正在下载此主域名词库，请稍候';
        dictionaryDownloads.add(row.group);renderCatalog();
        try{
          const origins=[...new Set([repositoryPermission(),...row.origins.map(origin=>{const u=new URL(origin);return u.protocol+'//'+u.hostname+'/*';})])];
          if(!await chrome.permissions.request({origins}))throw new Error('未授予词库或网站权限');
          const result=await request('dictionary-action',{action:'download-group',group:row.group});return result.includes('冲突')?{message:result,error:true}:result;
        }finally{dictionaryDownloads.delete(row.group);renderCatalog();}
      });download.disabled=dictionaryDownloads.has(row.group);download.setAttribute('aria-label','下载 '+row.group+' 词库');item.append(text,download);box.append(item);
    }
  }
  let popupCheckKey=null,popupRemote=null,popupBusy=false;
  function popupGroup(state,origin){return state.sites?.[origin]?.group || (popupRemote?.origin===origin?popupRemote.group:null);}
  function renderPopupDictionary(state,origin){
    const toggle=$('wtSiteToggle');if(!toggle)return;
    const site=state.sites?.[origin],info=state.dictionary,group=popupGroup(state,origin),local=info?.groups?.[group],pending=local?.pendingOrigins?.[origin] || 0;
    toggle.hidden=!origin;toggle.textContent=site&&!site.deleted&&site.enabled===false?'启用当前网页':'停用当前网页';toggle.disabled=popupBusy||!info?.ready;
    const remote=popupRemote?.origin===origin?popupRemote:null;
    $('wtDictionaryDownload').hidden=!origin||!remote?.available||remote.installed;
    $('wtDictionaryUpdate').hidden=!origin||!remote?.hasUpdate;
    $('wtDictionaryUpload').hidden=!origin||!pending;
    for(const id of ['wtDictionaryDownload','wtDictionaryUpdate','wtDictionaryUpload'])$(id).disabled=popupBusy;
    let text=!origin?'':!info?.ready?'本机词库准备中':remote?.error?'词库检测暂不可用':!remote?'正在检测词库…':!remote.available?'当前语言暂无词库':!remote.installed?'GitHub 有词库，可下载':remote.hasUpdate?'GitHub 词库有更新':'词库已是最新';
    if(pending)text+=' · '+pending+' 项待上传';$('wtDictionaryStatus').textContent=text;$('wtDictionaryStatus').title=remote?.error || text;
  }
  function checkPopupDictionary(state,origin){
    renderPopupDictionary(state,origin);if(!origin||!state.dictionary?.ready)return;
    const local=state.dictionary.groups[popupGroup(state,origin)],key=JSON.stringify([origin,state.dictionary.repository,state.wt_preferences?.targetLanguage || 'zh-Hans',state.dictionary.hasToken,local?.contentRevision]);
    if(popupCheckKey===key||popupBusy)return;
    popupCheckKey=key;popupRemote=null;renderPopupDictionary(state,origin);
    // A popup polls local task progress, but remote metadata is checked only once
    // per page/language/local revision; the repository client shares its 60s cache.
    request('dictionary-action',{action:'page-status',origin}).then(result=>{if(popupCheckKey!==key)return;popupRemote=result;renderPopupDictionary(current,origin);}).catch(error=>{if(popupCheckKey!==key)return;popupRemote={origin,error:error.message};renderPopupDictionary(current,origin);});
  }
  async function popupDictionaryAction(kind){
    if(popupBusy)return '词库操作进行中，请稍候';
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true}),u=new URL(tab?.url || 'about:blank');if(!['http:','https:'].includes(u.protocol))throw new Error('请打开普通网页');
    const origin=u.origin,group=popupGroup(current,origin);popupBusy=true;renderPopupDictionary(current,origin);
    try{
      if(kind==='toggle'){
        const site=current.sites?.[origin],enabled=!!site&&!site.deleted&&site.enabled===false;
        if(enabled&&!await chrome.permissions.request({origins:[u.protocol+'//'+u.hostname+'/*']}))throw new Error('未授予网站权限');
        if(!site||site.deleted)await request('install',{origin});
        await request('change',{siteId:site?.id || origin,kind:'setting',payload:{key:'enabled',value:enabled}});
        return enabled?'已启用当前网页':'已停用当前网页';
      }
      if(kind==='download'){
        const origins=[...new Set([repositoryPermission(),...(popupRemote?.origins || [origin]).map(origin=>{const site=new URL(origin);return site.protocol+'//'+site.hostname+'/*';})])];
        if(!await chrome.permissions.request({origins}))throw new Error('未授予词库或网站权限');
      }
      if(!group)throw new Error('词库检测尚未完成，请稍后重试');
      const result=await finishTransfer(await request('dictionary-action',{action:kind==='upload'?'upload':kind==='download'?'download-group':'update',group}));
      return typeof result==='string'&&result.includes('冲突')?{message:result,error:true}:result;
    }finally{popupBusy=false;popupCheckKey=null;popupRemote=null;}
  }
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
      const dictionary=current?.dictionary, checked=dictionary?.check?.groups.find(g=>g.group===name), info=dictionary?.groups[name];
      if(checked?.hasUpdate)controls.append(button('更新',async()=>{const result=await updateDictionary(name);await request('dictionary-action',{action:'check'});return result;}));
      if(info?.pending){const upload=button('上传',()=>uploadDictionary(name));upload.dataset.dictionaryUpload='';upload.disabled=dictionaryUploading;upload.title='待上传 '+info.pending+' 项本地新增、修改或删除';upload.setAttribute('aria-label','上传 '+name+' 词库');controls.append(upload);}
      if(info?.conflicts.length){const conflicts=document.createElement('div');conflicts.className='dictionary-conflicts';for(const c of info.conflicts){const box=document.createElement('article'),p=document.createElement('p');p.textContent=JSON.parse(c.key)[3]+' · 基线：'+(c.base?.entry.translation||'删除/无')+' · 本地：'+(c.local?.entry.translation||'删除/无')+' · 远端：'+(c.remote?.entry.translation||'删除/无');box.append(p);for(const [label,choice] of [['保留本地','local'],['采用远端','remote']])box.append(button(label,()=>request('dictionary-action',{action:'resolve',group:name,key:c.key,choice})));const edit=document.createElement('textarea');edit.value=c.local?.entry.translation||c.remote?.entry.translation||'';box.append(edit,button('编辑后使用',()=>{const row=JSON.parse(JSON.stringify(c.local||c.remote||c.base));row.entry={...row.entry,translation:edit.value,category:'ui',action:'translate',origin:'manual',userSelected:true};return request('dictionary-action',{action:'resolve',group:name,key:c.key,choice:'edited',edited:row});}));conflicts.append(box);}group.append(conflicts);}
      const enabled=values.every(s=>s.enabled);
      for(const b of [button(enabled?'停用':'启用',()=>request('group-change',{group:name,action:'enabled',enabled:!enabled})),button('删除',()=>request('group-change',{group:name,action:'delete'}))]){b.addEventListener('click',e=>e.stopPropagation());controls.append(b);}
      controls.addEventListener('click',e=>e.stopPropagation());heading.append(label,count,controls);group.prepend(heading);$('siteList').append(group);
      const grid=document.createElement('div');grid.className='site-grid';group.append(grid);
      for (const s of values) {
        const row = document.createElement('article'); row.className = 'site';
        const title = document.createElement('strong'); title.textContent = `${s.name} · ${s.origin}`;
        const info = document.createElement('p'); info.className = 'detail';
        const language=current?.wt_preferences?.targetLanguage || 'zh-Hans';
        const entries = Object.values(s.entries).filter(e => e.targetLanguage === language);
        info.textContent = `${s.authorized ? '已授权' : '待本机授权'} · ${language} · 增量 ${entries.filter(e => e.action === 'translate').length} 条 / 跳过 ${entries.filter(e => e.action === 'skip').length} 条 · 冲突 ${Object.keys(s.conflicts).length} 组${checked?.status==='no-language' ? ' · 此语言暂无词库' : current?.dictionary?.groups[s.group]?.missing?.includes(s.origin) || checked?.status==='no-dictionary' ? ' · 远端暂无此网址词库' : current?.dictionary?.groups[s.group]?.installed ? ' · 已下载词库' : ' · 远端词库待下载'}`;
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
          if(current?.dictionary)item.append(button('删除词条',()=>request('dictionary-action',{action:'delete-entry',group:s.group,row:{site:s.origin,entry:e}})));
          details.append(item);
        }
        if (entries.length > 100) { const p = document.createElement('p'); p.textContent = `仅展示前 100 条；共有 ${entries.length} 条，其他词条仍保留。`; details.append(p); }
        row.append(details); grid.append(row);
      }
    }
    if(!groups.size)$('siteList').textContent='尚未添加网站，在网页打开插件开始添加或采集。';
  }
  function taskText(t) { return `${statusNames[t.status] || t.status} · ${t.siteId} · ${t.targetLanguage} · ${t.completed}/${t.total} 项，翻译 ${t.translated} 项 · 本地复用 ${t.reused || 0} 项 / 跨页去重 ${t.deduplicated || 0} 项${t.batchTotal!==undefined?' · 动态批次 '+t.batchCompleted+'/' +t.batchTotal+' · 重试 '+(t.retries || 0)+' 次':''}${t.contextBudget?' · 输入上限 '+(t.contextBudget/1000)+'K':''}${t.requestTimeoutMinutes?' · 单次超时 '+t.requestTimeoutMinutes+' 分钟':''}${t.truncated ? ' · 采集已达到上限' : ''} ${t.message || ''}`; }
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
  let repositorySession=null,repositoryRun=0,repositoryInitialized=false;
  const repositoryPermission=(selected=current?.dictionary?.repository?.provider||'github')=>selected==='gitee'?'https://gitee.com/*':'https://api.github.com/*';
  function repositoryHelp(){
    const selected=$('repositoryProvider').value,label=selected==='gitee'?'Gitee':'GitHub',saved=current?.dictionary?.credentialPlatforms?.[selected];
    const help=$('repositoryTokenHelp');help.replaceChildren();help.append((saved?'本平台已保存令牌。':'本平台尚未保存令牌。')+' ');
    const link=document.createElement('a');link.href=selected==='gitee'?'https://gitee.com/profile/personal_access_tokens':'https://github.com/settings/personal-access-tokens/new';link.target='_blank';link.rel='noopener noreferrer';link.textContent='创建 '+label+' 令牌';help.append(link);
    help.append(selected==='github'?'。读取需要所选仓库的 Contents 读取权限；上传需要写入权限。':'。请选择能访问目标仓库的权限；需要上传时还需仓库写入权限。');
  }
  function invalidateRepositoryTest(){
    repositoryRun++;const old=repositorySession;repositorySession=null;
    $('repositoryChoices').replaceChildren(new Option('请先进行仓库测试',''));$('repositoryChoices').disabled=true;$('repositoryConfirm').disabled=true;
    $('repositoryConfirm').textContent='确认仓库';$('repositorySelectionHint').textContent='';
    $('repositoryTestStatus').textContent='';$('repositoryCancel').hidden=true;
    if(old)request('dictionary-action',{action:'repository-test-cancel',id:old.id}).catch(()=>{});
  }
  function repositorySelection(){
    const row=repositorySession?.candidates.find(r=>r.id===$('repositoryChoices').value),initialize=['empty','resume'].includes(row?.type);
    $('repositoryConfirm').disabled=!repositorySession?.done||!row;
    $('repositoryConfirm').textContent=initialize?(row.type==='resume'?'继续初始化并连接':'初始化并连接'):'确认仓库';
    $('repositorySelectionHint').textContent=initialize?'确认后将上传 GitHub 主站（github.com）的简体中文词库、索引、许可证和来源说明。需要写入权限；上传完成并校验后才切换连接。':'已有词库仓库确认后直接连接。';
  }
  function renderRepositoryTest(result){
    repositorySession=result;const select=$('repositoryChoices'),chosen=select.value;select.replaceChildren(new Option('请选择词库仓库',''));
    for(const row of result.candidates){const r=row.repository,label=row.type==='empty'?'空仓库 · 将初始化 GitHub 主站词库':row.type==='resume'?'初始化未完成 · 可继续':'已有词库';select.append(new Option(r.owner+'/'+r.repo+' · '+r.branch+' · '+label+(row.writePermission===true?' · 平台报告可写':row.writePermission===false?' · 平台报告只读':' · 写入权限待验证'),row.id));}
    if([...select.options].some(o=>o.value===chosen))select.value=chosen;
    select.disabled=!result.done||!result.candidates.length;$('repositoryConfirm').disabled=!result.done||!select.value;
    repositorySelection();
    $('repositoryTestStatus').textContent=(result.done?'测试完成':'正在检测')+' · 已检查 '+result.scanned+' 个仓库，发现 '+result.candidates.length+' 个词库仓库'+(result.empty?'；'+result.empty+' 个空仓库':'')+(result.inaccessible?'；'+result.inaccessible+' 个仓库无读取权限':'')+(result.invalid?'；有不兼容或无效索引':'')+(result.partial?'；已达到本轮扫描上限，结果不完整':'');
  }
  function renderDictionary(info){
    if(!info?.ready){const progress=info?.status?.startup;$('dictionaryStatus').textContent=info?.status?.error||((progress?.phase||'词库服务初始化中')+(progress?.total?' · '+progress.done+'/'+progress.total:''));$('dictionaryStatus').hidden=false;$('dictionaryAll').hidden=true;$('dictionaryUploadAll').hidden=true;return;}
    const status=info.status||{},network=(status.needsAuthorization||status.networkRetryAt>Date.now())?status.networkError:null,updates=info.check?.groups.filter(g=>g.hasUpdate)||[];
    $('dictionaryAll').hidden=!updates.length;$('dictionaryAll').textContent='全部更新（'+updates.length+'）';
    const pending=Object.values(info.groups).filter(data=>data.pending).length;$('dictionaryUploadAll').hidden=!pending;$('dictionaryUploadAll').textContent='上传全部（'+pending+'）';uploadButtons();
    $('dictionaryStatus').textContent=status.busy?'正在更新 '+status.busy:(status.networkKind==='rate-limit'&&status.networkRetryAt<=Date.now()?'上次限流等待已结束，可检查更新':status.error)||network||status.syncError||'';$('dictionaryStatus').hidden=!$('dictionaryStatus').textContent;
    $('repositoryStatus').textContent=(info.hasToken?'本设备已配置凭据 · API 请求携带 Token':'本设备未配置凭据 · 当前匿名访问')+(status.lastUpload?' · 上次上传 '+status.lastUpload:'')+(status.syncError?' · 设置同步失败：'+status.syncError:'')+(status.networkKind==='rate-limit'&&status.networkRetryAt>Date.now()&&status.rateLimit?.limit!==null&&status.rateLimit?.limit!==undefined?' · 最近请求配额 '+status.rateLimit.limit+'/小时，剩余 '+(status.rateLimit.remaining??'未知'):'')+(status.promptLocalOnly?' · 当前提示词超过同步容量，仅保存在本机':'');
    $('repositoryCurrent').textContent='当前连接：'+(info.repository.provider==='gitee'?'Gitee':'GitHub')+' · '+info.repository.owner+'/'+info.repository.repo+' · '+info.repository.branch;
    if(!repositoryInitialized||!dirtyForms.has('repositoryForm')&&!repositorySession&&!$('repositoryToken').value){$('repositoryProvider').value=info.repository.provider||'github';repositoryInitialized=true;}repositoryHelp();
    renderCatalog();
  }
  function refresh(forms=false){if(refreshFlight){refreshAgain=true;return refreshFlight;}refreshFlight=refreshState(forms||!formsLoaded).finally(()=>{refreshFlight=null;if(refreshAgain){refreshAgain=false;setTimeout(()=>refresh(false).catch(()=>{}),100);}});return refreshFlight;}
  async function refreshState(forms = false) {
    const popup=!$('siteList');let origin=null;
    if(popup){const [tab]=await chrome.tabs.query({active:true,currentWindow:true});origin=/^https?:/.test(tab?.url || '')?new URL(tab.url).origin:null;}
    const state = await request(popup?'popup-state':'state',popup?{origin}:{}); current = state;
    if ($('siteList')) {
      renderSites(state.sites);renderTasks(state.wt_tasks);renderQueue(state);
      renderDictionary(state.dictionary);
      if (forms) { const a=state.wt_ai || {};if(!dirtyForms.has('aiForm'))loadProvider(WTProviders.catalog[a.provider]?a.provider:'api',a);if(!dirtyForms.has('promptForm'))$('prompt').value=state.wt_prompt || a.prompt || state.defaultPrompt || ''; if(!dirtyForms.has('generalForm')){const language=state.wt_preferences?.targetLanguage || 'zh-Hans';if(![...$('targetLanguage').options].some(o=>o.value===language)){const o=document.createElement('option');o.value=language;o.textContent=language;$('targetLanguage').append(o);}$('targetLanguage').value=language;$('requestTimeoutMinutes').value=state.wt_preferences?.requestTimeoutMinutes ?? 3;for(const [key,value] of Object.entries(collectionDefaults))$(key).value=state.wt_preferences?.[key] ?? value;$('globalEnabled').checked=state.globalEnabled!==false;}formsLoaded=true; }
    } else if ($('wtProgress')) {
      $('wtSite').textContent=origin || '请打开普通网页';$('wtSite').title=origin || '';
      let pending=$('wtPending');if(!pending){pending=document.createElement('p');pending.id='wtPending';pending.className='usage-note';$('wtProgress').after(pending);}
      const count=state.manualPending || 0;
      pending.textContent='当前语言手动待翻译：'+count+' 项';
      const recentSelection=state.wt_selection_status?.siteId===origin && Date.now()-state.wt_selection_status.at<60000;
      if(recentSelection)pending.textContent+=' · '+state.wt_selection_status.message;
      pending.hidden=!count&&!recentSelection;pending.title=pending.textContent;
      const task=Object.values(state.wt_tasks || {}).filter(t=>t.siteId===origin).sort((a,b)=>b.updatedAt-a.updatedAt)[0];
      const c=state.wt_capture,collecting=c?.status==='collecting';
      $('wtProgress').textContent=collecting ? '正在采集 '+c.group+' · '+c.pageCount+' 页 / '+c.itemCount+' 项'+(c.lastError?' · 采集遇到问题':'')+(c.truncated?' · 已达上限':'') : task ? `${statusNames[task.status] || task.status} · ${task.completed}/${task.total} 项 · 翻译 ${task.translated} · 复用 ${task.reused || 0}${['failed','partial','interrupted'].includes(task.status)?' · 详情见翻译记录':''}` : '添加当前页面，或先采集多个页面再翻译。';
      $('wtProgress').title=collecting?(c.lastError || $('wtProgress').textContent):task?taskText(task):$('wtProgress').textContent;
      $('wtSaveStatus').textContent=state.dictionary?.starting ? ((state.dictionary.status?.startup?.phase||'正在加载本机词库')+'，设置可立即打开') : !state.dictionary?.ready?state.dictionary?.status?.error || '':state.dictionary?.status?.syncError || '';
      $('wtSaveStatus').hidden=!$('wtSaveStatus').textContent;$('wtSaveStatus').title=$('wtSaveStatus').textContent;
      $('wtCapture').textContent=collecting?'完成并翻译':'开始采集';$('wtCancel').hidden=!collecting;$('wtStart').hidden=collecting;$('wtStart').disabled=collecting;
      $('enable_extension').checked=state.globalEnabled!==false;$('status').textContent=state.globalEnabled!==false?'已开启':'已关闭';$('status').classList.toggle('is-on',state.globalEnabled!==false);
      $('status').classList.toggle('is-off',state.globalEnabled===false);checkPopupDictionary(state,origin);
    }
  }
  if ($('siteList')) {
    for(const [id,p] of Object.entries(WTProviders.catalog)){const option=document.createElement('option');option.value=id;option.textContent=p.label;$('provider').append(option);}
    $('provider').onchange=()=>{drafts[selectedProvider]={...aiValues(),provider:selectedProvider};loadProvider($('provider').value,drafts[$('provider').value] || current?.wt_ai_profiles?.[$('provider').value] || {});};
    $('version').textContent='v'+(chrome.runtime.getManifest?.().version || '');
    const tabs=[...document.querySelectorAll('[data-tab]')];
    function selectTab(id){if(!tabs.some(t=>t.dataset.tab===id))id='general';for(const tab of tabs){const active=tab.dataset.tab===id;tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;$(tab.dataset.tab).hidden=!active;}history.replaceState(null,'','#'+id);}
    for(const [i,tab] of tabs.entries()){tab.onclick=()=>selectTab(tab.dataset.tab);tab.onkeydown=e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();const next=e.key==='Home'?0:e.key==='End'?tabs.length-1:(i+(e.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;selectTab(tabs[next].dataset.tab);tabs[next].focus();};}
    selectTab(location.hash.slice(1));
    $('generalForm').onsubmit=e=>{e.preventDefault();action(async()=>{await request('config',{preferences:{...Object.fromEntries(Object.keys(collectionDefaults).map(key=>[key,Number($(key).value)])),targetLanguage:$('targetLanguage').value.trim(),requestTimeoutMinutes:Number($('requestTimeoutMinutes').value)}});await chrome.storage.sync.set({enable_extension:$('globalEnabled').checked});});};
    $('promptForm').onsubmit=e=>{e.preventDefault();action(()=>request('config',{prompt:$('prompt').value}),e.submitter);};
    $('resetPrompt').onclick=()=>{$('prompt').value=current.defaultPrompt;};
    for(const box of document.querySelectorAll('.native-setup')){
      const result=box.querySelector('[data-native-result]');
      box.querySelector('[data-native-id]').textContent=chrome.runtime.id;
      box.querySelector('[data-copy-native-id]').onclick=()=>action(async()=>{await navigator.clipboard.writeText(chrome.runtime.id);return '已复制扩展 ID，请在独立本地程序安装时使用';});
      const check=box.querySelector('[data-check-native]');check.onclick=()=>action(async()=>{
        result.textContent='正在检查本地连接…';
        try{const r=await nativeRequest('ping');if(r.connected!==true)throw new Error('本地程序响应无效，请更新程序');result.textContent='本地连接正常 · 程序版本 '+r.version+' · 可继续登录 ChatGPT 订阅';}
        catch(e){result.textContent=e.message;throw e;}
      },check);
    }
    nativeDistribution();
    $('aiForm').onsubmit=e=>{e.preventDefault();action(saveAI,e.submitter);};
    $('clearApiKey').onclick=()=>action(async()=>{const ai={...aiValues(),apiKey:''};await request('config',{ai});$('apiKey').value='';drafts[ai.provider]=ai;return '已清除当前服务 API Key，并加入浏览器设置同步';},$('clearApiKey'));
    $('testConnection').onclick=()=>{if(!$('aiForm').reportValidity())return;action(async()=>{if($('provider').value==='chatgpt')await ensureNativePermission();await saveAI();await request('test');return '连接测试通过，测试译文已校验';},$('testConnection'));};
    $('repositoryProvider').onchange=()=>{dirtyForms.add('repositoryForm');invalidateRepositoryTest();$('repositoryToken').value='';repositoryHelp();};
    $('repositoryToken').oninput=()=>{dirtyForms.add('repositoryForm');invalidateRepositoryTest();};
    $('repositoryCancel').onclick=invalidateRepositoryTest;
    $('repositoryChoices').onchange=repositorySelection;
    $('repositoryForm').onsubmit=e=>{e.preventDefault();invalidateRepositoryTest();const run=repositoryRun,provider=$('repositoryProvider').value,token=$('repositoryToken').value.trim();
      action(async()=>{
        if(!await chrome.permissions.request({origins:[repositoryPermission(provider)]}))throw new Error('未授予所选平台连接权限');
        $('repositoryToken').value='';$('repositoryTestStatus').textContent='正在验证令牌…';$('repositoryCancel').hidden=false;
        let result=await request('dictionary-action',{action:'repository-test',provider,token});
        while(run===repositoryRun){renderRepositoryTest(result);if(result.done)break;result=await request('dictionary-action',{action:'repository-test-next',id:result.id});}
        if(run!==repositoryRun){request('dictionary-action',{action:'repository-test-cancel',id:result.id}).catch(()=>{});return '仓库测试已取消';}
        return result.candidates.length?'请选择词库仓库并确认':'没有发现可读取的词库索引；请检查令牌权限及仓库是否已上传词库';
      },e.submitter).finally(()=>{$('repositoryCancel').hidden=true;});
    };
    $('repositoryConfirm').onclick=()=>{const session=repositorySession,candidateId=$('repositoryChoices').value;if(!session||!candidateId)return;
      const controls=['repositoryProvider','repositoryToken','repositoryTest','repositoryClearToken','repositoryChoices'];controls.forEach(id=>$(id).disabled=true);
      action(async()=>{
        let result;try{do {
          result=await request('dictionary-action',{action:'repository-confirm',id:session.id,candidateId});
          if(result.initializing)$('repositoryTestStatus').textContent='正在初始化词库仓库 · 已上传 '+result.completed+'/'+result.total+' 个文件；完成后将校验并连接。关闭此页可暂停，重新测试可继续。';
        }while(result.initializing);}catch(error){$('repositoryTestStatus').textContent='操作已停止：'+error.message;throw error;}
        dirtyForms.delete('repositoryForm');invalidateRepositoryTest();return result;
      },$('repositoryConfirm')).finally(()=>{controls.forEach(id=>$(id).disabled=false);$('repositoryChoices').disabled=!repositorySession?.done;repositorySelection();});
    };
    $('repositoryClearToken').onclick=()=>action(async()=>{invalidateRepositoryTest();$('repositoryToken').value='';return request('dictionary-action',{action:'repository-clear-token',provider:$('repositoryProvider').value});},$('repositoryClearToken'));
    $('dictionaryCheck').onclick=()=>action(()=>request('dictionary-action',{action:'check'}),$('dictionaryCheck'));
    $('dictionaryAll').onclick=()=>action(()=>updateDictionary(),$('dictionaryAll'));
    $('dictionaryUploadAll').onclick=()=>action(()=>uploadDictionary(),$('dictionaryUploadAll'));
    $('dictionarySearchForm').onsubmit=e=>{e.preventDefault();action(async()=>{
      if(!await chrome.permissions.request({origins:[repositoryPermission()]}))throw new Error('未授予词库平台连接权限');
      catalogResult=null;$('dictionaryResults').replaceChildren();$('dictionarySearchStatus').textContent='正在检索词库…';
      try{catalogResult=await request('dictionary-action',{action:'catalog',query:$('dictionaryQuery').value.trim()});}
      catch(error){$('dictionarySearchStatus').textContent='检索失败，请稍后重新搜索。';throw error;}
      return '词库搜索完成';
    },$('dictionarySearch'));};
    $('login').onclick=()=>action(async()=>{
      await ensureNativePermission();
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
    $('models').onclick=()=>action(async()=>{const models=await nativeRequest('models');renderModels(models);return `已读取 ${models.length} 个模型，请从完整列表选择并保存`;},$('models'));
    for (const [id, actionName] of [['logout','logout'],['nativeStatus','status']]) $(id).onclick=()=>action(async()=>{const r=await nativeRequest(actionName);$('accountStatus').textContent=r.signedIn?`ChatGPT 已登录：${r.email || '账号信息不可用'}（模型访问需实际请求验证）`:`本地程序已连接，ChatGPT 未登录${actionName==='logout' && !r.revoked?'；远端撤销未确认，可在 ChatGPT 设置中断开此应用':''}`;});
  } else {
    // Content determines the popup height. Compact spacing only when the browser
    // cannot fit the content in its available screen area; text stays readable.
    let fitTimer;
    const fitPopup=()=>{clearTimeout(fitTimer);fitTimer=setTimeout(()=>{if(document.body.scrollHeight>innerHeight+1){if(!document.body.hasAttribute('data-compact'))document.body.dataset.compact='true';else document.body.dataset.dense='true';}},160);};
    window.addEventListener('resize',fitPopup);if(globalThis.ResizeObserver)new ResizeObserver(fitPopup).observe(document.querySelector('main'));fitPopup();
    for(const [id,kind] of [['wtDictionaryDownload','download'],['wtDictionaryUpdate','update'],['wtDictionaryUpload','upload'],['wtSiteToggle','toggle']])if($(id))$(id).onclick=()=>action(()=>popupDictionaryAction(kind),$(id));
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
    setInterval(()=>refresh(false).catch(()=>{}),10000);
  }
  if($('wtProgress')){$('wtProgress').textContent='正在读取本机数据，设置可立即打开';$('status').textContent='正在读取';}
  refresh(true).catch(e=>{showMessage(e.message,true);setTimeout(()=>refresh(true).catch(()=>{}),2000);});
  let refreshTimer;
  chrome.storage.onChanged.addListener((changes,area)=>{
    if(!$('siteList')&&area==='sync'&&changes.enable_extension){clearTimeout(refreshTimer);refreshTimer=setTimeout(()=>refresh(false).catch(()=>{}),120);return;}
    if(area!=='local')return;
    if(!$('siteList')){if(['wt_tasks','wt_capture','wt_manual_queue','wt_view','wt_preferences','wt_repository','wt_repository_status','wt_dictionary_check','wt_selection_status'].some(key=>changes[key])){clearTimeout(refreshTimer);refreshTimer=setTimeout(()=>refresh(false).catch(()=>{}),120);}return;}
    if(changes.wt_view || changes.wt_preferences || changes.wt_repository || changes.wt_repository_status || changes.wt_dictionary_check)refresh(false).catch(()=>{});
    else if(changes.wt_tasks || changes.wt_task_inputs || changes.wt_manual_queue)request('state').then(state=>{current=state;renderTasks(state.wt_tasks);renderQueue(state);}).catch(()=>{});
  });
})();
