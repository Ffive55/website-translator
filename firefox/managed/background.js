/* GPL-3.0-or-later */
(() => {
  'use strict';
  const C = WTCore, P=WTProviders, HOST = 'local.website_translator';
  let queue = Promise.resolve(), database, committed, syncFlight = null, syncRequested = false;
  const locked = fn => { const next = queue.then(fn); queue = next.catch(() => {}); return next; };
  const view = () => C.materialize(database.ops);
  function append(siteId, generation, kind, payload) {
    const applied = new Set(view().applied);
    const deps = new Set(applied);
    database.ops.filter(o => applied.has(o.opId)).forEach(o => o.deps.forEach(d => deps.delete(d)));
    const seq = ++database.seq;
    const op = { schemaVersion: 1, deviceId: database.deviceId, seq, opId: `${database.deviceId}-${seq}`, deps: [...deps], siteId, generation, kind, payload };
    C.validateOp(op); database.ops.push(op); return op;
  }
  async function save() {
    try {
      const { wt_sync_status = {} } = await chrome.storage.local.get('wt_sync_status');
      await chrome.storage.local.set({ wt_database: database, wt_view: view(), wt_sync_status: { ...wt_sync_status, saved: true, pendingLocal: true, peerConfirmed: false } });
      committed = structuredClone(database);
    }
    catch (error) { database = structuredClone(committed); throw error; }
  }
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
    database = stored.wt_database || { schemaVersion: 1, deviceId: crypto.randomUUID(), seq: 0, ops: [] };
    committed = structuredClone(database);
    if (!stored.wt_database) {
      const old = await chrome.storage.sync.get(null);
      for (const site of SUPPORTED_SITES) for (const pattern of site.matches) {
        const origin = new URL(pattern.replace('*', '')).origin;
        if (view().sites[origin]) continue;
        append(origin, 1, 'create', { origin, builtinId: site.id, builtinVersion: chrome.runtime.getManifest().version, name: site.name, group: group(origin) });
        if (old[`site_enabled_${site.id}`] === false) append(origin, 1, 'setting', { key: 'enabled', value: false });
      }
    }
    const tasks = stored.wt_tasks || {};
    for (const task of Object.values(tasks)) if (task.status === 'running') { task.status = 'interrupted'; task.message = '后台已重启，已保存批次保留；点击更新继续。'; }
    await chrome.storage.local.set({ wt_tasks: tasks });
    await save();
    await registrations();
  });
  ready.catch(() => {});
  function group(origin) { const u = new URL(origin); return tldts.getDomain(u.hostname, { allowPrivateDomains: true }) || u.host; }
  function siteFor(url) { return view().sites[new URL(url).origin]; }
  function isGithubOrigin(url) {
    try { const origin=new URL(url).origin;return SUPPORTED_SITES.some(s=>s.id==='github' && s.matches.includes(`${origin}/*`)); } catch { return false; }
  }
  async function native(message) {
    let result;
    try { result = await chrome.runtime.sendNativeMessage(HOST, message); }
    catch (e) { throw new Error(`无法连接本地程序：${e.message}。请检查安装及浏览器注册。`); }
    if (!result?.ok) throw new Error(result?.error || '本地操作失败');
    return result.result;
  }
  async function registrations() {
    const sites = Object.values(view().sites).filter(s => !s.deleted);
    const desired = [];
    for (const s of sites) {
      const match = `${new URL(s.origin).protocol}//${new URL(s.origin).hostname}/*`;
      if (await chrome.permissions.contains({ origins: [match] })) desired.push(match);
    }
    const {wt_capture}=await chrome.storage.local.get('wt_capture');
    if(wt_capture?.status==='collecting') for(const match of wt_capture.matches) if(await chrome.permissions.contains({origins:[match]}))desired.push(match);
    const existing = await chrome.scripting.getRegisteredContentScripts();
    if (existing.some(s => s.id === 'wt-managed')) await chrome.scripting.unregisterContentScripts({ ids: ['wt-managed'] });
    if (desired.length) await chrome.scripting.registerContentScripts([{ id: 'wt-managed', matches: [...new Set(desired)], js: ['managed/core.js','managed/text-provenance.js','managed/content.js'], runAt: 'document_start', persistAcrossSessions: true }]);
  }
  async function pageState(url, tabId) {
    let site = siteFor(url);
    const {wt_preferences={},wt_capture} = await chrome.storage.local.get(['wt_preferences','wt_capture','wt_ai_profiles']);
    if(site)site={...site,targetLanguage:wt_preferences.targetLanguage || 'zh-Hans'};
    let captureId=null;
    if(wt_capture?.status==='collecting' && group(url)===wt_capture.group) {
      const tab=tabId==null?null:await chrome.tabs.get(tabId).catch(()=>null);
      if(wt_capture.tabIds.includes(tabId) || wt_capture.tabIds.includes(tab?.openerTabId)) {
        captureId=wt_capture.id;
        if(!wt_capture.tabIds.includes(tabId)) await locked(async()=>{const {wt_capture:c}=await chrome.storage.local.get('wt_capture');if(c?.id===captureId && !c.tabIds.includes(tabId)){c.tabIds.push(tabId);await chrome.storage.local.set({wt_capture:c});}});
      }
    }
    const { enable_extension = true } = await chrome.storage.sync.get('enable_extension');
    return { site, globalEnabled: enable_extension, captureId:enable_extension!==false ? captureId : null };
  }
  async function broadcast() {
    for (const tab of await chrome.tabs.query({})) {
      if (!/^https?:/.test(tab.url || '')) continue;
      chrome.tabs.sendMessage(tab.id, { type: 'wt:apply', ...(await pageState(tab.url,tab.id)) }).catch(() => {});
    }
  }
  async function taskSet(task) {
    await locked(async () => {
      const { wt_tasks = {} } = await chrome.storage.local.get('wt_tasks');
      wt_tasks[task.id] = { ...task, updatedAt: Date.now() };
      const recent = Object.fromEntries(Object.entries(wt_tasks).sort((a,b) => b[1].updatedAt-a[1].updatedAt).slice(0, 30));
      await chrome.storage.local.set({ wt_tasks: recent });
    });
  }
  async function fetchData(url,headers,body) {
    const response=await fetch(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(90000),headers,body:JSON.stringify(body)});
    C.assert(response.ok, '翻译请求失败（HTTP '+response.status+'）');
    const reader=response.body.getReader();let size=0,chunks='';const decoder=new TextDecoder();
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>300000){await reader.cancel();throw new Error('API 响应超过大小限制');}chunks+=decoder.decode(value,{stream:true});}
    return JSON.parse(chunks+decoder.decode());
  }
  async function translate(inputs, targetLanguage, glossary) {
    const {wt_ai:a={}}=await chrome.storage.local.get('wt_ai');const provider=P.catalog[a.provider];
    C.assert(provider,'请先配置翻译服务');
    const payload={targetLanguage,inputs,glossary};
    if(provider.kind!=='mt' || provider.model)C.assert(a.model,'请先填写模型');
    if(a.provider==='chatgpt')return native({action:'translate',model:a.model,payload,prompt:a.prompt,reasoningEffort:a.reasoningEffort || 'auto'});
    C.assert(a.apiKey,'请先设置 API Key');
    const url=new URL(P.normalizeEndpoint(a.provider,a.endpoint));
    C.assert(url.protocol==='https:' || (url.protocol==='http:' && ['localhost','127.0.0.1'].includes(url.hostname)),'API 地址需要 HTTPS 或本机 HTTP');
    C.assert(!url.username && !url.password && !url.search && !url.hash,'API 地址不能包含凭据、查询或片段');
    if(provider.kind==='mt') {
      const safe=inputs.filter(P.isUI),translated=new Map();
      for(let i=0;i<safe.length;i+=a.provider==='qwen_mt'?1:20){
        const batch=safe.slice(i,i+(a.provider==='qwen_mt'?1:20)),request=P.machineRequest({...a,endpoint:url.href},batch,targetLanguage);
        const result=P.machineResult(a.provider,await fetchData(request.url,request.headers,request.body));
        C.assert(Array.isArray(result) && result.length===batch.length && result.every(v=>typeof v==='string' && v.length),'翻译服务返回数量或文本无效');
        batch.forEach((item,n)=>translated.set(item.id,result[n]));
      }
      return JSON.stringify(inputs.map(item=>translated.has(item.id)?{id:item.id,category:'ui',action:'translate',translation:translated.get(item.id),reason:''}:{id:item.id,category:'uncertain',action:'skip',translation:null,reason:'机器翻译仅处理明确的界面控件'}));
    }
    const body={model:a.model,messages:[{role:'system',content:C.buildPrompt(a.prompt)},{role:'user',content:JSON.stringify(payload)}]};
    body.stream=false;
    if(a.provider==='qwen')body.enable_thinking=false;
    if(['deepseek','kimi','zhipu'].includes(a.provider))body.thinking={type:'disabled'};
    if(a.provider==='minimax')body.reasoning_split=true;
    if(a.provider==='zhipu')body.do_sample=false;
    const data=await fetchData(url,{'Content-Type':'application/json',Authorization:'Bearer '+a.apiKey},body);
    return data.choices?.[0]?.message?.content;
  }
  async function runTask(task, tabId, captured) {
    let heartbeat;
    try {
      // Keep the service worker alive while an explicitly requested batch is in flight.
      heartbeat = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20000);
      if(!captured) await chrome.scripting.executeScript({ target: { tabId }, files: ['managed/core.js','managed/text-provenance.js','managed/content.js'] });
      const scan = captured || await chrome.tabs.sendMessage(tabId, { type: 'wt:collect' });
      C.assert(scan?.origin === task.siteId, '页面已跳转，请重试');
      const site = view().sites[task.siteId];
      const missingGroups=new Map();
      const reuse=C.reuseIndex(site.entries);
      let reused=0;
      for(const item of scan.items) {
        const target={...item,targetLanguage:task.targetLanguage};
        if(site.entries[C.entryKey(target)] || C.reusableEntry(site.entries,target,reuse)){reused++;continue;}
        const key=C.sharedUI(item)?C.reuseKey(target):C.entryKey(target);
        if(!missingGroups.has(key))missingGroups.set(key,[]);missingGroups.get(key).push(item);
      }
      const occurrences=[...missingGroups.values()],missing=occurrences.map((items,i)=>({...items[0],id:`t${i}`}));
      task.total = missing.length; task.scanned = scan.items.length; task.reused=reused;task.deduplicated=scan.items.length-reused-missing.length;task.truncated = scan.truncated;
      await taskSet(task);
      const glossary = Object.values(site.entries).filter(e => e.targetLanguage === task.targetLanguage && e.origin === 'manual' && e.action === 'translate').slice(0,50).map(e => ({ sourceText: e.sourceText, translation: e.translation }));
      for (let i = 0; i < missing.length; i += 20) {
        const active = view().sites[task.siteId];
        C.assert(active && !active.deleted && active.enabled && active.generation === task.generation && (await preferences()).targetLanguage === task.targetLanguage && (await chrome.storage.sync.get('enable_extension')).enable_extension!==false, '网站状态已改变，任务已取消');
        const batch = missing.slice(i, i+20);
        const result = C.validateResult(await translate(batch, task.targetLanguage, glossary), batch, task.targetLanguage);
        await locked(async () => {
          const current = view().sites[task.siteId];
          C.assert(current && !current.deleted && current.enabled && current.generation === task.generation && (await preferences()).targetLanguage === task.targetLanguage && (await chrome.storage.sync.get('enable_extension')).enable_extension!==false, '网站状态已改变，迟到结果已丢弃');
          const {wt_ai={}}=await chrome.storage.local.get('wt_ai');
          for (const entry of result) {
            // An MT service cannot classify prose; leave it eligible for a later AI update.
            if(P.catalog[wt_ai.provider]?.kind==='mt' && entry.category==='uncertain')continue;
            // validateResult preserves response order, which may differ from input order.
            const source=batch.find(item=>item.sourceText===entry.sourceText && item.context===entry.context && item.path===entry.path);
            const copies=occurrences[Number(source.id.slice(1))];
            for(const item of copies)append(task.siteId,task.generation,'entry',{...entry,path:item.path});
          }
          await save();
        });
        task.completed += result.length; task.translated += result.filter(r => r.action === 'translate').length;
        await taskSet(task); await broadcast();
      }
      task.status = 'completed'; task.message = captured ? '已采集的页面内容处理完成。' : '当前页面处理完成。';
    } catch (e) { task.status = task.completed ? 'partial' : 'failed'; task.message = e.message; }
    finally { clearInterval(heartbeat); await taskSet(task); autoSync(); }
  }
  async function preferences() { const {wt_preferences={}}=await chrome.storage.local.get('wt_preferences');return {targetLanguage:wt_preferences.targetLanguage || 'zh-Hans'}; }
  async function startCapture(tabId) {
    C.assert((await chrome.storage.sync.get('enable_extension')).enable_extension!==false,'请先开启插件');
    const tab=await chrome.tabs.get(tabId),u=new URL(tab.url);
    C.assert(['http:','https:'].includes(u.protocol),'只支持 HTTP/HTTPS 网页');
    const domain=group(u.origin),host=tldts.getDomain(u.hostname,{allowPrivateDomains:true});
    const matches=host?[`https://*.${host}/*`,`http://*.${host}/*`]:[`${u.protocol}//${u.hostname}/*`];
    for(const match of matches) C.assert(await chrome.permissions.contains({origins:[match]}),'请授予采集域名权限');
    await locked(async()=>{
      const {wt_capture}=await chrome.storage.local.get('wt_capture');
      C.assert(!wt_capture || wt_capture.status!=='collecting','请先完成或取消当前采集');
      let site=siteFor(u.href);
      if(!site || site.deleted){append(u.origin,(site?.generation || 0)+1,'create',{origin:u.origin,name:u.hostname,group:domain,builtinId:site?.builtinId || null});await save();site=siteFor(u.href);}
      C.assert(site.enabled,'请先启用此网站');
      await chrome.storage.local.set({wt_capture:{id:crypto.randomUUID(),status:'collecting',group:domain,matches,tabIds:[tabId],pages:[],items:[],truncated:false,startedAt:Date.now()}});
    });
    await registrations();
    await chrome.scripting.executeScript({target:{tabId},files:['managed/core.js','managed/text-provenance.js','managed/content.js']});
    await broadcast();return true;
  }
  async function captureData(message,sender) {
    const {wt_capture:c}=await chrome.storage.local.get('wt_capture');
    if(!c || c.status!=='collecting' || message.captureId!==c.id)return false;
    const u=new URL(sender.url),scan=message.scan;
    C.assert(c.tabIds.includes(sender.tab.id) && group(u.origin)===c.group && scan?.origin===u.origin,'采集页面范围不符');
    C.assert(Array.isArray(scan.items) && scan.items.length<=500,'采集数量无效');
    const site=siteFor(u.href);
    if(site?.deleted || site?.enabled===false || site?.excludedPaths.some(p=>u.pathname.startsWith(p)))return false;
    if((await chrome.storage.sync.get('enable_extension')).enable_extension===false)return false;
    const keys=new Set(c.items.map(i=>C.canonical([i.origin,i.path,i.context,i.sourceText])));
    let size=c.items.reduce((n,i)=>n+i.sourceText.length,0);
    for(const item of scan.items) {
      C.assert(item && typeof item.sourceText==='string' && item.sourceText.length>0 && item.sourceText.length<=4096 && typeof item.context==='string' && item.context.length<=256 && item.path===u.pathname,'采集条目无效');
      const key=C.canonical([u.origin,item.path,item.context,item.sourceText]);if(keys.has(key))continue;
      if(c.items.length>=3000 || size+item.sourceText.length>400000){c.truncated=true;break;}
      c.items.push({origin:u.origin,path:item.path,context:item.context,sourceText:item.sourceText});keys.add(key);size+=item.sourceText.length;
    }
    const page=u.origin+u.pathname;if(!c.pages.includes(page) && c.pages.length<500)c.pages.push(page);
    c.truncated ||= !!scan.truncated;
    await chrome.storage.local.set({wt_capture:c});return true;
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
      const {wt_capture:c,wt_tasks={}}=await chrome.storage.local.get(['wt_capture','wt_tasks']);
      C.assert(c?.id===initial.id && c.status==='collecting','采集状态已变化');
      const origins=[...new Set(c.items.map(i=>i.origin))];C.assert(origins.length,'尚未采集到可翻译内容');
      C.assert(!Object.values(wt_tasks).some(t=>origins.includes(t.siteId) && t.status==='running'),'采集的网站已有任务，请稍后完成');
      const targetLanguage=(await preferences()).targetLanguage,jobs=[];
      for(const origin of origins) {
        let site=siteFor(origin);
        if(site && (site.deleted || !site.enabled))continue;
        if(!site){append(origin,1,'create',{origin,name:new URL(origin).hostname,group:group(origin),builtinId:null});site=siteFor(origin);}
        const task={id:crypto.randomUUID(),siteId:origin,generation:site.generation,targetLanguage,status:'running',total:0,completed:0,translated:0,updatedAt:Date.now()};
        wt_tasks[task.id]=task;
        jobs.push({task,scan:{origin,items:c.items.filter(i=>i.origin===origin && !site.excludedPaths.some(p=>i.path.startsWith(p))).map((i,n)=>({id:`t${n}`,sourceText:i.sourceText,context:i.context,path:i.path})),truncated:c.truncated}});
      }
      C.assert(jobs.length,'采集的网站已停用或删除');await save();
      await chrome.storage.local.set({wt_tasks,wt_capture:{...c,status:'submitted',items:[],submittedAt:Date.now()}});return jobs;
    });
    await registrations();await broadcast();
    (async()=>{for(const job of jobs)await runTask(job.task,null,job.scan);})();
    return {tasks:jobs.length};
  }

  async function requireSyncConfig(expected) {
    const { wt_sync } = await chrome.storage.local.get('wt_sync');
    C.assert(wt_sync?.enabled && C.canonical(wt_sync) === C.canonical(expected), '同步设置已改变，本轮已停止；已写出的文件不会撤回');
  }
  async function syncOnce() {
    const { wt_sync = {} } = await chrome.storage.local.get('wt_sync');
    try {
      C.assert(wt_sync.enabled, '请先启用同步');
      const exported = await locked(() => structuredClone(database));
      const result = await native({ action: 'sync', directory: wt_sync.directory || '', deviceId: exported.deviceId, ops: exported.ops, applied: view().applied });
      await locked(async () => {
        await requireSyncConfig(wt_sync);
        const merged = new Map(database.ops.map(o => [o.opId, o]));
        for (const op of result.ops) { C.validateOp(op); const old = merged.get(op.opId); C.assert(!old || C.canonical(old) === C.canonical(op), '同步 opId 冲突'); merged.set(op.opId, op); }
        const next = [...merged.values()]; C.materialize(next); database.ops = next;
        for (const op of next) if (op.deviceId === database.deviceId) database.seq = Math.max(database.seq, op.seq);
        await save();
      });
      // Apply imported deletions/disablement before the optional acknowledgement write.
      await registrations(); await broadcast();
      const state = view();
      await requireSyncConfig(wt_sync);
      const confirmation = await native({ action: 'ack', directory: wt_sync.directory || '', deviceId: database.deviceId, applied: state.applied });
      return locked(async () => {
        await requireSyncConfig(wt_sync);
        const pendingLocal = database.seq !== exported.seq;
        if (pendingLocal) syncRequested = true;
        const status = { saved: true, exported: exported.ops.length, pending: view().pending.length, invalid: result.invalid, pendingLocal,
          peerConfirmed: !pendingLocal && !state.pending.length && result.invalid === 0 && confirmation.peerConfirmed === true, checkedAt: Date.now(), directory: result.directory };
        await chrome.storage.local.set({ wt_sync_status: status }); return status;
      });
    } catch (error) {
      await chrome.storage.local.set({ wt_sync_status: { saved: true, pendingLocal: true, error: error.message, peerConfirmed: false } });
      throw error;
    }
  }
  function synchronize() {
    syncRequested = true;
    if (!syncFlight) syncFlight = (async () => {
      let result;
      do { syncRequested = false; result = await syncOnce(); } while (syncRequested);
      return result;
    })().finally(() => {
      syncFlight = null;
      // A change arriving during a failed exchange still gets one new attempt.
      if (syncRequested) { syncRequested = false; autoSync(); }
    });
    return syncFlight;
  }
  function autoSync() { chrome.storage.local.get('wt_sync').then(({wt_sync}) => { if (wt_sync?.enabled) return synchronize(); }).catch(() => {}); }
  chrome.runtime.onStartup.addListener(() => ready.then(autoSync));
  chrome.permissions.onAdded.addListener(() => ready.then(registrations));
  chrome.permissions.onRemoved.addListener(() => ready.then(registrations));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if (changes.enable_extension) ready.then(broadcast);
    const keys = Object.keys(changes).filter(k => k.startsWith('site_enabled_'));
    if (keys.length) ready.then(() => locked(async () => {
      for (const key of keys) for (const s of Object.values(view().sites)) if (!s.deleted && s.builtinId === key.slice(13)) append(s.id,s.generation,'setting',{key:'enabled',value:changes[key].newValue !== false});
      await save(); await broadcast(); autoSync();
    })).catch(()=>{});
  });
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (!message?.type?.startsWith('wt:') || message.type === 'wt:apply' || message.type === 'wt:collect') return false;
    (async () => {
      await ready;
      const trustedUI = sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL(''));
      if (!trustedUI && sender.tab) {
        C.assert(['wt:page','wt:capture-data'].includes(message.type), '页面没有此操作权限');
        if(message.type==='wt:page') return pageState(sender.url,sender.tab.id);
        return locked(()=>captureData(message,sender));
      }
      C.assert(trustedUI, '仅允许扩展界面操作');
      if (message.type === 'wt:state') {
        const state = view();
        const local = await chrome.storage.local.get(['wt_tasks','wt_ai','wt_sync','wt_sync_status','wt_preferences','wt_capture','wt_ai_profiles']);
        for (const site of Object.values(state.sites)) site.authorized = await chrome.permissions.contains({ origins: [`${new URL(site.origin).protocol}//${new URL(site.origin).hostname}/*`] });
        return { ...state, ...local, defaultPrompt:C.translationPrompt, globalEnabled:(await chrome.storage.sync.get('enable_extension')).enable_extension !== false };
      }
      if(message.type==='wt:capture-start')return startCapture(message.tabId);
      if(message.type==='wt:capture-finish')return finishCapture();
      if(message.type==='wt:capture-cancel'){await locked(()=>chrome.storage.local.remove('wt_capture'));await registrations();await broadcast();return true;}
      if(message.type==='wt:group-change') {
        C.assert(['enabled','delete'].includes(message.action),'分组操作无效');
        await locked(async()=>{for(const s of Object.values(view().sites))if(!s.deleted && s.group===message.group)append(s.id,s.generation,message.action==='delete'?'delete':'setting',message.action==='delete'?{}:{key:'enabled',value:!!message.enabled});await save();});
        await registrations();await broadcast();autoSync();return true;
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
        await registrations(); await broadcast(); autoSync(); return true;
      }
      if (message.type === 'wt:config') {
        if (message.ai) {
          const a=message.ai;C.assert(P.catalog[a.provider] && typeof a.model==='string' && a.model.length<=200,'AI 设置无效');
          C.assert(['auto','none','minimal','low','medium','high','xhigh','max'].includes(a.reasoningEffort || 'auto'),'思考强度无效');
          const config={provider:a.provider,model:a.model,endpoint:a.provider==='chatgpt'?'':P.normalizeEndpoint(a.provider,a.endpoint),apiKey:a.provider==='chatgpt'?'':String(a.apiKey || ''),region:String(a.region || ''),prompt:C.validatePrompt(a.prompt),reasoningEffort:a.reasoningEffort || 'auto'};
          await locked(async()=>{const {wt_ai_profiles={}}=await chrome.storage.local.get('wt_ai_profiles');await chrome.storage.local.set({wt_ai:config,wt_ai_profiles:{...wt_ai_profiles,[config.provider]:config}});});
        }
        if(message.preferences) {
          const targetLanguage=C.language(message.preferences.targetLanguage);
          await locked(()=>chrome.storage.local.set({wt_preferences:{targetLanguage}}));
          await broadcast();
        }
        if (message.sync) await locked(() => chrome.storage.local.set({ wt_sync: { enabled: !!message.sync.enabled, directory: String(message.sync.directory || ''), revision: crypto.randomUUID() }, wt_sync_status: { saved: true, pendingLocal: true, peerConfirmed: false } }));
        autoSync(); return true;
      }
      if(message.type==='wt:test'){const inputs=[{id:'test',sourceText:'Save changes',context:'form/button/text',path:'/'}];const targetLanguage=(await preferences()).targetLanguage;C.validateResult(await translate(inputs,targetLanguage,[]),inputs,targetLanguage);return true;}
      if (message.type === 'wt:sync') return synchronize();
      if (message.type === 'wt:native') { C.assert(['status','logout','models'].includes(message.action), '连接操作无效'); return native({ action: message.action }); }
      throw new Error('未知操作');
    })().then(result => reply({ ok: true, result }), e => reply({ ok: false, error: e.message }));
    return true;
  });
})();
