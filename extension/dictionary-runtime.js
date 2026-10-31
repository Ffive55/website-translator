/* GPL-3.0-or-later. The background is the only writer of settings and local edits. */
(() => {
  'use strict';
  const C = WTCore, D = C.dictionary, R = C.dictionaryRepository;
  function create(hooks) {
    let store, policy, context, config, client, active = false, applying = false, userChanged = false, timer, queue = Promise.resolve();
    const cache = new Map();let cacheEpoch=0;
    const invalidateCache=()=>{cacheEpoch++;cache.clear();};
    let clientIdentity, accessKey, mirrorSignature, mirrorQueue=Promise.resolve(), starting=true, importing=false, startup={phase:'正在读取本机词库',done:0,total:0};
    const yieldUI=()=>new Promise(resolve=>setTimeout(resolve,0));
    const serial = fn => { const next = queue.then(fn); queue = next.catch(() => {}); return next; };
    const local = keys => chrome.storage.local.get(keys);
    const language = async () => (await hooks.preferences()).targetLanguage;
    async function status(patch) { const { wt_repository_status = {} } = await local('wt_repository_status'); const next={...wt_repository_status,...patch};if(C.canonical(next)!==C.canonical(wt_repository_status))await chrome.storage.local.set({wt_repository_status:next}); }
    async function refreshContext() {
      const { wt_repository = { owner: 'Ffive55', repo: 'website-translator', branch: 'main' }, wt_repository_token = '' } = await local(['wt_repository', 'wt_repository_token']);
      const next = R.configuration(wt_repository);
      if (!config || C.canonical(next) !== C.canonical(config)) { config = next; invalidateCache(); }
      const identity=C.canonical([config,wt_repository_token]);
      if(clientIdentity!==identity){client = R.create({ repository: config, token: wt_repository_token, policy, getDomain: tldts.getDomain });accessKey=wt_repository_token?await D.digest(wt_repository_token):'anonymous';clientIdentity=identity;}
      context = await store.setContext({ repository: config, targetLanguage: await language(), installations: Object.values(hooks.view().sites).filter(s => !s.deleted).map(s => ({ origin: s.origin, generation: s.generation })) });
      return context;
    }
    async function stateFor(group, lang = context.targetLanguage) {
      const key=C.canonical([config,group,lang]);if(cache.has(key))return cache.get(key);const epoch=cacheEpoch,result=await store.read(config,group,lang);if(epoch===cacheEpoch)cache.set(key,result);return result;
    }
    function mirror(){const next=mirrorQueue.then(mirrorImpl);mirrorQueue=next.catch(()=>{});return next;}
    async function mirrorImpl() {
      await refreshContext();
      const mirrorRepository=config,mirrorContext=context;
      const database=hooks.database(),signature=C.canonical([config,context.identity,database.deviceId,database.seq,database.ops.length,database.ops.at(-1)?.opId]);
      if(mirrorSignature===signature)return;
      const saved=await local(['wt_dictionary_mirror','wt_dictionary_generations']);
      const repositoryKey=C.canonical(mirrorRepository),oldMirror=saved.wt_dictionary_mirror || {},oldGenerations=saved.wt_dictionary_generations || {};
      const mirrors=oldMirror.version===2?oldMirror:{version:2,repositories:{}};
      const generations=oldGenerations.version===2?oldGenerations:{version:2,repositories:{}};
      const marks=mirrors.repositories[repositoryKey] ||= {},versions=generations.repositories[repositoryKey] ||= {};
      const batches=new Map(),marksForGroup=new Map();let count=0;
      for(const site of Object.values(hooks.view().sites)){
        const generation=site.generation+':'+site.deleted,oldGeneration=versions[site.origin] || (oldGenerations.version===2?null:oldGenerations[site.origin]);
        if(oldGeneration&&oldGeneration!==generation){await store.resetLocal(site.origin,mirrorRepository,oldGeneration);for(const key of Object.keys(marks))if(JSON.parse(key)[0]===site.origin)delete marks[key];}
        versions[site.origin]=generation;if(site.deleted)continue;
        for(const entry of Object.values(site.entries)){
          if(entry.targetLanguage!==mirrorContext.targetLanguage)continue;
          const row={site:site.origin,entry},key=D.entryIdentity(row),opId=hooks.localVersion(site,entry),fingerprint='v3:'+site.generation+':'+opId;
          if(marks[key]===fingerprint)continue;
          const legacy=oldMirror.version===2?marks[key]:oldMirror[key],prefix=repositoryKey+':'+site.generation+':'+opId+':';
          if(typeof legacy==='string'&&legacy.startsWith(prefix)&&legacy===prefix+await D.digest(row)){marks[key]=fingerprint;continue;}
          if(!batches.has(site.group)){batches.set(site.group,[]);marksForGroup.set(site.group,[]);}
          batches.get(site.group).push(row);marksForGroup.get(site.group).push([key,fingerprint]);
          if(++count%250===0){startup={phase:'正在校验本机词条',done:count,total:count};await yieldUI();}
        }
      }
      let done=0;const total=[...batches.values()].reduce((n,rows)=>n+rows.length,0);
      for(const [group,rows] of batches){
        await store.editBatch(mirrorRepository,group,mirrorContext.targetLanguage,rows,mirrorContext.revision);
        for(const [key,stamp] of marksForGroup.get(group))marks[key]=stamp;
        done+=rows.length;startup={phase:'正在保存迁移词库',done,total};await status({startup});await yieldUI();
      }
      await chrome.storage.local.set({wt_dictionary_mirror:mirrors,wt_dictionary_generations:generations});invalidateCache();
      mirrorSignature=signature;
    }
    async function captureSettings() {
      const values = await local(['wt_install_records','wt_install_observed','wt_prompt','wt_ai','wt_ai_profiles']);
      let rows = values.wt_install_records || [], observed = values.wt_install_observed || {};
      const settings = { ...D.syncPreferences(await hooks.preferences()), enable_extension: (await chrome.storage.sync.get('enable_extension')).enable_extension !== false };
      await status({promptLocalOnly:D.bytes(values.wt_prompt || '')>5000});
      if (D.bytes(values.wt_prompt || '') <= 5000) settings.prompt = values.wt_prompt || C.translationPrompt;
      if(values.wt_ai){settings.aiSettings=Object.fromEntries(['provider','model','endpoint','region','reasoningEffort'].map(k=>[k,String(values.wt_ai[k] || '')]));}
      for(const [provider,profile] of Object.entries(values.wt_ai_profiles || {}))settings['aiProfile:'+provider]=Object.fromEntries(['provider','model','endpoint','region','reasoningEffort'].map(k=>[k,k==='provider'?provider:String(profile[k] || '')]));
      const current = Object.entries(settings).map(([field,value]) => ({ kind:'preference',id:'settings',field,value }));
      for(const s of Object.values(hooks.view().sites)) for(const [field,value] of Object.entries({installed:!s.deleted,enabled:s.enabled,excludedPaths:s.excludedPaths,name:s.name})) current.push({kind:'site',id:s.origin,field,value});
      let counter = Math.max(0,...rows.map(r=>r.counter));
      const changes=[];
      for(const r of current) { const key=D.syncIdentity(r), value=C.canonical(r.value); if(observed[key]!==value) { changes.push({...r,counter:++counter,deviceId:hooks.deviceId()}); observed[key]=value; } }
      rows=D.mergeSync(rows,changes); await chrome.storage.local.set({wt_install_records:rows,wt_install_observed:observed}); return rows;
    }
    async function sync(receive = false, attempt = 0) {
      if (!active) return;
      // Capture pending device edits BEFORE receiving; incoming settings must never erase them.
      const saved=await local(['wt_install_records','wt_install_observed']);
      const snapshot = await chrome.storage.sync.get(null), incoming = await D.unpackSync(snapshot);
      if(!incoming && !saved.wt_install_observed && !userChanged && !Object.keys(hooks.view().sites).length) {
        await status({syncError:null,waitingForSync:true});return;
      }
      let rows = (!saved.wt_install_observed && incoming) ? (saved.wt_install_records || []) : await captureSettings();
      if(incoming) {
        const merged=D.mergeSync(rows,incoming);if(C.canonical(merged)!==C.canonical(rows)||!saved.wt_install_observed){applying=true;try{await hooks.applySync(merged);}finally{applying=false;}}rows=merged;
        const observed=Object.fromEntries(rows.map(r=>[D.syncIdentity(r),C.canonical(r.value)]));
        await chrome.storage.local.set({wt_install_records:rows,wt_install_observed:observed});
      }
      const packed=await D.packSync(rows), current=await chrome.storage.sync.get(Object.keys(packed));
      // Hashing and IndexedDB work yield to sync arrivals. Never publish a snapshot
      // computed before a newly arrived head; re-read and merge it first.
      if(C.canonical(current.wt_install_head)!==C.canonical(snapshot.wt_install_head)) {
        C.assert(attempt<3,'同步清单持续变化，稍后自动重试');return sync(receive,attempt+1);
      }
      if(C.canonical(current)!==C.canonical(packed)) {
        const {wt_install_head,...shards}=packed;
        if(Object.keys(shards).length)await chrome.storage.sync.set(shards);
        await chrome.storage.sync.set({wt_install_head});
        const stale=Object.keys(await chrome.storage.sync.get(null)).filter(k=>/^wt_install_\d+$/.test(k) && !(k in packed));if(stale.length)await chrome.storage.sync.remove(stale);
      }
      await mirror(); await status({syncError:null,syncSavedAt:Date.now()});
      if(receive){await hooks.broadcast();await restore();}
    }
    async function restore() {
      const {wt_repository_status:net={}}=await local('wt_repository_status');if(net.needsAuthorization||net.networkRetryAt>Date.now())return;
      if (!context.installations.length) return;
      if(!await chrome.permissions.contains({origins:['https://api.github.com/*']})) { await status({error:'请在词库上传页授予 GitHub 连接权限后恢复词库'}); return; }
      const wanted=new Map();for(const s of context.installations){const g=D.groupFor(s.origin,tldts.getDomain);if(!wanted.has(g))wanted.set(g,[]);wanted.get(g).push(s.origin);}
      let pin;
      for(const [group,origins] of wanted) {
        const current=await stateFor(group);
        if(current?.contentRevision && origins.every(o=>current.installedOrigins.includes(o))) continue;
        try {pin ||= await client.readIndex();await updateGroup(group,pin);}catch(e){await networkError(e);if(e.status||e.kind==='network')break;}
      }
    }
    async function networkError(error){await status({error:error.message,httpStatus:error.status||null,networkKind:error.kind||null,networkError:error.message,networkRetryAt:error.retryAt||Date.now()+60000,networkAccessKey:accessKey,requestAuthenticated:error.authenticated??accessKey!=='anonymous',rateLimit:error.rateLimit||null,needsAuthorization:['authorization','not-found'].includes(error.kind),requestId:error.requestId||null});}
    async function requireNetworkBudget(){const {wt_repository_status:net={}}=await local('wt_repository_status');if(net.networkKind==='rate-limit'&&net.networkRetryAt>Date.now()&&(!net.networkAccessKey||net.networkAccessKey===accessKey)){const error=new Error(net.networkError||net.error||'GitHub 限流等待尚未结束');Object.assign(error,{kind:'rate-limit',status:net.httpStatus||403,retryAt:net.networkRetryAt,authenticated:net.requestAuthenticated,rateLimit:net.rateLimit});throw error;}}

    async function check() {
      await mirror();await requireNetworkBudget(); const lang=context.targetLanguage, groups=new Map();
      for(const s of context.installations){const g=D.groupFor(s.origin,tldts.getDomain);if(!groups.has(g))groups.set(g,[]);groups.get(g).push(s.origin);}
      const installed=[];for(const [group,origins] of groups)installed.push({group,origins,revision:(await stateFor(group))?.contentRevision});
      const result=await client.check(installed,lang);
      await chrome.storage.local.set({wt_dictionary_check:{language:lang,context:context.identity,checkedAt:Date.now(),groups:result.groups.map(({files,...g})=>g)}});
      await status({error:null,needsAuthorization:false,networkRetryAt:0}); return '已检查 '+groups.size+' 个主域名';
    }
    async function updateGroup(group,pinned) {
      await mirror();await requireNetworkBudget();const ctx=context,repo={...config},origins=ctx.installations.filter(s=>D.groupFor(s.origin,tldts.getDomain)===group).map(s=>s.origin);
      C.assert(origins.length,'此主域名没有已安装网址');
      const ticket=await store.beginDownload(repo,group,ctx.targetLanguage,ctx.revision);
      await status({busy:group,error:null});
      try {
        const pin=pinned||await client.readIndex(true),candidate=await client.downloadGroup(pin,group,ctx.targetLanguage,origins);
        await refreshContext();const result=await store.install(candidate,ctx.revision,ticket);invalidateCache();
        await status({busy:null,error:null});await hooks.broadcast();if(result.installed)for(const tab of await chrome.tabs.query({})){if(origins.some(o=>tab.url?.startsWith(o+'/')))chrome.tabs.sendMessage(tab.id,{type:'wt:dictionary-refresh',revision:candidate.revision}).catch(()=>{});}return result.installed?'已更新 '+group:'存在冲突，请在该分组处理';
      }catch(e){await status({busy:null});await networkError(e);throw e;}
    }
    async function summary() {
      if(!active||starting||importing)return {ready:false,starting,status:{...(await local('wt_repository_status')).wt_repository_status,startup}};
      const {wt_dictionary_check,wt_repository_status,wt_migration,wt_repository_token}=await local(['wt_dictionary_check','wt_repository_status','wt_migration','wt_repository_token']);
      const groups={};
      for(const s of context.installations){const group=D.groupFor(s.origin,tldts.getDomain);if(groups[group])continue;const state=await stateFor(group),stage=await store.pending(config,group,context.targetLanguage);
        groups[group]={pending:Object.keys(state?.local || {}).length,conflicts:stage?.comparison.conflicts || [],installed:!!state?.contentRevision,missing:state?.missing||[]};
      }
      return {ready:true,repository:config,hasToken:!!wt_repository_token,groups,check:wt_dictionary_check?.context===context.identity?wt_dictionary_check:null,status:wt_repository_status,migration:wt_migration};
    }
    async function enrich(site) {
      if(!active || starting || importing || !site || site.deleted)return site;
      if(starting||importing)return {...site,dictionaryAvailable:false};
      await mirror();const lang=await language(),state=await stateFor(site.group,lang);if(!state)return {...site,dictionaryAvailable:false};
      const entries={...site.entries};
      for(const [key,row] of Object.entries({...state.baseline,...state.local})) {
        const identity=JSON.parse(key);if(identity[0]!==site.origin)continue;
        if(row)entries[C.entryKey(row.entry)]=row.entry;else delete entries[C.canonical(identity.slice(1))];
      }
      return {...site,entries,dictionaryAvailable:state.files.some(f=>f.pack.origins.includes(site.origin))};
    }
    async function adapter(url) {
      const site=hooks.view().sites[new URL(url).origin],lang=await language();
      if(!active || !site || site.deleted || !site.enabled || lang!=='zh-Hans' || site.excludedPaths.some(p=>new URL(url).pathname.startsWith(p)) || (await chrome.storage.sync.get('enable_extension')).enable_extension===false)return null;
      const state=await stateFor(site.group,lang);
      return state?.files.find(f=>f.pack.adapter && f.pack.origins.includes(site.origin))?.pack || null;
    }
    async function configure(message) {
      const before=await local(['wt_repository_token','wt_repository_status']);
      const repository=R.configuration(message.repository);C.assert(typeof message.token==='string' && message.token.length<=1000 && !/[\r\n]/.test(message.token),'GitHub 凭据无效');
      await chrome.storage.local.set({wt_repository:repository,...(message.token?{wt_repository_token:message.token}:{})});if(message.clearToken)await chrome.storage.local.remove('wt_repository_token');
      const {wt_repository_token:currentToken=''}=await local('wt_repository_token'),changedCredential=(before.wt_repository_token||'')!==currentToken;
      const waiting=before.wt_repository_status?.networkKind==='rate-limit'&&before.wt_repository_status.networkRetryAt>Date.now()&&!changedCredential;
      invalidateCache();if(!waiting)clientIdentity=null;await refreshContext();if(!waiting)await status({error:null,networkKind:null,networkError:null,rateLimit:null,needsAuthorization:false,networkRetryAt:0});scheduleRecovery(true);
      return currentToken?'仓库设置及本设备凭据已保存；连接结果见下方状态':'仓库地址已保存；尚未配置 GitHub Token，当前为匿名访问';
    }
    async function preview(group) {
      await mirror();await requireNetworkBudget();const ctx=context,state=await stateFor(group),origins=ctx.installations.filter(s=>D.groupFor(s.origin,tldts.getDomain)===group).map(s=>s.origin);
      C.assert(origins.length,'网站已移除');C.assert(!(await store.pending(config,group,ctx.targetLanguage))?.comparison.conflicts.length,'请先解决词库冲突');
      C.assert(!origins.some(origin=>Object.values(hooks.view().sites[origin]?.conflicts||{}).some(rows=>rows[0]?.targetLanguage===ctx.targetLanguage)), '旧本机词条有并发候选，请先保存人工译文解决冲突');
      const draft=await C.dictionaryPublish.prepare(client,config,state,origins,ctx.targetLanguage,tldts.getDomain,policy);
      C.assert(!draft.empty,'没有需要上传的修改');
      draft.context=ctx.identity;draft.repository=config;draft.id=crypto.randomUUID();await chrome.storage.local.set({wt_dictionary_upload:draft});
      return {id:draft.id,group,changes:draft.changes};
    }
    async function publish(id) {
      await mirror();await requireNetworkBudget();const {wt_dictionary_upload:draft,wt_repository_token:token,wt_dictionary_publication:previous}=await local(['wt_dictionary_upload','wt_repository_token','wt_dictionary_publication']);
      C.assert(draft?.id===id && draft.context===context.identity,'预览已失效，请重新预览');
      const state=await stateFor(draft.group);C.assert((state?.revision || 0)===draft.expectedRevision,'预览后本地有修改，请重新预览');
      const publisher=C.dictionaryPublish.create({repository:config,token,beforeCommit:async()=>{await mirror();C.assert(context.identity===draft.context,'上传准备期间网站或语言已改变，请重新预览');C.assert(((await stateFor(draft.group))?.revision||0)===draft.expectedRevision,'上传准备期间本地有新修改，未发布，请重新预览');},journal:saved=>chrome.storage.local.set({wt_dictionary_publication:{...saved,draftId:id}})});
      const saved=previous?.draftId===id && await publisher.confirm(previous)?previous:await publisher.publish(draft);
      await updateGroup(draft.group);await chrome.storage.local.remove('wt_dictionary_upload');await status({lastUpload:saved.commit});return '上传成功：'+saved.commit;
    }
    async function importFile(input,recovering=false){
      let value=input;
      if(value?.checksum){C.assert(value.schemaVersion===1&&Object.keys(value).sort().join(',')==='checksum,data,schemaVersion'&&await D.digest(value.data)===value.checksum,'旧文件校验失败');value=value.data;}
      C.assert(value&&D.bytes(value)<=128*1024*1024,'备份格式或大小无效');
      const settings=value.settingsRecords?D.mergeSync(value.settingsRecords):null,repository=value.repository?R.configuration(value.repository):null,prompt=value.prompt===undefined?null:C.validatePrompt(value.prompt);
      if(value.mirror){const metadata=value.mirror;C.assert(typeof metadata==='object'&&!Array.isArray(metadata),'备份迁移标记无效');const maps=metadata.version===2?Object.values(metadata.repositories||{}):[metadata];C.assert(metadata.version!==2||metadata.repositories&&typeof metadata.repositories==='object'&&!Array.isArray(metadata.repositories),'备份仓库标记无效');for(const map of maps){C.assert(map&&typeof map==='object'&&!Array.isArray(map)&&Object.keys(map).length<=50000,'备份迁移标记无效');for(const [id,stamp] of Object.entries(map)){const identity=JSON.parse(id);C.assert(Array.isArray(identity)&&identity.length===5&&typeof stamp==='string'&&stamp.length<=2048,'备份迁移标记无效');D.origin(identity[0]);C.assert(C.language(identity[4])===identity[4],'备份迁移语言无效');}}}
      if(settings)for(const row of settings)if(row.field==='aiSettings'||row.field.startsWith('aiProfile:'))C.assert(Object.hasOwn(WTProviders.catalog,row.value.provider),'备份包含当前版本不支持的翻译服务');
      const prepared=value.database?await C.dictionaryMigration.prepare(value.database,value.preferences||{},tldts.getDomain):null;
      const ops=prepared?.backup.ops || (Array.isArray(value.ops)?value.ops:value.opId?[value]:null);
      C.assert(ops&&ops.length<=50000,'请选择受支持的备份、changes 或 snapshots 文件');
      const all=new Map(hooks.database().ops.map(op=>[op.opId,op]));for(const op of ops){C.validateOp(op);C.assert(!all.has(op.opId)||C.canonical(all.get(op.opId))===C.canonical(op),'备份与本机记录冲突');all.set(op.opId,op);}C.materialize([...all.values()]);
      importing=true;
      try{
        await hooks.withWriter(async()=>{
          const {wt_dictionary_import:previous}=await local('wt_dictionary_import');
          C.assert(!previous||recovering,'已有未完成导入，请先继续该导入');
          const journalId=previous?.id||crypto.randomUUID();
          if(!previous){const old=await local(['wt_dictionary_mirror','wt_prompt']);await chrome.storage.local.set({wt_dictionary_import:{schemaVersion:1,id:journalId,value,at:Date.now(),before:{database:structuredClone(hooks.database()),preferences:await hooks.preferences(),layers:await store.exportData(),archives:await store.exportArchives(),mirror:old.wt_dictionary_mirror,repository:config,prompt:old.wt_prompt}}});}
          // The journal precedes both storage engines. On interruption the same
          // validated union is resumed; originals are never replaced by a snapshot.
          if(value.layers||value.archives)await store.importData(value.layers||[],journalId,value.archives||[]);
          await hooks.importOpsDirect(ops);const {wt_dictionary_import:progress}=await local('wt_dictionary_import');await chrome.storage.local.set({wt_dictionary_import:{...progress,phase:'database-applied'}});
          if(prepared)await hooks.restorePreferences(prepared.preferences);
          if(value.mirror)await chrome.storage.local.set({wt_dictionary_mirror:value.mirror});const meta=(await local('wt_dictionary_generations')).wt_dictionary_generations;const generations=meta?.version===2?meta:{version:2,repositories:{}};generations.repositories[C.canonical(repository||config)]=Object.fromEntries(Object.values(hooks.view().sites).map(site=>[site.origin,site.generation+':'+site.deleted]));await chrome.storage.local.set({wt_dictionary_generations:generations});
          if(settings){await hooks.applySyncDirect(settings);await chrome.storage.local.set({wt_install_records:settings,wt_install_observed:Object.fromEntries(settings.map(row=>[D.syncIdentity(row),C.canonical(row.value)]))});}
          if(repository)await chrome.storage.local.set({wt_repository:repository});if(prompt!==null)await chrome.storage.local.set({wt_prompt:prompt});
          await chrome.storage.local.remove(['wt_dictionary_import','wt_dictionary_check']);
        });
        importing=false;mirrorSignature=null;invalidateCache();await mirror();changed();await status({importPending:false,error:null});await hooks.broadcast();return '旧数据已导入，原始记录保留';
      }catch(error){await status({importPending:true,error:'导入尚未完成，导入前备份已保留：'+error.message});throw error;}
    }
    async function handle(message) {
      if(message.action==='startup')return summary();
      if(message.action==='backup'&&importing){const {wt_dictionary_import:journal}=await local('wt_dictionary_import');if(journal?.before)return journal.before;}
      if(message.action==='backup'&&(!active||starting))return {database:structuredClone(hooks.database()),preferences:await hooks.preferences()};
      const {wt_dictionary_import:pendingImport}=await local('wt_dictionary_import');if(pendingImport&&!['import-resume','import-before','import-cancel','backup'].includes(message.action))throw new Error('存在未完成导入，请先继续导入或导出导入前备份');
      return serial(async()=>{
        if(message.action==='configure')return configure(message);
        if(message.action==='check')return check();
        if(message.action==='update')return updateGroup(message.group);
        if(message.action==='all'){const info=await summary(),results=[];for(const g of info.check?.groups || [])if(g.hasUpdate)try{results.push(await updateGroup(g.group));}catch(e){results.push(g.group+'：'+e.message);}await check();return results.join('；') || '没有待更新词库';}
        if(message.action==='preview')return preview(message.group);
        if(message.action==='publish')return publish(message.id);
        if(message.action==='resolve'){await mirror();const result=await store.resolve(config,message.group,context.targetLanguage,message.key,message.choice,message.edited,context.revision);invalidateCache();await hooks.broadcast();if(result.installed)for(const tab of await chrome.tabs.query({})){try{if(D.groupFor(new URL(tab.url).origin,tldts.getDomain)===message.group)chrome.tabs.sendMessage(tab.id,{type:'wt:dictionary-refresh',revision:(await stateFor(message.group)).contentRevision}).catch(()=>{});}catch{}}return result.installed?'冲突已解决，词库已更新':'已处理，请继续解决剩余冲突';}
        if(message.action==='delete-entry'){await mirror();await store.edit(config,message.group,context.targetLanguage,{...message.row,deleted:true},context.revision);invalidateCache();await hooks.broadcast();return '词条已标记删除，上传后同步到 GitHub';}
        if(message.action==='import-files'){C.assert(Array.isArray(message.values)&&message.values.length<=20000,'文件数量无效');const ops=[];for(let value of message.values){if(value?.checksum){C.assert(value.schemaVersion===1&&await D.digest(value.data)===value.checksum,'旧文件校验失败');value=value.data;}const rows=Array.isArray(value?.ops)?value.ops:value?.opId?[value]:null;C.assert(rows,'多个文件只支持 changes/snapshots，完整备份请单独选择');ops.push(...rows);}return importFile({ops});}
        if(message.action==='import-file')return importFile(message.value);
        if(message.action==='import-legacy')return importFile({ops:message.ops});
        if(message.action==='import-resume'){const {wt_dictionary_import:journal}=await local('wt_dictionary_import');C.assert(journal,'没有待恢复导入');const result=await importFile(journal.value,true);if(!active)await start();return result;}
        if(message.action==='import-cancel'){const {wt_dictionary_import:journal}=await local('wt_dictionary_import');C.assert(journal&&!journal.phase&&!await store.importApplied(journal.id)&&C.canonical(hooks.database())===C.canonical(journal.before.database),'导入已有部分写入，请继续恢复或导出导入前备份');await chrome.storage.local.remove('wt_dictionary_import');importing=false;await status({importPending:false,error:null});if(!active)await start();return '未写入的导入已取消';}
        if(message.action==='restart')return start();
        if(message.action==='import-before'){const {wt_dictionary_import:journal}=await local('wt_dictionary_import');C.assert(journal?.before,'没有导入前备份');return journal.before;}
        if(message.action==='backup'){await mirror();const {wt_dictionary_mirror:savedMirror,wt_prompt:prompt}=await local(['wt_dictionary_mirror','wt_prompt']);return {database:structuredClone(hooks.database()),preferences:await hooks.preferences(),layers:await store.exportData(),archives:await store.exportArchives(),mirror:savedMirror,repository:config,settingsRecords:await captureSettings(),prompt};}
        if(message.action==='restore')return restore();
        if(message.action==='sync')return sync(true);
        throw new Error('未知词库操作');
      }).catch(async error=>{if(error.status||['rate-limit','network','authorization','not-found'].includes(error.kind))await networkError(error);throw error;});
    }
    let recoveryQueued=false,recoveryAgain=false,recoveryReceive=false;
    function scheduleRecovery(receive){recoveryReceive ||= receive;if(importing){recoveryAgain=true;return;}if(recoveryQueued){recoveryAgain=true;return;}recoveryQueued=true;serial(async()=>{const incoming=recoveryReceive;recoveryReceive=false;await sync(incoming);if(!incoming)await restore();}).catch(e=>status({syncError:e.message})).finally(()=>{recoveryQueued=false;if(recoveryAgain){recoveryAgain=false;scheduleRecovery(recoveryReceive);}});}
    function changed(){if(!active || applying)return;userChanged=true;invalidateCache();clearTimeout(timer);timer=setTimeout(()=>scheduleRecovery(false),500);}
    async function start() {
      starting=true;startup={phase:'正在验证旧数据',done:0,total:hooks.database().ops.length};await status({startup});await yieldUI();
      try {
      policy=await(await fetch(chrome.runtime.getURL('managed/dictionary-policy.json'))).json();
      store?.close();store=await C.dictionaryStore.open({getDomain:tldts.getDomain,policy});await refreshContext();
      const {wt_migration}=await local('wt_migration');
      if(!wt_migration){const prepared=await C.dictionaryMigration.prepare(hooks.database(),await hooks.preferences(),tldts.getDomain);await store.stageLegacy(prepared);
        await chrome.storage.local.set({wt_dictionary_backup:{database:structuredClone(hooks.database()),preferences:await hooks.preferences()},wt_migration:{version:1,status:'prepared',at:Date.now(),sourceSha256:prepared.sourceSha256},wt_sync:{enabled:false}});}
      const {wt_dictionary_import:journal}=await local('wt_dictionary_import');if(journal)await importFile(journal.value,true);
      await mirror();active=true;starting=false;startup={phase:'本机词库已就绪',done:1,total:1};const {wt_migration:migration={}}=await local('wt_migration');await chrome.storage.local.set({wt_migration:{...migration,status:'active'}});await status({startup,error:null});await hooks.broadcast();
      await chrome.alarms.clear('wt-sync-retry');chrome.alarms.create('wt-dictionary-recover',{periodInMinutes:2});
      scheduleRecovery(true);
      }catch(error){starting=false;active=false;startup={phase:'迁移未完成，原数据保留',error:error.message};await status({startup,error:error.message});throw error;}
    }
    chrome.storage.onChanged.addListener((changes,area)=>{if(!active)return;if(area==='sync' && Object.keys(changes).some(k=>k.startsWith('wt_install_')))scheduleRecovery(true);else if(area==='sync' && changes.enable_extension)changed();});
    chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name==='wt-dictionary-recover')scheduleRecovery(true);});
    return {start,changed,summary,enrich,adapter,handle,active:()=>active&&!starting&&!importing};
  }
  globalThis.WTDictionaryRuntime={create};
})();
