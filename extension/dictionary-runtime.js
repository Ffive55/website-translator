/* GPL-3.0-or-later. The background is the only writer of settings and local edits. */
(() => {
  'use strict';
  const C = WTCore, D = C.dictionary, R = C.dictionaryRepository;
  function create(hooks) {
    let store, policy, context, config, client, active = false, applying = false, userChanged = false, timer, queue = Promise.resolve();
    const cache = new Map();let cacheEpoch=0;
    const invalidateCache=()=>{cacheEpoch++;cache.clear();};
    let clientIdentity, accessKey, mirrorSignature, contextStamp, mirrorQueue=Promise.resolve(), starting=true, startup={phase:'正在读取本机词库',done:0,total:0};
    const yieldUI=()=>new Promise(resolve=>setTimeout(resolve,0));
    const serial = fn => { const next = queue.then(fn); queue = next.catch(() => {}); return next; };
    const local = keys => chrome.storage.local.get(keys);
    const language = async () => (await hooks.preferences()).targetLanguage;
    async function status(patch) { const { wt_repository_status = {} } = await local('wt_repository_status'); const next={...wt_repository_status,...patch};if(C.canonical(next)!==C.canonical(wt_repository_status))await chrome.storage.local.set({wt_repository_status:next}); }
    const tokenFor=(values,selected)=>Object.hasOwn(values.wt_repository_credentials||{},selected)?values.wt_repository_credentials[selected]:((values.wt_repository_token_provider||'github')===selected?values.wt_repository_token||'':'');
    let discovery=null,seedFlight;
    const transfers=new Map();
    const databaseStamp=()=>{const db=hooks.database();return C.canonical([db.deviceId,db.seq,db.ops.length,db.ops.at(-1)?.opId]);};
    function confirmation(plan,details) {
      for(const [id,item] of transfers)if(item.expires<Date.now())transfers.delete(id);
      while(transfers.size>=8)transfers.delete(transfers.keys().next().value);
      const id=crypto.randomUUID();transfers.set(id,{...plan,full:!!details.full,context:context.identity,accessKey,expires:Date.now()+10*60*1000});
      return {requiresConfirmation:true,id,group:plan.group,language:context.targetLanguage,direction:plan.direction,...details};
    }
    async function initializationSeed(){
      if(!seedFlight)seedFlight=(async()=>{
        const response=await fetch(chrome.runtime.getURL('managed/repository-seed.json'));
        C.assert(response.ok,'无法读取内置初始化词库');
        const raw=await response.text();
        C.assert(D.bytes(raw)<12*1024*1024,'初始化包过大');
        return C.dictionaryInitialize.prepare(JSON.parse(raw),{getDomain:tldts.getDomain,policy});
      })().catch(error=>{seedFlight=null;throw error;});
      return seedFlight;
    }
    async function refreshContext() {
      const credentials=await local(['wt_repository','wt_repository_token','wt_repository_token_provider','wt_repository_credentials']);
      const wt_repository=credentials.wt_repository||{owner:'Ffive55',repo:'website-translator',branch:'main'},wt_repository_token=tokenFor(credentials,R.provider(wt_repository));
      const next = R.configuration(wt_repository);
      if (!config || C.canonical(next) !== C.canonical(config)) { config = next; invalidateCache(); }
      const identity=C.canonical([config,wt_repository_token]);
      if(clientIdentity!==identity){client = R.create({ repository: config, token: wt_repository_token, policy, getDomain: tldts.getDomain });accessKey=wt_repository_token?await D.digest(wt_repository_token):'anonymous';clientIdentity=identity;}
      const nextContext={ repository: config, targetLanguage: await language(), installations: Object.values(hooks.view().sites).filter(s => !s.deleted).map(s => ({ origin: s.origin, generation: s.generation })) },stamp=C.canonical(nextContext);
      if(stamp!==contextStamp){context=await store.setContext(nextContext);contextStamp=stamp;}
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
        done+=rows.length;startup={phase:'正在保存本机词库',done,total};await status({startup});await yieldUI();
      }
      await chrome.storage.local.set({wt_dictionary_mirror:mirrors,wt_dictionary_generations:generations});invalidateCache();
      mirrorSignature=signature;
    }
    async function captureSettings() {
      const values = await local(['wt_install_records','wt_install_observed','wt_prompt','wt_ai','wt_ai_profiles','wt_repository','wt_repository_token','wt_repository_token_provider','wt_repository_credentials']);
      let rows = values.wt_install_records || [], observed = values.wt_install_observed || {};
      const settings = { ...D.syncPreferences(await hooks.preferences()), enable_extension: (await chrome.storage.sync.get('enable_extension')).enable_extension !== false };
      await status({promptLocalOnly:D.bytes(values.wt_prompt || '')>5000});
      if (D.bytes(values.wt_prompt || '') <= 5000) settings.prompt = values.wt_prompt || C.translationPrompt;
      if(values.wt_ai){settings.aiSettings=Object.fromEntries(['provider','model','endpoint','region','reasoningEffort','apiKey'].map(k=>[k,String(values.wt_ai[k] || '')]));}
      for(const [provider,profile] of Object.entries(values.wt_ai_profiles || {}))settings['aiProfile:'+provider]=Object.fromEntries(['provider','model','endpoint','region','reasoningEffort','apiKey'].map(k=>[k,k==='provider'?provider:String(profile[k] || '')]));
      settings.dictionaryRepository=R.configuration(values.wt_repository||config);
      for(const selected of ['github','gitee'])if(Object.hasOwn(values.wt_repository_credentials||{},selected)||(values.wt_repository_token_provider||'github')===selected&&values.wt_repository_token!==undefined)settings['dictionaryToken:'+selected]=tokenFor(values,selected);
      const current = Object.entries(settings).map(([field,value]) => ({ kind:'preference',id:'settings',field,value }));
      for(const s of Object.values(hooks.view().sites)) for(const [field,value] of Object.entries({installed:!s.deleted,enabled:s.enabled,excludedPaths:s.excludedPaths,name:s.name})) current.push({kind:'site',id:s.origin,field,value});
      let counter = Math.max(0,...rows.map(r=>r.counter));
      const changes=[];
      for(const r of current) { const key=D.syncIdentity(r), value=C.canonical(r.value); if(observed[key]!==value) { changes.push({...r,counter:++counter,deviceId:hooks.deviceId()}); observed[key]=value; } }
      rows=D.mergeSync(rows,changes); await chrome.storage.local.set({wt_install_records:rows,wt_install_observed:observed}); return rows;
    }
    async function applyConnectionRows(rows){
      const values=Object.fromEntries(rows.filter(row=>row.kind==='preference').map(row=>[row.field,row.value]));
      const saved=await local(['wt_repository','wt_repository_token','wt_repository_token_provider','wt_repository_credentials']);
      const repository=R.configuration(values.dictionaryRepository||saved.wt_repository||config),credentials={...(saved.wt_repository_credentials||{})};
      const oldSelected=R.provider(saved.wt_repository),selected=R.provider(repository);
      if(!Object.hasOwn(credentials,oldSelected)&&saved.wt_repository_token!==undefined)credentials[oldSelected]=tokenFor(saved,oldSelected);
      for(const name of ['github','gitee'])if(Object.hasOwn(values,'dictionaryToken:'+name))credentials[name]=values['dictionaryToken:'+name];
      const token=credentials[selected]||'';
      const changed=C.canonical(repository)!==C.canonical(saved.wt_repository||config)||token!==tokenFor(saved,selected);
      await chrome.storage.local.set({wt_repository:repository,wt_repository_credentials:credentials,wt_repository_token:token,wt_repository_token_provider:selected});
      if(changed){discovery=null;clientIdentity=null;invalidateCache();await chrome.storage.local.remove('wt_dictionary_upload');await status({error:null,networkKind:null,networkError:null,rateLimit:null,needsAuthorization:false,networkRetryAt:0});}
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
        const merged=D.mergeSync(rows,incoming);if(C.canonical(merged)!==C.canonical(rows)||!saved.wt_install_observed){applying=true;try{await applyConnectionRows(merged);await hooks.applySync(merged);}finally{applying=false;}}rows=merged;
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
      if(!await chrome.permissions.contains({origins:[R.permission(R.provider(config))]})) { await status({error:'请在词库仓库页授予所选平台连接权限后恢复词库'}); return; }
      const wanted=new Map();for(const s of context.installations){const g=D.groupFor(s.origin,tldts.getDomain);if(!wanted.has(g))wanted.set(g,[]);wanted.get(g).push(s.origin);}
      let pin;
      for(const [group,origins] of wanted) {
        const current=await stateFor(group);
        if(current?.contentRevision && origins.every(o=>current.installedOrigins.includes(o))) continue;
        try {pin ||= await client.readIndex();await updateGroup(group,pin);}catch(e){await networkError(e);if(e.status||e.kind==='network')break;}
      }
    }
    async function networkError(error){await status({error:error.message,httpStatus:error.status||null,networkKind:error.kind||null,networkError:error.message,networkRetryAt:error.retryAt||Date.now()+60000,networkAccessKey:accessKey,requestAuthenticated:error.authenticated??accessKey!=='anonymous',rateLimit:error.rateLimit||null,needsAuthorization:['authorization','not-found'].includes(error.kind),requestId:error.requestId||null});}
    async function networkReady(extra={}){await status({error:null,networkKind:null,networkError:null,networkRetryAt:0,needsAuthorization:false,...extra});}
    async function requireNetworkBudget(){const {wt_repository_status:net={}}=await local('wt_repository_status');if(net.networkKind==='rate-limit'&&net.networkRetryAt>Date.now()&&(!net.networkAccessKey||net.networkAccessKey===accessKey)){const error=new Error(net.networkError||net.error||'GitHub 限流等待尚未结束');Object.assign(error,{kind:'rate-limit',status:net.httpStatus||403,retryAt:net.networkRetryAt,authenticated:net.requestAuthenticated,rateLimit:net.rateLimit});throw error;}}

    async function check() {
      await mirror();await requireNetworkBudget(); const lang=context.targetLanguage, groups=new Map();
      for(const s of context.installations){const g=D.groupFor(s.origin,tldts.getDomain);if(!groups.has(g))groups.set(g,[]);groups.get(g).push(s.origin);}
      const installed=[];for(const [group,origins] of groups)installed.push({group,origins,revision:(await stateFor(group))?.contentRevision});
      const result=await client.check(installed,lang);
      await chrome.storage.local.set({wt_dictionary_check:{language:lang,context:context.identity,checkedAt:Date.now(),groups:result.groups.map(({files,...g})=>g)}});
      await networkReady();
      const updates=result.groups.filter(g=>g.hasUpdate).length,failed=result.groups.filter(g=>g.status==='failed');
      return {message:'已检查，'+updates+' 个主域名有更新'+(failed.length?'；'+failed.map(g=>g.group+'：'+g.error).join('；'):''),error:failed.length>0};
    }
    async function markCheckedCurrent(group,revision,missing=[]) {
      const {wt_dictionary_check:checked}=await local('wt_dictionary_check');if(checked?.context!==context.identity)return;
      const next={...checked,groups:checked.groups.map(item=>{if(item.group!==group)return item;const {error,...rest}=item;return {...rest,status:'available',revision,missing,hasUpdate:false};})};
      if(C.canonical(next)!==C.canonical(checked))await chrome.storage.local.set({wt_dictionary_check:next});
    }
    async function updateGroup(group,pinned,interactive=false,decision={}) {
      await mirror();await requireNetworkBudget();const ctx=context,repo={...config},origins=ctx.installations.filter(s=>D.groupFor(s.origin,tldts.getDomain)===group).map(s=>s.origin);
      C.assert(origins.length,'此主域名没有已安装网址');
      const ticket=await store.beginDownload(repo,group,ctx.targetLanguage,ctx.revision);
      await status({busy:group,error:null});
      try {
        const pin=pinned||await client.readIndex(true),candidate=await client.downloadGroup(pin,group,ctx.targetLanguage,origins);
        await mirror();C.assert(context.identity===ctx.identity,'下载期间网站、语言或仓库已改变，请重新操作');
        if(interactive){
          const localStamp=databaseStamp();
          const preview=await store.preview(candidate);
          if(preview.reason || preview.comparison.conflicts.length){
            await networkReady({busy:null});
            return confirmation({direction:'update',group,candidate,ticket,commit:pin.commit,expectedRevision:preview.expectedRevision,localStamp},
              {full:!!preview.reason,reason:preview.reason || '本地与仓库修改了相同词条',conflicts:preview.comparison.conflicts.length});
          }
        }
        const result=await store.install(candidate,ctx.revision,ticket,decision);invalidateCache();
        if(result.installed)await markCheckedCurrent(group,candidate.revision,candidate.missing);
        await networkReady({busy:null});await hooks.broadcast();if(result.installed)for(const tab of await chrome.tabs.query({})){if(origins.some(o=>tab.url?.startsWith(o+'/')))chrome.tabs.sendMessage(tab.id,{type:'wt:dictionary-refresh',revision:candidate.revision}).catch(()=>{});}return result.installed?'已更新 '+group:'存在冲突，请在该分组处理';
      }catch(e){await status({busy:null});await networkError(e);throw e;}
    }
    async function summary({origin,compact=false}={}) {
      if(!active||starting)return {ready:false,starting,status:{...(await local('wt_repository_status')).wt_repository_status,startup}};
      const values=await local(['wt_dictionary_check','wt_repository_status','wt_repository_token','wt_repository_token_provider','wt_repository_credentials']);
      const {wt_dictionary_check,wt_repository_status}=values,wt_repository_token=tokenFor(values,R.provider(config));
      const groups={};if(compact)await mirror();
      const wanted=compact&&origin?D.groupFor(origin,tldts.getDomain):null;
      for(const s of context.installations){const group=D.groupFor(s.origin,tldts.getDomain);if(groups[group] || compact&&group!==wanted)continue;const state=await stateFor(group),stage=compact?null:await store.pending(config,group,context.targetLanguage);
        const pendingOrigins={};for(const key of Object.keys(state?.local || {})){const rowOrigin=JSON.parse(key)[0];if(compact&&rowOrigin!==origin)continue;pendingOrigins[rowOrigin]=(pendingOrigins[rowOrigin]||0)+1;}
        groups[group]={pending:compact?pendingOrigins[origin]||0:Object.keys(state?.local || {}).length,pendingOrigins,contentRevision:state?.contentRevision||null,conflicts:stage?.comparison.conflicts || [],installed:!!state?.contentRevision,missing:state?.missing||[],downloadedOrigins:context.installations.filter(s=>(!compact||s.origin===origin)&&D.groupFor(s.origin,tldts.getDomain)===group&&state?.files.some(f=>f.pack.origins.includes(s.origin))).map(s=>s.origin)};
      }
      return {ready:true,repository:config,hasToken:!!wt_repository_token,credentialPlatforms:Object.fromEntries(['github','gitee'].map(p=>[p,!!tokenFor(values,p)])),groups,check:!compact&&wt_dictionary_check?.context===context.identity?wt_dictionary_check:null,status:wt_repository_status};
    }
    async function enrich(site,prepared=false) {
      if(!active || starting || !site || site.deleted)return site;
      if(!prepared)await mirror();const lang=context.targetLanguage,state=await stateFor(site.group,lang);if(!state)return {...site,dictionaryAvailable:false};
      const entries={...site.entries};
      for(const [key,row] of Object.entries({...state.baseline,...state.local})) {
        const identity=JSON.parse(key);if(identity[0]!==site.origin)continue;
        if(row)entries[C.entryKey(row.entry)]=row.entry;else delete entries[C.canonical(identity.slice(1))];
      }
      return {...site,entries,dictionaryAvailable:state.files.some(f=>f.pack.origins.includes(site.origin))};
    }
    async function enrichMany(sites){if(!active||starting)return sites;await mirror();const result={};for(const [id,site] of Object.entries(sites))result[id]=await enrich(site,true);return result;}
    async function adapter(url) {
      const site=hooks.view().sites[new URL(url).origin],lang=await language();
      if(!active || !site || site.deleted || !site.enabled || lang!=='zh-Hans' || site.excludedPaths.some(p=>new URL(url).pathname.startsWith(p)) || (await chrome.storage.sync.get('enable_extension')).enable_extension===false)return null;
      const state=await stateFor(site.group,lang);
      return state?.files.find(f=>f.pack.adapter && f.pack.origins.includes(site.origin))?.pack || null;
    }
    async function configure(message) {
      const before=await local(['wt_repository','wt_repository_token','wt_repository_token_provider','wt_repository_credentials','wt_repository_status']);
      const repository=R.configuration(message.repository),selected=R.provider(repository),oldSelected=R.provider(before.wt_repository);
      C.assert(typeof message.token==='string' && message.token.length<=1000 && !/[\r\n]/.test(message.token),'仓库凭据无效');
      const credentials={...(before.wt_repository_credentials||{})};
      if(!Object.hasOwn(credentials,oldSelected))credentials[oldSelected]=tokenFor(before,oldSelected);
      if(message.token)credentials[selected]=message.token;if(message.clearToken)credentials[selected]='';
      const currentToken=credentials[selected]||'',changedCredential=tokenFor(before,oldSelected)!==currentToken||oldSelected!==selected;
      await chrome.storage.local.set({wt_repository:repository,wt_repository_credentials:credentials,wt_repository_token:currentToken,wt_repository_token_provider:selected});
      const waiting=before.wt_repository_status?.networkKind==='rate-limit'&&before.wt_repository_status.networkRetryAt>Date.now()&&!changedCredential;
      invalidateCache();if(!waiting)clientIdentity=null;await refreshContext();
      if(!waiting)await status({error:null,networkKind:null,networkError:null,rateLimit:null,needsAuthorization:false,networkRetryAt:0});
      if(C.canonical(before.wt_repository||{})!==C.canonical(repository))await chrome.storage.local.remove('wt_dictionary_upload');
      userChanged=true;scheduleRecovery(true);
      return currentToken?'已确认词库仓库及本设备凭据':'仓库地址已保存；尚未配置 '+(selected==='gitee'?'Gitee':'GitHub')+' Token，当前为匿名访问';
    }
    async function discover(message) {
      if(message.action==='repository-test'){
        const selected=R.platform(message.provider),saved=await local(['wt_repository_credentials','wt_repository_token','wt_repository_token_provider']);
        C.assert(typeof message.token==='string' && message.token.length<=1000 && !/[\r\n]/.test(message.token),'仓库凭据无效');
        const token=message.token||tokenFor(saved,selected);
        C.assert(await chrome.permissions.contains({origins:[R.permission(selected)]}),'未授予所选平台的连接权限');
        const pending=(await local('wt_dictionary_initializations')).wt_dictionary_initializations||{};
        discovery={id:crypto.randomUUID(),provider:selected,token,expires:Date.now()+15*60000,scanner:C.dictionaryDiscovery.create({provider:selected,token,getDomain:tldts.getDomain,policy,resumable:Object.values(pending)})};
      }
      const session=discovery;
      C.assert(session && session.expires>Date.now() && (message.action==='repository-test'||message.id===session.id),'仓库测试已失效，请重新测试');
      if(message.action==='repository-test-cancel'){discovery=null;return '已取消仓库测试';}
      const result=await session.scanner.next();
      C.assert(discovery===session,'仓库测试已被替换或取消');return {id:session.id,...result};
    }
    async function confirmRepository(message){
      const session=discovery;
      C.assert(session && session.id===message.id && session.expires>Date.now(),'仓库测试已失效，请重新测试');
      const repository=session.scanner.choice(message.candidateId);C.assert(repository,'请选择已通过测试的词库仓库');
      const candidate=session.scanner.candidate(message.candidateId);
      if(['empty','resume'].includes(candidate.type)){
        const key=C.canonical(repository),pending=(await local('wt_dictionary_initializations')).wt_dictionary_initializations||{};
        const writer=C.dictionaryInitialize.create({repository,token:session.token,
          beforeWrite:async()=>C.assert(discovery===session&&session.expires>Date.now(),'仓库测试已失效，初始化暂停'),
          journal:async saved=>{pending[key]=saved;await chrome.storage.local.set({wt_dictionary_initializations:pending});}});
        const progress=await writer.step(await initializationSeed(),pending[key]);
        if(!progress.done)return {initializing:true,completed:progress.completed,total:progress.total};
        const check=R.create({repository,token:session.token,getDomain:tldts.getDomain,policy}),pin=await check.readIndex(true);
        C.assert(pin.commit===progress.commit,'初始化完成后远端发生变化，请重新测试');
        await check.downloadGroup(pin,'github.com','zh-Hans',['https://github.com']);
      }
      await R.create({repository,token:session.token,getDomain:tldts.getDomain,policy}).readIndex(true);
      C.assert(discovery===session && session.expires>Date.now(),'仓库测试已失效，请重新测试');
      const result=await configure({repository,token:session.token});discovery=null;return result;
    }
    async function catalog(query) {
      await mirror();await requireNetworkBudget();const repository={...config},targetLanguage=context.targetLanguage;
      const result=await client.catalog(targetLanguage,query);await refreshContext();
      C.assert(C.canonical(config)===C.canonical(repository)&&context.targetLanguage===targetLanguage,'搜索期间仓库或目标语言已改变，请重新搜索');
      const rows=[];
      for(const row of result.rows){const state=await stateFor(row.group),missing=row.origins.filter(origin=>{const site=hooks.view().sites[origin];return !site||site.deleted||!state?.files.some(f=>f.pack.origins.includes(origin));});if(missing.length)rows.push({...row,missing});}
      await networkReady();return {...result,rows};
    }
    async function downloadPublishedGroup(group){
      D.groupId(group);await mirror();await requireNetworkBudget();const initial=context,repo={...config},language=initial.targetLanguage;
      const ticket=await store.beginDownload(repo,group,language,initial.revision);await status({busy:group,error:null});
      try{
        const pin=await client.readIndex(true),manifest=await client.manifest(pin,group),published=manifest?.languages[language]?.origins;
        C.assert(published?.length,'GitHub 暂无此主域名的当前语言词库');
        C.assert(new Set([...initial.installations.map(site=>site.origin),...published]).size<=D.limits.origins,'已添加网址数量超过上限，请先移除不用的网站');
        const origins=[...new Set([...published,...initial.installations.filter(site=>D.groupFor(site.origin,tldts.getDomain)===group).map(site=>site.origin)])].sort();
        // Validate every unique package before adding any of the group's URLs.
        const candidate=await client.downloadGroup(pin,group,language,origins);await refreshContext();C.assert(context.identity===initial.identity,'下载期间网站、仓库或语言已改变，请重新下载');
        await hooks.installOrigins(published,language,initial.installations);await mirror();const expected=context.revision;
        const result=await store.install(candidate,expected,ticket);invalidateCache();if(result.installed)await markCheckedCurrent(group,candidate.revision,candidate.missing);
        await networkReady({busy:null});await hooks.broadcast();
        if(result.installed)for(const tab of await chrome.tabs.query({}))if(origins.some(origin=>tab.url?.startsWith(origin+'/')))chrome.tabs.sendMessage(tab.id,{type:'wt:dictionary-refresh',revision:candidate.revision}).catch(()=>{});
        return result.installed?'已下载 '+group+' 词库（含全部已发布子域名）':'存在冲突，请在 '+group+' 分组处理，原有词库及本地修改保留';
      }catch(error){await status({busy:null});await networkError(error);throw error;}
    }
    async function pageStatus(origin) {
      D.origin(origin);await mirror();await requireNetworkBudget();
      C.assert(await chrome.permissions.contains({origins:['https://api.github.com/*']}),'请在 词库仓库页授予连接权限');
      const ctx=context,repo={...config},group=D.groupFor(origin,tldts.getDomain),language=ctx.targetLanguage,state=await stateFor(group),site=hooks.view().sites[origin];
      const pin=await client.readIndex(),manifest=await client.manifest(pin,group),data=manifest?.languages[language];
      const available=!!data?.origins.includes(origin),installed=!!site&&!site.deleted&&!!state?.files.some(f=>f.pack.origins.includes(origin));
      const origins=ctx.installations.filter(s=>D.groupFor(s.origin,tldts.getDomain)===group).map(s=>s.origin),files=data?D.selectFiles(manifest,language,origins):[];
      const revision=await D.digest({group,language,origins:[...origins].sort(),files});
      await refreshContext();C.assert(context.identity===ctx.identity,'当前网站或语言已改变，请重新检测词库');
      await networkReady();
      return {repository:repo,targetLanguage:language,origin,group,origins:data?.origins || [],available,installed,hasUpdate:available&&installed&&revision!==state.contentRevision};
    }
    async function prepareUpload(group, allowEmpty=false) {
      await mirror();await requireNetworkBudget();const ctx=context,state=await stateFor(group),origins=ctx.installations.filter(s=>D.groupFor(s.origin,tldts.getDomain)===group).map(s=>s.origin);
      C.assert(origins.length,'网站已移除');
      C.assert(!origins.some(origin=>Object.values(hooks.view().sites[origin]?.conflicts||{}).some(rows=>rows[0]?.targetLanguage===ctx.targetLanguage)), '旧本机词条有并发候选，请先保存人工译文解决冲突');
      const draft=await C.dictionaryPublish.prepare(client,config,state,origins,ctx.targetLanguage,tldts.getDomain,policy,{interactive:true});
      if(draft.empty&&allowEmpty)return {empty:true};
      C.assert(!draft.empty,'没有需要上传的修改');
      draft.context=ctx.identity;draft.repository=config;draft.id=crypto.randomUUID();await chrome.storage.local.set({wt_dictionary_upload:draft});
      return {id:draft.id,group,changes:draft.changes,confirmation:draft.confirmation,parent:draft.parent,expectedRevision:draft.expectedRevision,prepared:draft};
    }
    async function publishPrepared(id) {
      await mirror();await requireNetworkBudget();const {wt_dictionary_upload:draft,wt_repository_token:token,wt_dictionary_publication:previous}=await local(['wt_dictionary_upload','wt_repository_token','wt_dictionary_publication']);
      C.assert(draft?.id===id && draft.context===context.identity,'上传准备已失效，请重新点击上传');
      const state=await stateFor(draft.group);C.assert((state?.revision || 0)===draft.expectedRevision,'准备后本地有修改，请重新点击上传');
      const publisher=C.dictionaryPublish.create({repository:config,token,beforeCommit:async()=>{await mirror();C.assert(context.identity===draft.context,'上传准备期间网站或语言已改变，请重新点击上传');C.assert(((await stateFor(draft.group))?.revision||0)===draft.expectedRevision,'上传准备期间本地有新修改，未发布，请重新点击上传');},journal:saved=>chrome.storage.local.set({wt_dictionary_publication:{...saved,draftId:id,pending:!saved.rejected}})});
      const saved=previous?.draftId===id && await publisher.confirm(previous)?previous:await publisher.publish(draft);
      await updateGroup(draft.group,undefined,false,draft.confirmation?.full?{choice:'remote',full:true,expectedRevision:draft.expectedRevision}:{});await chrome.storage.local.set({wt_dictionary_publication:{...saved,draftId:id,pending:false}});await chrome.storage.local.remove('wt_dictionary_upload');await status({lastUpload:saved.commit});return '上传成功：'+saved.commit;
    }
    async function confirmTransfer(message) {
      const plan=transfers.get(message.id);transfers.delete(message.id);
      C.assert(plan && plan.expires>Date.now(),'覆盖确认已失效，请重新点击更新或上传');
      await mirror();await requireNetworkBudget();
      C.assert(context.identity===plan.context && accessKey===plan.accessKey,'确认后仓库、语言或连接已改变，请重新检测并确认');
      C.assert(((await stateFor(plan.group))?.revision || 0)===plan.expectedRevision,'确认后本地又有修改，请重新检测并确认');
      const pin=await client.readIndex(true);
      C.assert(pin.commit===plan.commit,'确认后仓库又有修改，请重新检测并确认');
      await mirror();
      C.assert(context.identity===plan.context && accessKey===plan.accessKey,'确认后仓库、语言或连接已改变，请重新检测并确认');
      C.assert(((await stateFor(plan.group))?.revision || 0)===plan.expectedRevision,'确认后本地又有修改，请重新检测并确认');
      if(plan.direction==='upload'){
        await chrome.storage.local.set({wt_dictionary_upload:plan.draft});
        await store.backup(config,plan.group,context.targetLanguage,plan.expectedRevision);
        return publishPrepared(plan.draftId);
      }
      const ctx=context,candidate=plan.candidate;
      const result=await store.install(candidate,ctx.revision,plan.ticket,{choice:'remote',full:plan.full,expectedRevision:plan.expectedRevision,guard:()=>C.assert(databaseStamp()===plan.localStamp,'确认后本地又有修改，请重新检测并确认')});
      invalidateCache();await markCheckedCurrent(plan.group,candidate.revision,candidate.missing);await networkReady({busy:null});await hooks.broadcast();
      if(result.installed)for(const tab of await chrome.tabs.query({})){try{if(D.groupFor(new URL(tab.url).origin,tldts.getDomain)===plan.group)chrome.tabs.sendMessage(tab.id,{type:'wt:dictionary-refresh',revision:candidate.revision}).catch(()=>{});}catch{}}
      return '已采用仓库内容更新 '+plan.group;
    }
    async function upload(group) {
      const previous=(await local('wt_dictionary_publication')).wt_dictionary_publication;
      if(previous?.pending){
        C.assert(C.canonical(R.configuration(previous.repository))===C.canonical(config),'另一个仓库有尚未确认的上传，请切回该仓库核查后再上传');
        const saved=await local('wt_repository_token');
        C.assert(await C.dictionaryPublish.create({repository:config,token:saved.wt_repository_token}).confirm(previous),'上次上传结果尚未确认，请稍后重试核查');
        await updateGroup(previous.group);await chrome.storage.local.set({wt_dictionary_publication:{...previous,pending:false}});await chrome.storage.local.remove('wt_dictionary_upload');
      }
      const {wt_repository_token:token}=await local('wt_repository_token');C.assert(token,'请先在 GitHub 仓库页配置本设备的写入凭据');
      try {
        const draft=await prepareUpload(group,true);
        if(draft.empty){await updateGroup(group);return group+' 的本地修改已在远端，已同步本机基线';}
        if(draft.confirmation)return confirmation({direction:'upload',group,draftId:draft.id,draft:draft.prepared,commit:draft.parent,expectedRevision:draft.expectedRevision},draft.confirmation);
        await publishPrepared(draft.id);return '已上传 '+group;
      } catch(error) {
        if(error.kind==='dictionary-conflict'){
          await updateGroup(group);
          throw new Error(group+' 的本地与远端修改存在冲突，已保留双方内容；请展开该分组处理后再上传');
        }
        throw error;
      }
    }
    async function uploadAll() {
      await mirror();const info=await summary();
      return {batch:{direction:'upload',context:context.identity,groups:Object.entries(info.groups).filter(([,data])=>data.pending).map(([group])=>group)}};
    }

    async function handle(message) {
      if(['repository-test','repository-test-next','repository-test-cancel'].includes(message.action))return discover(message);
      return serial(async()=>{
        if(message.batchContext){await mirror();C.assert(context.identity===message.batchContext,'批量操作期间网站、仓库或目标语言已改变，请重新操作');}
        if(message.action==='repository-clear-token'){
          discovery=null;
          const selected=R.platform(message.provider),saved=await local(['wt_repository_credentials']);
          if(selected===R.provider(config))return configure({repository:config,token:'',clearToken:true});
          await chrome.storage.local.set({wt_repository_credentials:{...(saved.wt_repository_credentials||{}),[selected]:''}});discovery=null;userChanged=true;scheduleRecovery(true);return '已清除本平台令牌';
        }
        if(message.action==='repository-confirm')return confirmRepository(message);
        if(message.action==='configure')return configure(message);
        if(message.action==='check')return check();
        if(message.action==='catalog')return catalog(message.query||'');
        if(message.action==='download-group')return downloadPublishedGroup(message.group);
        if(message.action==='page-status')return pageStatus(message.origin);
        if(message.action==='transfer-confirm')return confirmTransfer(message);
        if(message.action==='transfer-cancel'){transfers.delete(message.id);return '已取消覆盖';}
        if(message.action==='update')return updateGroup(message.group,undefined,true);
        if(message.action==='all'){await mirror();const info=await summary();return {batch:{direction:'update',context:context.identity,groups:(info.check?.groups || []).filter(g=>g.hasUpdate).map(g=>g.group)}};}
        if(message.action==='upload')return upload(message.group);
        if(message.action==='upload-all')return uploadAll();
        if(message.action==='resolve'){await mirror();const result=await store.resolve(config,message.group,context.targetLanguage,message.key,message.choice,message.edited,context.revision);invalidateCache();if(result.installed){const current=await stateFor(message.group);await markCheckedCurrent(message.group,current.contentRevision,current.missing);}await hooks.broadcast();if(result.installed)for(const tab of await chrome.tabs.query({})){try{if(D.groupFor(new URL(tab.url).origin,tldts.getDomain)===message.group)chrome.tabs.sendMessage(tab.id,{type:'wt:dictionary-refresh',revision:(await stateFor(message.group)).contentRevision}).catch(()=>{});}catch{}}return result.installed?'冲突已解决，词库已更新':'已处理，请继续解决剩余冲突';}
        if(message.action==='delete-entry'){await mirror();await store.edit(config,message.group,context.targetLanguage,{...message.row,deleted:true},context.revision);invalidateCache();await hooks.broadcast();return '词条已标记删除，上传后同步到词库仓库';}
        if(message.action==='restore')return restore();
        if(message.action==='sync')return sync(true);
        throw new Error('未知词库操作');
      }).catch(async error=>{if(error.status||['rate-limit','network','authorization','not-found'].includes(error.kind))await networkError(error);throw error;});
    }
    let recoveryQueued=false,recoveryAgain=false,recoveryReceive=false;
    function scheduleRecovery(receive){recoveryReceive ||= receive;if(recoveryQueued){recoveryAgain=true;return;}recoveryQueued=true;serial(async()=>{const incoming=recoveryReceive;recoveryReceive=false;await sync(incoming);if(!incoming)await restore();}).catch(e=>status({syncError:e.message})).finally(()=>{recoveryQueued=false;if(recoveryAgain){recoveryAgain=false;scheduleRecovery(recoveryReceive);}});}
    function changed(){if(!active || applying)return;userChanged=true;invalidateCache();clearTimeout(timer);timer=setTimeout(()=>scheduleRecovery(false),500);}
    async function start() {
      starting=true;startup={phase:'正在加载本机词库',done:0,total:hooks.database().ops.length};await status({startup});await yieldUI();
      try {
      policy=await(await fetch(chrome.runtime.getURL('managed/dictionary-policy.json'))).json();
      store?.close();contextStamp=null;store=await C.dictionaryStore.open({getDomain:tldts.getDomain,policy});await refreshContext();
      await mirror();active=true;starting=false;startup={phase:'本机词库已就绪',done:1,total:1};await status({startup,error:null});await hooks.broadcast();
      await chrome.alarms.clear('wt-sync-retry');chrome.alarms.create('wt-dictionary-recover',{periodInMinutes:2});
      scheduleRecovery(true);
      }catch(error){starting=false;active=false;startup={phase:'本机词库初始化未完成',error:error.message};await status({startup,error:error.message});throw error;}
    }
    chrome.storage.onChanged.addListener((changes,area)=>{if(!active)return;if(area==='sync' && Object.keys(changes).some(k=>k.startsWith('wt_install_')))scheduleRecovery(true);else if(area==='sync' && changes.enable_extension)changed();});
    chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name==='wt-dictionary-recover')scheduleRecovery(true);});
    return {start,changed,summary,enrich,enrichMany,adapter,handle,active:()=>active&&!starting};
  }
  globalThis.WTDictionaryRuntime={create};
})();
