/* GPL-3.0-or-later */
(() => {
  'use strict';
  const C = WTCore, P=WTProviders, B=WTBatch, HOST = 'local.website_translator';
  const requestSlot=B.limiter();
  let queue = Promise.resolve(), database, committed;
  const locked = fn => { const next = queue.then(fn); queue = next.catch(() => {}); return next; };
  let cachedView,viewOps,viewLength,versionOps,versionLength,versionIndex;
  function localVersions(){if(versionOps!==database.ops||versionLength!==database.ops.length){versionIndex=new Map();for(const op of database.ops)if(op.kind==='entry')versionIndex.set(C.canonical([op.siteId,op.generation,op.payload]),op.opId);versionOps=database.ops;versionLength=database.ops.length;}return versionIndex;}
  const view = () => {if(viewOps!==database.ops || viewLength!==database.ops.length){cachedView=C.materialize(database.ops);if(globalThis.WTDictionaryRuntime)for(const site of Object.values(cachedView.sites))site.group=C.dictionary.groupFor(site.origin,tldts.getDomain);viewOps=database.ops;viewLength=database.ops.length;}return cachedView;};
  function heads() {
    const applied = new Set(view().applied);
    const deps = new Set(applied);
    database.ops.filter(o => applied.has(o.opId)).forEach(o => o.deps.forEach(d => deps.delete(d)));
    return [...deps];
  }
  function append(siteId, generation, kind, payload, deps=heads()) {
    C.assert(!dictionaryRuntime||dictionaryRuntime.active(),'本机词库初始化尚未完成，请稍后重试');
    const seq = ++database.seq;
    const op = { schemaVersion: 1, deviceId: database.deviceId, seq, opId: `${database.deviceId}-${seq}`, deps, siteId, generation, kind, payload };
    C.validateOp(op); database.ops.push(op); return op;
  }
  async function save(localChange=true) {
    try {
      // Operations are immutable and append-only; compare their identity rather than stringify all history.
      const changed=localChange && (database.deviceId!==committed.deviceId || database.seq!==committed.seq || database.ops.length!==committed.ops.length);
      await chrome.storage.local.set({ wt_database: database, wt_view: view() });
      committed = structuredClone(database);
      if(changed)dictionaryRuntime?.changed();
    }
    catch (error) { database = structuredClone(committed); throw error; }
  }
  async function applySyncedRows(rows){
      const values={}; const sites=new Map();
      for(const row of rows)if(row.kind==='preference')values[row.field]=row.value;else {if(!sites.has(row.id))sites.set(row.id,{});sites.get(row.id)[row.field]=row.value;}
      for(const [field,value] of Object.entries(values))if(field==='aiSettings'||field.startsWith('aiProfile:'))C.assert(Object.hasOwn(P.catalog,value.provider),'同步服务无效，未应用本轮设置');
      for(const [origin,settings] of sites){let site=view().sites[origin];
        if(settings.installed===false){if(site&&!site.deleted)append(site.id,site.generation,'delete',{});continue;}
        if(settings.installed!==true)continue;
        if(!site||site.deleted){const known=SUPPORTED_SITES.find(s=>s.matches.includes(origin+'/*'));append(origin,(site?.generation||0)+1,'create',{origin,name:settings.name||new URL(origin).hostname,group:group(origin),builtinId:known?.id||null});site=view().sites[origin];}
        for(const key of ['enabled','excludedPaths'])if(settings[key]!==undefined&&C.canonical(site[key])!==C.canonical(settings[key]))append(site.id,site.generation,'setting',{key,value:settings[key]});
      }
      const profiles=(await chrome.storage.local.get('wt_ai_profiles')).wt_ai_profiles || {};
      const {wt_ai_local_keys:keys={}}=await chrome.storage.local.get('wt_ai_local_keys');
      for(const profile of Object.values(profiles))if(profile.apiKey)keys[C.canonical([profile.provider,profile.endpoint])]=profile.apiKey;
      for(const [field,a] of Object.entries(values))if((field==='aiSettings'||field.startsWith('aiProfile:'))&&Object.hasOwn(a,'apiKey'))keys[C.canonical([a.provider,a.endpoint])]=a.apiKey;
      const keyFor=a=>Object.hasOwn(a,'apiKey')?a.apiKey:keys[C.canonical([a.provider,a.endpoint])] || '';
      await chrome.storage.local.set({wt_ai_local_keys:keys});
      for(const [field,a] of Object.entries(values))if(field.startsWith('aiProfile:')){C.assert(P.catalog[a.provider],'同步服务无效');profiles[a.provider]={...a,apiKey:keyFor(a)};}
      if(values.aiSettings){const a=values.aiSettings;C.assert(P.catalog[a.provider],'同步服务无效');const selected=values['aiProfile:'+a.provider] || a;profiles[a.provider]={...selected,apiKey:keyFor(selected)};await chrome.storage.local.set({wt_ai:profiles[a.provider]});}
      await chrome.storage.local.set({wt_ai_profiles:profiles});
      const old=await preferences(),prefs={...old,...WTCore.dictionary.syncPreferences(values)};
      const {wt_prompt:localPrompt}=await chrome.storage.local.get('wt_prompt');
      const canSyncPrompt=localPrompt===undefined||C.dictionary.bytes(localPrompt)<=5000;
      await chrome.storage.local.set({wt_preferences:prefs,...(canSyncPrompt&&values.prompt!==undefined?{wt_prompt:C.validatePrompt(values.prompt)}:{})});
      if(values.enable_extension!==undefined && (await chrome.storage.sync.get('enable_extension')).enable_extension!==values.enable_extension)await chrome.storage.sync.set({enable_extension:values.enable_extension});
      await save(false);await registrations();
  }

  const dictionaryRuntime = globalThis.WTDictionaryRuntime?.create({
    localVersion:(site,entry)=>localVersions().get(C.canonical([site.origin,site.generation,entry])) || '',
    view, database:()=>database, deviceId:()=>database.deviceId, preferences, broadcast,installOrigins,
    applySync:rows=>locked(()=>applySyncedRows(rows))
  });
  const ready = locked(async () => {
    await chrome.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });
    const stored = await chrome.storage.local.get(['wt_database', 'wt_tasks']);
    const oldSettings = await chrome.storage.sync.get(null);
    const secretKeys = Object.keys(oldSettings).filter(k => /(?:api_key|apiKey|token|secret)/i.test(k) && !/(?:enable|record)/i.test(k));
    const { wt_legacy_secrets = {} } = await chrome.storage.local.get('wt_legacy_secrets');
    for (const key of secretKeys) if (!(key in wt_legacy_secrets)) wt_legacy_secrets[key] = oldSettings[key];
    await chrome.storage.local.set({ wt_legacy_secrets });
    if (secretKeys.length) await chrome.storage.sync.remove(secretKeys);
    const {wt_ai,wt_ai_profiles}=await chrome.storage.local.get(['wt_ai','wt_ai_profiles']);
    if(!wt_ai_profiles) {
      const profiles={},old={...oldSettings,...wt_legacy_secrets};
      for(const provider of ['deepl','google','azure','qwen_mt']) {
        const prefix='readme_'+provider;
        if(old[prefix+'_api_key'])profiles[provider]={provider,endpoint:old[prefix+'_api_url'] || P.catalog[provider].endpoint,apiKey:old[prefix+'_api_key'],model:old[prefix+'_model'] || '',region:old.readme_azure_region || ''};
      }
      const selected=old.readme_provider==='openai_compatible'?'api':old.readme_provider;
      if(P.catalog[selected]?.kind==='chat' && old.readme_openai_api_key)profiles[selected]={provider:selected,endpoint:old.readme_openai_api_url,apiKey:old.readme_openai_api_key,model:old.readme_openai_model || ''};
      if(wt_ai)profiles[wt_ai.provider]=wt_ai;
      await chrome.storage.local.set({wt_ai_profiles:profiles,...(!wt_ai && profiles[selected]?{wt_ai:profiles[selected]}:{})});
    }
    const {wt_prompt}=await chrome.storage.local.get('wt_prompt');
    if(wt_prompt===undefined)await chrome.storage.local.set({wt_prompt:C.validatePrompt(wt_ai?.prompt)});
    database = stored.wt_database || { schemaVersion: 1, deviceId: crypto.randomUUID(), seq: 0, ops: [] };
    committed = structuredClone(database);
    if (!stored.wt_database && !dictionaryRuntime) {
      const old = await chrome.storage.sync.get(null);
      for (const site of SUPPORTED_SITES) for (const pattern of site.matches) {
        const origin = new URL(pattern.replace('*', '')).origin;
        if (view().sites[origin]) continue;
        append(origin, 1, 'create', { origin, builtinId: site.id, builtinVersion: chrome.runtime.getManifest().version, name: site.name, group: group(origin) });
        if (old[`site_enabled_${site.id}`] === false) append(origin, 1, 'setting', { key: 'enabled', value: false });
      }
    }
    const tasks = stored.wt_tasks || {};
    for (const task of Object.values(tasks)) if (task.status === 'running') { task.status = 'interrupted'; task.message = '后台已重启，已保存批次保留；在翻译记录中重试剩余内容。'; }
    await chrome.storage.local.set({ wt_tasks: tasks });
    await save();
    await registrations();
  });
  const dictionaryReady = ready.then(()=>dictionaryRuntime?.start()).catch(error=>chrome.storage.local.set({wt_repository_status:{error:'本机词库加载失败，现有词条保留：'+error.message}}));
  function group(origin) { const u = new URL(origin); if(dictionaryRuntime)return C.dictionary.groupFor(u.origin,tldts.getDomain);return tldts.getDomain(u.hostname, { allowPrivateDomains: true }) || u.host; }
  async function installOrigins(origins,expectedLanguage,expectedInstallations){
    C.assert(Array.isArray(origins)&&origins.length>0&&origins.length<=1000&&new Set(origins).size===origins.length,'安装范围无效');for(const origin of origins)C.dictionary.origin(origin);
    await locked(async()=>{
      if(expectedLanguage)C.assert((await preferences()).targetLanguage===expectedLanguage,'目标语言已改变，请重新下载');
      const installed=Object.values(view().sites).filter(site=>!site.deleted).map(site=>({origin:site.origin,generation:site.generation})).sort((a,b)=>a.origin.localeCompare(b.origin,'en'));
      if(expectedInstallations)C.assert(C.canonical(installed)===C.canonical(expectedInstallations),'下载期间已添加网站发生变化，请重新下载');
      C.assert(new Set([...installed.map(site=>site.origin),...origins]).size<=C.dictionary.limits.origins,'已添加网址数量超过上限，请先移除不用的网站');
      try{let changed=false,deps;const sites=view().sites;for(const origin of origins){const site=sites[origin];if(site&&!site.deleted)continue;const known=SUPPORTED_SITES.find(s=>s.matches.includes(origin+'/*'));deps ||= heads();const op=append(origin,(site?.generation||0)+1,'create',{origin,name:new URL(origin).hostname,group:group(origin),builtinId:known?.id||null},deps);deps=[op.opId];changed=true;}if(changed)await save();}
      catch(error){database=structuredClone(committed);throw error;}
    });await registrations();
  }
  function siteFor(url) { return view().sites[new URL(url).origin]; }
  function isGithubOrigin(url) {
    try { const origin=new URL(url).origin;return SUPPORTED_SITES.some(s=>s.id==='github' && s.matches.includes(`${origin}/*`)); } catch { return false; }
  }
  async function native(message) {
    C.assert(await chrome.permissions.contains({permissions:['nativeMessaging']}),'请在 AI 翻译设置中授予本地通信权限；词库和 API 翻译不需要此权限');
    let result;
    try {
      // Long translation requests use a port so the native connection keeps the worker alive.
      result=message.action==='translate' && chrome.runtime.connectNative ? await new Promise((resolve,reject)=>{
        const port=chrome.runtime.connectNative(HOST);let settled=false;
        const finish=(error,value)=>{if(settled)return;settled=true;port.disconnect();error?reject(error):resolve(value);};
        port.onMessage.addListener(value=>finish(null,value));
        port.onDisconnect.addListener(()=>{const error=chrome.runtime.lastError;finish(new Error(error?.message || '本地翻译连接已断开'));});
        port.postMessage(message);
      }) : await chrome.runtime.sendNativeMessage(HOST, message);
    }
    catch (e) {
      if(/forbidden/i.test(e.message))throw new Error(`本地程序未授权当前扩展（${chrome.runtime.id}）。请在 AI 翻译设置复制扩展 ID，在独立本地程序目录重新运行 Install.cmd，再检查连接。`);
      throw new Error(`无法连接本地程序：${e.message}。请在本地连接设置中安装或更新程序，并核对浏览器注册。`);
    }
    if (!result?.ok) throw B.error(result?.error || '本地操作失败',result?.kind || 'fatal',{status:result?.status,retryAfterMs:result?.retryAfterMs});
    return result.result;
  }
  let registrationFlight,registrationAgain=false;
  function registrations(){
    registrationAgain=true;
    if(!registrationFlight)registrationFlight=(async()=>{do{registrationAgain=false;await registerSites();}while(registrationAgain);})().finally(()=>{registrationFlight=null;});
    return registrationFlight;
  }
  async function registerSites() {
    const sites = Object.values(view().sites).filter(s => !s.deleted);
    const desired = [];
    for (const s of sites) {
      const match = `${new URL(s.origin).protocol}//${new URL(s.origin).hostname}/*`;
      if (await chrome.permissions.contains({ origins: [match] })) desired.push(match);
    }
    const {wt_capture}=await chrome.storage.local.get('wt_capture');
    if(wt_capture?.status==='collecting') for(const match of wt_capture.matches) if(await chrome.permissions.contains({origins:[match]}))desired.push(match);
    const existing = await chrome.scripting.getRegisteredContentScripts();
    const previous=existing.find(s=>s.id==='wt-managed'),matches=[...new Set(desired)].sort(),js=['managed/core.js','managed/text-provenance.js','managed/content.js'];
    if(previous && C.canonical([...(previous.matches || [])].sort())===C.canonical(matches) && C.canonical(previous.js)===C.canonical(js) && previous.runAt==='document_start' && previous.persistAcrossSessions!==false && previous.world!=='MAIN' && !previous.allFrames && !previous.excludeMatches?.length)return;
    if(previous)await chrome.scripting.unregisterContentScripts({ids:['wt-managed']});
    if(matches.length)await chrome.scripting.registerContentScripts([{id:'wt-managed',matches,js,runAt:'document_start',persistAcrossSessions:true}]);
  }
  async function pageState(url, tabId) {
    let site = siteFor(url);
    const {wt_preferences={},wt_capture} = await chrome.storage.local.get(['wt_preferences','wt_capture','wt_ai_profiles']);
    if(site)site={...(dictionaryRuntime ? await dictionaryRuntime.enrich(site) : site),targetLanguage:wt_preferences.targetLanguage || 'zh-Hans'};
    let captureId=null;
    if(wt_capture?.status==='collecting' && group(url)===wt_capture.group) {
      const tab=tabId==null?null:await chrome.tabs.get(tabId).catch(()=>null);
      if(wt_capture.tabIds.includes(tabId) || wt_capture.tabIds.includes(tab?.openerTabId)) {
        captureId=wt_capture.id;
        if(!wt_capture.tabIds.includes(tabId)) await locked(async()=>{const {wt_capture:c}=await chrome.storage.local.get('wt_capture');if(c?.id===captureId && !c.tabIds.includes(tabId)){c.tabIds.push(tabId);await chrome.storage.local.set({wt_capture:c});}});
      }
    }
    const { enable_extension = true } = await chrome.storage.sync.get('enable_extension');
    return { site, captureLimits:C.captureLimits(wt_preferences), autoExpandSeconds:C.autoExpandSeconds(wt_preferences.autoExpandSeconds), globalEnabled: enable_extension, captureId:enable_extension!==false ? captureId : null };
  }
  async function broadcast() {
    for (const tab of await chrome.tabs.query({})) {
      if (!/^https?:/.test(tab.url || '')) continue;
      chrome.tabs.sendMessage(tab.id, { type: 'wt:apply', ...(await pageState(tab.url,tab.id)) }).catch(() => {});
    }
  }
  const SELECTION_MENU='wt-add-selection';
  async function manualQueue(){
    const {wt_manual_queue=[]}=await chrome.storage.local.get('wt_manual_queue');
    return wt_manual_queue.filter(row=>{const site=view().sites[row.siteId];return site && !site.deleted && site.generation===row.generation;});
  }
  async function removeQueued(ids){
    if(!ids.length)return;
    const {wt_manual_queue=[]}=await chrome.storage.local.get('wt_manual_queue'),removed=new Set(ids);
    await chrome.storage.local.set({wt_manual_queue:wt_manual_queue.filter(row=>!removed.has(row.id))});
  }
  async function selectionMenu(info,tab){
    await ready;
    await dictionaryReady;
    C.assert(!dictionaryRuntime||dictionaryRuntime.active(),'本机词库初始化尚未完成，请稍后加入待翻译');
    C.assert((await chrome.storage.sync.get('enable_extension')).enable_extension!==false,'请先开启插件');
    C.assert(!info.editable,'输入区域不能加入待翻译');
    C.assert(!info.frameId,'暂不支持 iframe 内的选区，请在主页面选择文字');
    const live=await chrome.tabs.get(tab.id),u=new URL(live.url);
    C.assert(['https:','http:'].includes(u.protocol),'只支持普通 HTTP/HTTPS 网页');
    await chrome.scripting.executeScript({target:{tabId:tab.id},files:['managed/core.js','managed/text-provenance.js','managed/content.js']});
    const response=await chrome.tabs.sendMessage(tab.id,{type:'wt:selection',selectionText:info.selectionText},{frameId:0});
    C.assert(response?.ok,response?.error || '无法读取选区，请刷新网页后重试');
    const scan=response.result;
    C.assert(scan?.origin===u.origin && scan.path===u.pathname && Array.isArray(scan.items) && scan.items.length>0 && scan.items.length<=500,'选区页面已改变，请重新选择');
    const added=await locked(async()=>{
      let site=siteFor(u.href);
      if(!site || site.deleted){append(u.origin,(site?.generation || 0)+1,'create',{origin:u.origin,name:u.hostname,group:group(u.origin),builtinId:site?.builtinId || null});await save();site=siteFor(u.href);}
      C.assert(site.enabled && !site.excludedPaths.some(p=>scan.path.startsWith(p)),'此网站已停用或当前页面已排除');
      const targetLanguage=(await preferences()).targetLanguage,rows=await manualQueue();let count=0;
      for(const item of scan.items){
        C.assert(item.path===scan.path,'选区路径无效');
        const entry=C.validEntry({sourceText:item.sourceText,context:item.context,path:item.path,targetLanguage,sourceLanguage:null,origin:'ai',category:'uncertain',action:'skip',translation:null,userSelected:true});
        if(rows.some(row=>row.siteId===site.id && C.entryKey(row)===C.entryKey(entry)))continue;
        rows.push({id:crypto.randomUUID(),siteId:site.id,generation:site.generation,sourceText:entry.sourceText,context:entry.context,path:entry.path,targetLanguage,userSelected:true,createdAt:Date.now()});count++;
      }
      C.assert(rows.length<=3000 && rows.reduce((n,row)=>n+row.sourceText.length,0)<=400000,'待翻译队列已达上限，请先更新或移除部分条目');
      await save();await chrome.storage.local.set({wt_manual_queue:rows});return count;
    });
    await broadcast();
    return `已加入 ${added} 项待翻译，点击插件“添加 / 更新”后处理。重复待办自动合并，已有译文也会重新翻译。${scan.blocked?'选区中的受保护内容已排除。':''}`;
  }
  if(chrome.contextMenus){
    chrome.contextMenus.onClicked.addListener((info,tab)=>{
      if(info.menuItemId!==SELECTION_MENU || !tab?.id)return;
      const notify=async message=>{await chrome.storage.local.set({wt_selection_status:{message,siteId:tab.url?new URL(tab.url).origin:null,at:Date.now()}});await chrome.tabs.sendMessage(tab.id,{type:'wt:selection-notice',message},{frameId:0}).catch(()=>{});};
      return selectionMenu(info,tab).then(notify,error=>notify(error.message)).catch(()=>{});
    });
    ready.then(async()=>{await chrome.contextMenus.remove(SELECTION_MENU).catch(()=>{});await chrome.contextMenus.create({id:SELECTION_MENU,title:'加入待翻译（网站翻译插件）',contexts:['selection'],documentUrlPatterns:['http://*/*','https://*/*']});}).catch(()=>{});
  }
  async function taskSet(task) {
    await locked(async () => {
      const { wt_tasks = {},wt_task_inputs={} } = await chrome.storage.local.get(['wt_tasks','wt_task_inputs']);
      wt_tasks[task.id] = { ...task, updatedAt: Date.now() };
      const recent = Object.fromEntries(Object.entries(wt_tasks).sort((a,b) => b[1].updatedAt-a[1].updatedAt).filter(([id],index)=>index<30 || wt_task_inputs[id]?.items?.length));
      await chrome.storage.local.set({ wt_tasks: recent });
    });
  }
  async function fetchData(url,headers,body,timeoutMs=B.limits.timeoutMs) {
    let response;
    const signal=AbortSignal.timeout(timeoutMs);
    try {response=await fetch(url,{method:'POST',redirect:'error',signal,headers,body:JSON.stringify(body)});}
    catch(error){throw B.error(error.name==='TimeoutError'?`翻译请求超时（单次上限 ${timeoutMs/60000} 分钟）`:'翻译网络连接失败','retry');}
    if(!response.ok){
      const code=response.status;let kind=code===413?'split':[408,429,500,502,503,504].includes(code)?'retry':'fatal';
      if([400,422].includes(code)){const data=await response.json().catch(()=>({}));if(/context|token.*limit|too.long|length|maximum.*(input|output)/i.test(JSON.stringify(data.error || {}).slice(0,2000)))kind='split';}
      const after=response.headers?.get('retry-after'),retryAfterMs=after?(Number.isFinite(Number(after))?Number(after)*1000:Math.max(0,Date.parse(after)-Date.now())):0;
      throw B.error('翻译请求失败（HTTP '+code+'）',kind,{status:code,retryAfterMs:Math.min(60000,retryAfterMs || 0)});
    }
    const reader=response.body.getReader();let size=0,chunks='';const decoder=new TextDecoder();
    try {while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>B.limits.maxEnvelopeBytes){await reader.cancel();throw B.error('API 响应超过大小限制','split');}chunks+=decoder.decode(value,{stream:true});}}
    catch(error){if(error.kind)throw error;throw B.error(signal.reason?.name==='TimeoutError'?`翻译响应读取超时（单次上限 ${timeoutMs/60000} 分钟）`:'翻译响应连接中断','retry');}
    try{return JSON.parse(chunks+decoder.decode());}catch{throw B.error('翻译响应 JSON 不完整','split');}
  }
  async function translate(inputs,targetLanguage,glossary,configuration) {
    const config=configuration || await chrome.storage.local.get(['wt_ai','wt_prompt']);
    const request=fn=>requestSlot(async()=>{await config.ensureActive?.();return fn();});
    const a=config.wt_ai || {},wt_prompt=config.wt_prompt,provider=P.catalog[a.provider];
    const inputContextK=B.inputContextK(config.inputContextK ?? (await preferences()).inputContextK);
    const timeoutMinutes=B.timeoutMinutes(config.timeoutMinutes ?? (await preferences()).requestTimeoutMinutes),timeoutMs=timeoutMinutes*60000;
    C.assert(provider,'请先配置翻译服务');
    const payload={targetLanguage,inputs:inputs.map(({id,sourceText,context,path,userSelected})=>({id,sourceText,context,path,...(userSelected?{userSelected:true}:{})})),glossary};
    if(provider.kind!=='mt' || provider.model)C.assert(a.model,'请先填写模型');
    if(a.provider==='chatgpt')return request(()=>native({action:'translate',model:a.model,payload,prompt:wt_prompt,reasoningEffort:a.reasoningEffort || 'auto',timeoutMinutes,inputContextK}));
    C.assert(a.apiKey,'请先设置 API Key');
    const url=new URL(P.normalizeEndpoint(a.provider,a.endpoint));
    C.assert(url.protocol==='https:' || (url.protocol==='http:' && ['localhost','127.0.0.1'].includes(url.hostname)),'API 地址需要 HTTPS 或本机 HTTP');
    C.assert(!url.username && !url.password && !url.search && !url.hash,'API 地址不能包含凭据、查询或片段');
    if(provider.kind==='mt') {
      const safe=inputs.filter(item=>item.userSelected===true || P.isUI(item)),translated=new Map();
      if(safe.length){const outgoing=P.machineRequest({...a,endpoint:url.href},safe,targetLanguage);
        const result=P.machineResult(a.provider,await request(()=>fetchData(outgoing.url,outgoing.headers,outgoing.body,timeoutMs)));
        if(!Array.isArray(result) || result.length!==safe.length || !result.every(v=>typeof v==='string' && v.length))throw B.error('翻译服务返回数量或文本无效','split');
        safe.forEach((item,n)=>translated.set(item.id,result[n]));
      }
      return JSON.stringify(inputs.map(item=>translated.has(item.id)?{id:item.id,category:'ui',action:'translate',translation:translated.get(item.id),reason:''}:{id:item.id,category:'uncertain',action:'skip',translation:null,reason:'机器翻译仅处理明确的界面控件'}));
    }
    const body={model:a.model,messages:[{role:'system',content:C.buildPrompt(wt_prompt)},{role:'user',content:JSON.stringify(payload)}],stream:false};
    if(a.provider==='qwen')body.enable_thinking=false;
    if(['deepseek','kimi','zhipu'].includes(a.provider))body.thinking={type:'disabled'};
    if(a.provider==='minimax')body.reasoning_split=true;
    if(a.provider==='zhipu')body.do_sample=false;
    const data=await request(()=>fetchData(url,{'Content-Type':'application/json',Authorization:'Bearer '+a.apiKey},body,timeoutMs));
    if(data.choices?.[0]?.finish_reason==='length')throw B.error('模型输出被截断','split');
    return data.choices?.[0]?.message?.content;
  }
  async function activeTask(task) {
    if(dictionaryRuntime&&!dictionaryRuntime.active())throw B.error('本机词库尚未就绪，任务已暂停','cancel');
    const site=view().sites[task.siteId];
    if(!site || site.deleted || !site.enabled || site.generation!==task.generation || (await preferences()).targetLanguage!==task.targetLanguage || (await chrome.storage.sync.get('enable_extension')).enable_extension===false)throw B.error('网站或目标语言状态已改变，任务已停止','cancel');
    return dictionaryRuntime?await dictionaryRuntime.enrich(site):site;
  }
  async function storePending(task,items,truncated) {
    const {wt_task_inputs={}}=await chrome.storage.local.get('wt_task_inputs');
    if(items.length)wt_task_inputs[task.id]={origin:task.siteId,items,truncated:!!truncated};else delete wt_task_inputs[task.id];
    await chrome.storage.local.set({wt_task_inputs});
  }
  let broadcastScheduled=false;
  function scheduleBroadcast(){if(broadcastScheduled)return;broadcastScheduled=true;setTimeout(()=>{broadcastScheduled=false;broadcast().catch(()=>{});},100);}
  async function runTask(task, tabId, captured) {
    let heartbeat;
    try {
      // Keep the service worker alive while an explicitly requested batch is in flight.
      heartbeat = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20000);
      if(!captured) await chrome.scripting.executeScript({ target: { tabId }, files: ['managed/core.js','managed/text-provenance.js','managed/content.js'] });
      const scanPreferences=await preferences();
      const scan = captured || await chrome.tabs.sendMessage(tabId, { type: 'wt:collect',expand:true,site:{...(await activeTask(task)),targetLanguage:task.targetLanguage},captureLimits:C.captureLimits(scanPreferences),autoExpandSeconds:scanPreferences.autoExpandSeconds });
      C.assert(!scan?.error,scan?.error || '页面扫描失败');
      C.assert(scan?.origin === task.siteId, '页面已跳转，请重试');
      const site = await activeTask(task);
      const queued=(await manualQueue()).filter(row=>row.siteId===task.siteId && row.generation===task.generation && row.targetLanguage===task.targetLanguage && !site.excludedPaths.some(p=>row.path.startsWith(p)) && (!task.retryOnly || scan.items.some(item=>item.queueId===row.id)));
      const selected=queued.map(({id,sourceText,context,path})=>({id,queueId:id,sourceText,context,path,userSelected:true}));
      const selectedKeys=new Set(selected.map(item=>C.entryKey({...item,targetLanguage:task.targetLanguage})));
      // Snapshot the selected queue first; later additions wait for the next explicit update.
      const scanItems=[...selected,...scan.items.filter(item=>!item.queueId && !selectedKeys.has(C.entryKey({...item,targetLanguage:task.targetLanguage})) && !site.excludedPaths.some(p=>item.path.startsWith(p)))];
      const missingGroups=new Map();
      const reuse=C.reuseIndex(site.entries);
      let reused=0;
      for(const item of scanItems) {
        const target={...item,targetLanguage:task.targetLanguage};
        const cached=site.entries[C.entryKey(target)] || C.reusableEntry(site.entries,target,reuse);
        if(cached && !item.userSelected){reused++;continue;}
        const key=!item.userSelected && C.sharedUI(item)?C.reuseKey(target):C.entryKey(target);
        if(!missingGroups.has(key))missingGroups.set(key,[]);missingGroups.get(key).push(item);
      }
      const occurrences=[...missingGroups.values()],missing=occurrences.map((items,i)=>({...items[0],id:`t${i}`}));
      task.total = missing.length; task.scanned = scanItems.length; task.reused=reused+(scan.reused || 0);task.deduplicated=scanItems.length-reused-missing.length;task.truncated = scan.truncated;
      task.inputContextK=B.inputContextK(task.inputContextK ?? (await preferences()).inputContextK);
      task.requestTimeoutMinutes=B.timeoutMinutes(task.requestTimeoutMinutes ?? (await preferences()).requestTimeoutMinutes);
      await taskSet(task);
      const glossary = Object.values(site.entries).filter(e => e.targetLanguage === task.targetLanguage && e.origin === 'manual' && e.action === 'translate').slice(0,50).map(e => ({ sourceText: e.sourceText, translation: e.translation }));
      const configuration=await chrome.storage.local.get(['wt_ai','wt_prompt']);
      configuration.timeoutMinutes=task.requestTimeoutMinutes;configuration.inputContextK=task.inputContextK;
      configuration.ensureActive=()=>activeTask(task);
      const provider=configuration.wt_ai?.provider;
      await locked(()=>storePending(task,occurrences.flat(),scan.truncated));
      const planOptions={contextTokens:task.inputContextK*1000,provider,targetLanguage:task.targetLanguage,glossary,prompt:C.buildPrompt(configuration.wt_prompt)};
      const batches=[...B.plan(missing.filter(item=>item.userSelected),planOptions),...B.plan(missing.filter(item=>!item.userSelected),planOptions)];
      const groups=new Map(missing.map((item,i)=>[item.id,occurrences[i]])),pending=new Map(groups);
      task.batchTotal=batches.length;task.batchCompleted=0;task.retries=0;task.splits=0;task.failed=0;task.contextBudget=task.inputContextK*1000;task.concurrency=B.limits.concurrency;
      await locked(()=>storePending(task,[...pending.values()].flat(),scan.truncated));await taskSet(task);
      let next=0,stopped=null;const failures=[];
      const recordFailure=error=>{failures.push(error.message);if(['fatal','cancel'].includes(error.kind) || !error.kind)stopped=error;};
      async function processBatch(batch,depth=0){
        for(let attempt=0;;attempt++){
          if(stopped)return;
          await activeTask(task);
          let result;
          try{
            const raw=await translate(batch,task.targetLanguage,glossary,configuration);
            try{if(typeof raw!=='string' || B.bytes(raw)>B.limits.maxReplyBytes)throw new Error('AI 响应过大或为空');result=C.validateResult(raw,batch,task.targetLanguage);}
            catch(error){throw B.error(error.message,'split');}
          }catch(error){
            if((error.kind==='retry' || (error.kind==='split' && (batch.length===1 || depth>=8))) && attempt<B.limits.retries){
              task.retries++;await taskSet(task);await new Promise(r=>setTimeout(r,Math.max(error.retryAfterMs || 0,500*2**attempt+Math.floor(Math.random()*200))));continue;
            }
            if(error.kind==='split' && batch.length>1 && depth<8){
              if(task.splits>=B.limits.maxSplits)throw B.error('自动拆分已达上限，请检查模型或提示词后重试剩余内容','fatal');
              task.splits++;task.batchTotal++;task.retries++;await taskSet(task);for(const part of B.split(batch)){try{await processBatch(part,depth+1);}catch(e){recordFailure(e);}}return;
            }
            throw error;
          }
          await locked(async()=>{
            await activeTask(task);
            let deps=heads();
            const sources=new Map(batch.map(i=>[C.entryKey({...i,targetLanguage:task.targetLanguage}),i]));
            for(const entry of result){
              if(entry.userSelected && entry.action!=='translate'){failures.push('翻译服务未翻译手动指定内容，已保留在待翻译队列');continue;}
              if(P.catalog[provider]?.kind==='mt' && entry.category==='uncertain')continue;
              const source=sources.get(C.entryKey(entry));
              for(const item of groups.get(source.id)){const op=append(task.siteId,task.generation,'entry',{...entry,path:item.path},deps);deps=[op.opId];}
            }
            await save();
            const completedKeys=new Set(result.filter(entry=>!entry.userSelected || entry.action==='translate').map(C.entryKey));
            const done=batch.filter(item=>completedKeys.has(C.entryKey({...item,targetLanguage:task.targetLanguage})));
            for(const item of done)pending.delete(item.id);
            await removeQueued(done.flatMap(item=>groups.get(item.id).map(row=>row.queueId).filter(Boolean)));
            await storePending(task,[...pending.values()].flat(),scan.truncated);
          });
          task.completed+=result.filter(r=>!r.userSelected || r.action==='translate').length;task.translated+=result.filter(r=>r.action==='translate').length;task.batchCompleted++;
          await taskSet(task);scheduleBroadcast();return;
        }
      }
      await Promise.all(Array.from({length:Math.min(B.limits.concurrency,batches.length)},async()=>{
        while(!stopped && next<batches.length){const batch=batches[next++];try{await processBatch(batch);}catch(error){recordFailure(error);}}
      }));
      task.failed=missing.length-task.completed;
      if(task.failed){task.status=task.completed?'partial':'failed';task.message=(failures[0] || '部分批次未完成')+'；已保存的结果保留，可在翻译记录中重试剩余内容。';}
      else {task.status='completed';task.message=captured?'采集内容处理完成。':'当前页面处理完成。';if(scan.exploration?.limited)task.message+=' 本轮展开检查已达到上限，再次添加 / 更新将继续检查剩余入口。';}
      await broadcast();

    } catch (e) { task.status = task.completed ? 'partial' : 'failed'; task.message = e.message; }
    finally { clearInterval(heartbeat); await taskSet(task); }
  }
  async function preferences() { const {wt_preferences={}}=await chrome.storage.local.get('wt_preferences');return {inputContextK:B.inputContextK(wt_preferences.inputContextK),...C.captureLimits(wt_preferences),autoExpandSeconds:C.autoExpandSeconds(wt_preferences.autoExpandSeconds),targetLanguage:wt_preferences.targetLanguage || 'zh-Hans',requestTimeoutMinutes:B.timeoutMinutes(wt_preferences.requestTimeoutMinutes)}; }
  async function startCapture(tabId) {
    C.assert((await chrome.storage.sync.get('enable_extension')).enable_extension!==false,'请先开启插件');
    const tab=await chrome.tabs.get(tabId),u=new URL(tab.url);
    C.assert(['http:','https:'].includes(u.protocol),'只支持 HTTP/HTTPS 网页');
    const domain=group(u.origin),host=tldts.getDomain(u.hostname,{allowPrivateDomains:true});
    const matches=host?[`https://*.${host}/*`,`http://*.${host}/*`]:[`${u.protocol}//${u.hostname}/*`];
    for(const match of matches) C.assert(await chrome.permissions.contains({origins:[match]}),'请授予采集域名权限');
    let captureId;
    await locked(async()=>{
      const {wt_capture}=await chrome.storage.local.get('wt_capture');
      C.assert(!wt_capture || wt_capture.status!=='collecting','请先完成或取消当前采集');
      let site=siteFor(u.href);
      if(!site || site.deleted){append(u.origin,(site?.generation || 0)+1,'create',{origin:u.origin,name:u.hostname,group:domain,builtinId:site?.builtinId || null});await save();site=siteFor(u.href);}
      C.assert(site.enabled,'请先启用此网站');
      captureId=crypto.randomUUID();
      await chrome.storage.local.set({wt_capture:{id:captureId,status:'collecting',group:domain,matches,tabIds:[tabId],pages:[],items:[],truncated:false,startedAt:Date.now()}});
    });
    // Confirm the initial page was persisted instead of only showing a started session.
    try {
      await registrations();
      await chrome.scripting.executeScript({target:{tabId},files:['managed/core.js','managed/text-provenance.js','managed/content.js']});
      await broadcast();
      const scan=await chrome.tabs.sendMessage(tabId,{type:'wt:collect'});
      const liveTab=await chrome.tabs.get(tabId);
      await locked(()=>captureData({captureId,scan},{tab:liveTab,url:liveTab.url,frameId:0}));
    }catch(error){await locked(()=>captureError(captureId,tabId,error.message));throw error;}
    return true;
  }
  async function captureData(message,sender) {
    const {wt_capture:c}=await chrome.storage.local.get('wt_capture');
    if(!c || c.status!=='collecting' || message.captureId!==c.id)return false;
    const u=new URL(sender.url),scan=message.scan;
    C.assert((sender.frameId===undefined || sender.frameId===0) && c.tabIds.includes(sender.tab.id) && group(u.origin)===c.group && scan?.origin===u.origin,'采集页面范围不符');
    // sender.url is the document's original URL on SPA history navigation. The isolated
    // collector's snapshot owns its path; do not compare it with that stale document path.
    const capturedPath=scan.path ?? new URL(sender.tab.url || sender.url).pathname;
    C.assert(typeof capturedPath==='string' && capturedPath.startsWith('/') && !capturedPath.startsWith('//') && capturedPath.length<=2048 && !/[?#\r\n]/.test(capturedPath),'采集路径无效');
    C.assert(Array.isArray(scan.items) && scan.items.length<=C.captureMaximums.pageCaptureItems,'采集数量无效');
    const site=siteFor(u.href);
    if(site?.deleted || site?.enabled===false || site?.excludedPaths.some(p=>capturedPath.startsWith(p)))return false;
    if((await chrome.storage.sync.get('enable_extension')).enable_extension===false)return false;
    const prefs=await preferences(),limits=C.captureLimits(prefs),targetLanguage=prefs.targetLanguage;
    const keyOf=i=>C.canonical([i.origin,C.sharedUI(i)?null:i.path,i.context,i.sourceText]);
    const known=i=>{const entries=view().sites[i.origin]?.entries || {},target={...i,targetLanguage};return entries[C.entryKey(target)] || C.reusableEntry(entries,target);};
    c.items=c.items.filter(i=>!known(i));
    const keys=new Map(c.items.map(i=>[keyOf(i),i]));
    let size=c.items.reduce((n,i)=>n+i.sourceText.length,0);
    for(const item of scan.items) {
      C.assert(item && typeof item.sourceText==='string' && item.sourceText.length>0 && item.sourceText.length<=4096 && typeof item.context==='string' && item.context.length<=256 && item.path===capturedPath,'采集条目无效');
      const candidate={origin:u.origin,path:item.path,context:item.context,sourceText:item.sourceText};if(known(candidate))continue;
      const key=keyOf(candidate),existing=keys.get(key);
      if(existing){if(existing.path!==item.path && !(existing.paths || []).includes(item.path)){if(c.items.reduce((n,i)=>n+(i.paths?.length || 0),0)>=20000){c.truncated=true;continue;}(existing.paths ||= []).push(item.path);}continue;}
      if(c.items.length>=limits.sessionCaptureItems || size+item.sourceText.length>limits.sessionCaptureChars){c.truncated=true;break;}
      c.items.push(candidate);keys.set(key,candidate);size+=item.sourceText.length;
    }
    const page=u.origin+capturedPath;if(!c.pages.includes(page) && c.pages.length<500)c.pages.push(page);
    c.truncated ||= !!scan.truncated;
    c.lastError=null;c.lastCollectedAt=Date.now();
    await chrome.storage.local.set({wt_capture:c});return true;
  }
  async function captureError(captureId,tabId,error) {
    const {wt_capture:c}=await chrome.storage.local.get('wt_capture');
    if(c?.id!==captureId || c.status!=='collecting' || !c.tabIds.includes(tabId))return;
    c.lastError=String(error).slice(0,300);await chrome.storage.local.set({wt_capture:c});
  }
  async function finishCapture() {
    const {wt_capture:initial}=await chrome.storage.local.get('wt_capture');
    C.assert(initial?.status==='collecting','没有正在进行的采集');
    // Flush live pages before sealing the session; closed pages remain in the local draft.
    for(const tabId of initial.tabIds) {
      const tab=await chrome.tabs.get(tabId).catch(()=>null);if(!tab || !/^https?:/.test(tab.url || '') || group(tab.url)!==initial.group)continue;
      const scan=await chrome.tabs.sendMessage(tabId,{type:'wt:collect'}).catch(()=>null);
      if(scan)await locked(()=>captureData({captureId:initial.id,scan},{tab,url:tab.url}));
    }
    const jobs=await locked(async()=>{
      C.assert((await chrome.storage.sync.get('enable_extension')).enable_extension!==false,'请先开启插件');
      const {wt_capture:c,wt_tasks={},wt_task_inputs={}}=await chrome.storage.local.get(['wt_capture','wt_tasks','wt_task_inputs']);
      C.assert(c?.id===initial.id && c.status==='collecting','采集状态已变化');
      const targetLanguage=(await preferences()).targetLanguage;
      const queuedOrigins=(await manualQueue()).filter(row=>row.targetLanguage===targetLanguage && c.pages.some(page=>new URL(page).origin===row.siteId)).map(row=>row.siteId);
      const origins=[...new Set([...c.items.map(i=>i.origin),...queuedOrigins])];C.assert(origins.length,'尚未采集到可翻译内容');
      C.assert(!Object.values(wt_tasks).some(t=>origins.includes(t.siteId) && t.status==='running'),'采集的网站已有任务，请稍后完成');
      const jobs=[];
      for(const origin of origins) {
        let site=siteFor(origin);
        if(site && (site.deleted || !site.enabled))continue;
        if(!site){append(origin,1,'create',{origin,name:new URL(origin).hostname,group:group(origin),builtinId:null});site=siteFor(origin);}
        const task={id:crypto.randomUUID(),siteId:origin,generation:site.generation,targetLanguage,status:'running',total:0,completed:0,translated:0,updatedAt:Date.now()};
        wt_tasks[task.id]=task;
        jobs.push({task,scan:{origin,items:c.items.filter(i=>i.origin===origin).flatMap(i=>[i.path,...(i.paths || [])].map(path=>({...i,path}))).filter(i=>!site.excludedPaths.some(p=>i.path.startsWith(p))).map((i,n)=>({id:`t${n}`,sourceText:i.sourceText,context:i.context,path:i.path})),truncated:c.truncated}});
      }
      C.assert(jobs.length,'采集的网站已停用或删除');await save();
      for(const job of jobs)wt_task_inputs[job.task.id]=job.scan;
      await chrome.storage.local.set({wt_tasks,wt_task_inputs,wt_capture:{...c,status:'submitted',items:[],submittedAt:Date.now()}});return jobs;
    });
    await registrations();await broadcast();
    Promise.all(jobs.map(job=>runTask(job.task,null,job.scan))).catch(()=>{});
    return {tasks:jobs.length};
  }

  chrome.permissions.onAdded.addListener(() => ready.then(registrations));
  chrome.permissions.onRemoved.addListener(() => ready.then(registrations));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if (changes.enable_extension) ready.then(broadcast);
    const keys = Object.keys(changes).filter(k => k.startsWith('site_enabled_'));
    if (keys.length) ready.then(() => locked(async () => {
      for (const key of keys) for (const s of Object.values(view().sites)) if (!s.deleted && s.builtinId === key.slice(13)) append(s.id,s.generation,'setting',{key:'enabled',value:changes[key].newValue !== false});
      await save(); await broadcast();
    })).catch(()=>{});
  });
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (!message?.type?.startsWith('wt:') || message.type === 'wt:apply' || message.type === 'wt:collect') return false;
    (async () => {
      await ready;
      const trustedUI = sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL(''));
      if (!trustedUI && sender.tab) {
        C.assert(['wt:page','wt:capture-data','wt:dictionary'].includes(message.type), '页面没有此操作权限');
        if(message.type==='wt:dictionary')return dictionaryRuntime?.adapter(sender.url);
        if(message.type==='wt:page') return pageState(sender.url,sender.tab.id);
        return locked(async()=>{try{return await captureData(message,sender);}catch(error){await captureError(message.captureId,sender.tab.id,error.message);throw error;}});
      }
      C.assert(trustedUI, '仅允许扩展界面操作');
      if(!['wt:state','wt:popup-state','wt:dictionary-action'].includes(message.type))await dictionaryReady;
      if(['wt:install','wt:start','wt:capture-start','wt:capture-finish','wt:retry-task','wt:change','wt:group-change'].includes(message.type))C.assert(!dictionaryRuntime||dictionaryRuntime.active(),'本机词库初始化尚未完成，请在设置查看进度');
      if(message.type==='wt:install'){
        await installOrigins([message.origin]);return '已添加，缺失词库将在后台下载；网站权限需单独授予';
      }
      if(message.type==='wt:dictionary-action'){await dictionaryReady;C.assert(dictionaryRuntime,'词库服务不可用');return dictionaryRuntime.handle(message);}
      if(message.type==='wt:popup-state'){
        const origin=message.origin==null?null:new URL(message.origin).origin;
        C.assert(origin===null || origin===message.origin && /^https?:/.test(origin),'当前网页网址无效');
        const {wt_tasks={},wt_capture,wt_selection_status}=await chrome.storage.local.get(['wt_tasks','wt_capture','wt_selection_status']);
        const targetLanguage=(await preferences()).targetLanguage,site=origin?view().sites[origin]:null;
        const task=Object.values(wt_tasks).filter(t=>t.siteId===origin).sort((a,b)=>b.updatedAt-a.updatedAt)[0];
        return {sites:site?{[origin]:{id:site.id,origin:site.origin,group:site.group,generation:site.generation,enabled:site.enabled,deleted:site.deleted}}:{},
          wt_preferences:{targetLanguage},wt_tasks:task?{[task.id]:task}:{},manualPending:(await manualQueue()).filter(row=>row.siteId===origin&&row.targetLanguage===targetLanguage).length,
          wt_capture:wt_capture?{status:wt_capture.status,group:wt_capture.group,pageCount:wt_capture.pages?.length || 0,itemCount:wt_capture.items?.length || 0,lastError:wt_capture.lastError,truncated:wt_capture.truncated}:null,
          wt_selection_status:wt_selection_status?.siteId===origin?wt_selection_status:null,
          dictionary:dictionaryRuntime?await dictionaryRuntime.summary({origin,compact:true}):null,globalEnabled:(await chrome.storage.sync.get('enable_extension')).enable_extension!==false};
      }
      if (message.type === 'wt:state') {
        const state = structuredClone(view());
        const local = await chrome.storage.local.get(['wt_tasks','wt_ai','wt_preferences','wt_capture','wt_ai_profiles','wt_prompt','wt_subscription_models','wt_selection_status']);
        local.wt_preferences=await preferences();local.wt_manual_queue=await manualQueue();
        await Promise.all(Object.values(state.sites).map(async site=>{site.authorized=await chrome.permissions.contains({origins:[`${new URL(site.origin).protocol}//${new URL(site.origin).hostname}/*`]});}));
        const {wt_task_inputs={}}=await chrome.storage.local.get('wt_task_inputs');for(const task of Object.values(local.wt_tasks || {}))task.canRetry=!!wt_task_inputs[task.id]?.items?.length && ['failed','partial','interrupted'].includes(task.status);
        if(dictionaryRuntime)state.sites=await dictionaryRuntime.enrichMany(state.sites);
        return { dictionary:dictionaryRuntime?await dictionaryRuntime.summary():null, ...state, ...local, defaultPrompt:C.translationPrompt, globalEnabled:(await chrome.storage.sync.get('enable_extension')).enable_extension !== false };
      }
      if(message.type==='wt:manual-remove'){
        await locked(async()=>{const row=(await manualQueue()).find(row=>row.id===message.id);C.assert(row,'待翻译项不存在');
          const {wt_tasks={}}=await chrome.storage.local.get('wt_tasks');C.assert(!Object.values(wt_tasks).some(task=>task.siteId===row.siteId && task.status==='running'),'此网站正在翻译，请在任务结束后移除');
          await removeQueued([row.id]);const {wt_task_inputs={}}=await chrome.storage.local.get('wt_task_inputs');
          for(const [id,scan] of Object.entries(wt_task_inputs)){scan.items=scan.items.filter(item=>item.queueId!==row.id);if(!scan.items.length)delete wt_task_inputs[id];}
          await chrome.storage.local.set({wt_task_inputs});});return true;
      }
      if(message.type==='wt:retry-task'){
        let task,scan;
        await locked(async()=>{const {wt_tasks={},wt_task_inputs={}}=await chrome.storage.local.get(['wt_tasks','wt_task_inputs']);const old=wt_tasks[message.taskId];
          C.assert(old && ['failed','partial','interrupted'].includes(old.status) && wt_task_inputs[old.id]?.items.length,'没有可重试的剩余内容');await activeTask(old);
          C.assert(!Object.values(wt_tasks).some(t=>t.siteId===old.siteId && t.status==='running'),'此网站已有进行中的任务');
          scan=wt_task_inputs[old.id];task={...old,retryOnly:true,inputContextK:(await preferences()).inputContextK,requestTimeoutMinutes:(await preferences()).requestTimeoutMinutes,status:'running',completed:0,translated:0,total:0,failed:0,message:'正在重试未完成内容',canRetry:false};wt_tasks[task.id]=task;await chrome.storage.local.set({wt_tasks});});
        runTask(task,null,scan);return task;
      }
      if(message.type==='wt:capture-start')return startCapture(message.tabId);
      if(message.type==='wt:capture-finish')return finishCapture();
      if(message.type==='wt:capture-cancel'){await locked(()=>chrome.storage.local.remove('wt_capture'));await registrations();await broadcast();return true;}
      if(message.type==='wt:group-change') {
        C.assert(['enabled','delete'].includes(message.action),'分组操作无效');
        await locked(async()=>{for(const s of Object.values(view().sites))if(!s.deleted && s.group===message.group)append(s.id,s.generation,message.action==='delete'?'delete':'setting',message.action==='delete'?{}:{key:'enabled',value:!!message.enabled});await save();});
        await registrations();await broadcast();return true;
      }
      if (message.type === 'wt:start') {
        C.assert((await chrome.storage.sync.get('enable_extension')).enable_extension!==false,'请先开启插件');
        const tab = await chrome.tabs.get(message.tabId), u = new URL(tab.url);
        C.assert(['http:', 'https:'].includes(u.protocol), '只支持 HTTP/HTTPS 网页');
        let site;
        await locked(async () => {
          site = siteFor(tab.url);
          if (!site || site.deleted) { append(u.origin, (site?.generation || 0)+1, 'create', { origin: u.origin, name: u.hostname, group: group(u.origin), builtinId: site?.builtinId || null }); await save(); site = siteFor(tab.url); }
          C.assert(site.enabled, '请先启用此网站');
          const { wt_tasks = {} } = await chrome.storage.local.get('wt_tasks');
          C.assert(!Object.values(wt_tasks).some(t => t.siteId === site.id && t.status === 'running'), '此网站已有任务');
          const task = { id: crypto.randomUUID(), siteId: site.id, generation: site.generation, targetLanguage: (await preferences()).targetLanguage, status: 'running', total: 0, completed: 0, translated: 0, updatedAt: Date.now() };
          wt_tasks[task.id] = task; await chrome.storage.local.set({ wt_tasks }); site = { ...site, task };
        });
        await registrations(); runTask(site.task, tab.id); return site.task;
      }
      if (message.type === 'wt:change') {
        await locked(async () => {
          const site = view().sites[message.siteId]; C.assert(site && !site.deleted, '网站不存在');
          append(site.id, site.generation, message.kind, message.payload); await save();
        });
        await registrations(); await broadcast(); return true;
      }
      if (message.type === 'wt:config') {
        C.assert(!message.sync,'文件夹同步已退出，请在网站管理上传词库');
        if (message.ai) {
          const a=message.ai;C.assert(P.catalog[a.provider] && typeof a.model==='string' && a.model.length<=200,'AI 设置无效');
          C.assert(['auto','none','minimal','low','medium','high','xhigh','max'].includes(a.reasoningEffort || 'auto'),'思考强度无效');
          const config={provider:a.provider,model:a.model,endpoint:a.provider==='chatgpt'?'':P.normalizeEndpoint(a.provider,a.endpoint),apiKey:a.provider==='chatgpt'?'':String(a.apiKey || ''),region:String(a.region || ''),reasoningEffort:a.reasoningEffort || 'auto'};
          await locked(async()=>{const {wt_ai_profiles={}}=await chrome.storage.local.get('wt_ai_profiles');await chrome.storage.local.set({wt_ai:config,wt_ai_profiles:{...wt_ai_profiles,[config.provider]:config}});});
        }
        if(message.prompt!==undefined)await chrome.storage.local.set({wt_prompt:C.validatePrompt(message.prompt)});
        if(message.preferences) {
          await locked(async()=>{const old=await preferences();const targetLanguage=C.language(message.preferences.targetLanguage ?? old.targetLanguage),requestTimeoutMinutes=B.timeoutMinutes(message.preferences.requestTimeoutMinutes ?? old.requestTimeoutMinutes);const inputContextK=B.inputContextK(message.preferences.inputContextK ?? old.inputContextK),captureLimits=C.captureLimits({...old,...message.preferences}),autoExpandSeconds=C.autoExpandSeconds(message.preferences.autoExpandSeconds===undefined?old.autoExpandSeconds:message.preferences.autoExpandSeconds);const {wt_capture}=await chrome.storage.local.get('wt_capture');C.assert(wt_capture?.status!=='collecting' || targetLanguage===old.targetLanguage,'请先完成或取消采集后再切换目标语言');await chrome.storage.local.set({wt_preferences:{...old,...captureLimits,targetLanguage,requestTimeoutMinutes,inputContextK,autoExpandSeconds}});});
          await broadcast();
        }
        dictionaryRuntime?.changed(); return true;
      }
      if(message.type==='wt:test'){const inputs=[{id:'test',sourceText:'Save changes',context:'form/button/text',path:'/'}];const targetLanguage=(await preferences()).targetLanguage;C.validateResult(await translate(inputs,targetLanguage,[]),inputs,targetLanguage);return true;}
      if (message.type === 'wt:sync') throw new Error('文件夹同步已退出，请在网站管理上传词库');
      if (message.type === 'wt:native') { C.assert(['status','logout','models','ping'].includes(message.action), '连接操作无效'); const result=await native({action:message.action});if(message.action==='models')await chrome.storage.local.set({wt_subscription_models:result});return result; }
      throw new Error('未知操作');
    })().then(result => reply({ ok: true, result }), e => reply({ ok: false, error: e.message }));
    return true;
  });
})();
