'use strict';
// Isolated Edge extension; every GitHub request is intercepted inside the fixture worker.
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),D=require('../extension/dictionary-core');
const ROOT=path.resolve(__dirname,'..');
async function main(){
 const output=path.join(ROOT,'.cache/dictionary-runtime'),fixture=path.join(output,'extension');await fs.mkdir(output,{recursive:true});
 await fs.cp(path.join(ROOT,'edge'),fixture,{recursive:true,filter:p=>!p.includes(path.sep+'local-helper')});
 const origin='https://runtime.example.com',group='example.com';
 const row=translation=>({site:origin,entry:{sourceText:'Save',context:'main/button/text',path:'/',sourceLanguage:null,targetLanguage:'zh-Hans',category:'ui',action:'translate',translation,origin:'ai'}});
 const pack={schemaVersion:1,minReaderVersion:1,group,targetLanguage:'zh-Hans',origins:[origin],kind:'entries',records:[row('远端基础')],adapter:null};
 const raw=JSON.stringify(pack),description={id:'runtime.example.com',path:'dictionaries/example.com/zh-Hans/runtime.example.com.json',kind:'entries',origins:[origin],sha256:await D.digest(raw),bytes:D.bytes(raw),requires:[]};
 const content={origins:[origin],files:[description]},manifest={schemaVersion:1,minReaderVersion:1,group,languages:{'zh-Hans':{...content,revision:await D.digest(content)}}},manifestRaw=JSON.stringify(manifest);
 const index={schemaVersion:1,minReaderVersion:1,groups:[{group,manifest:{path:'dictionaries/example.com/manifest.json',bytes:D.bytes(manifestRaw),sha256:await D.digest(manifestRaw)},languages:{'zh-Hans':manifest.languages['zh-Hans'].revision}}]};
 const data={'dictionaries/index.json':JSON.stringify(index),'dictionaries/example.com/manifest.json':manifestRaw,[description.path]:raw};
 // Include actual adapters to verify asynchronous site/GitHub hydration, not only protocol data.
 const realIndex=JSON.parse(await fs.readFile(path.join(ROOT,'dictionaries/index.json'),'utf8'));
 for(const g of realIndex.groups){data[g.manifest.path]=await fs.readFile(path.join(ROOT,g.manifest.path),'utf8');const m=JSON.parse(data[g.manifest.path]);for(const l of Object.values(m.languages))for(const f of l.files)data[f.path]=await fs.readFile(path.join(ROOT,f.path),'utf8');index.groups.push(g);}
 data['dictionaries/index.json']=JSON.stringify(index);
 const mock=`
const originalFetch=globalThis.fetch.bind(globalThis);
globalThis.__remote={head:'a'.repeat(40),versions:{},writes:[],next:1};__remote.versions[__remote.head]=${JSON.stringify(data)};
globalThis.fetch=async(url,options={})=>{
 if(!String(url).startsWith('https://api.github.com/'))return originalFetch(url,options);
 const u=new URL(url),p=u.pathname.replace('/repos/Ffive55/website-translator',''),method=options.method||'GET';
 if(!options.headers?.Authorization)return new Response('{}',{status:401});
 const body=options.body?JSON.parse(options.body):null;let result;
 if(method!=='GET')__remote.writes.push({path:p,method,body});
 if(p.startsWith('/git/ref')){if(method==='PATCH'){if(__remote.head!==__remote.parent)return new Response('{}',{status:422});__remote.head=body.sha;}result={ref:'refs/heads/main',object:{sha:__remote.head,type:'commit'}};}
 else if(p.startsWith('/contents/')){const name=decodeURIComponent(p.slice(10)),text=__remote.versions[u.searchParams.get('ref')]?.[name];return new Response(text||'{}',{status:text?200:404});}
 else if(p.startsWith('/git/commits/')&&method==='GET')result={tree:{sha:__remote.head}};
 else if(p==='/git/trees'){__remote.tree={...__remote.versions[body.base_tree]};for(const item of body.tree)__remote.tree[item.path]=item.content;result={sha:'e'.repeat(40)};}
 else if(p==='/git/commits'){__remote.parent=body.parents[0];const sha=(++__remote.next).toString(16).padStart(40,'0');__remote.versions[sha]=__remote.tree;result={sha};}
 else if(p.startsWith('/compare/'))result={status:'ahead'};
 else return new Response('{}',{status:404});return new Response(JSON.stringify(result));
};
`;
 const workerFile=path.join(fixture,'managed/worker.js');await fs.writeFile(workerFile,mock+await fs.readFile(workerFile,'utf8'));
 const m=JSON.parse(await fs.readFile(path.join(fixture,'manifest.json'),'utf8'));m.host_permissions.push(origin+'/*');await fs.writeFile(path.join(fixture,'manifest.json'),JSON.stringify(m));
 const context=await chromium.launchPersistentContext(path.join(output,'profile-'+Date.now()),{channel:'msedge',headless:true,args:[`--disable-extensions-except=${fixture}`,`--load-extension=${fixture}`]});
 context.on('page',p=>{p.on('pageerror',e=>console.error('[pageerror]',e.message));p.on('console',m=>{if(m.type()==='error')console.error('[page]',m.text());});});
 const checks=[],check=(value,name)=>{assert.ok(value,name);checks.push(name);console.log('PASS '+name);};
 try{
  let worker=context.serviceWorkers()[0];if(!worker)worker=await context.waitForEvent('serviceworker');
  const id=worker.url().split('/')[2],ui=await context.newPage();await ui.goto(`chrome-extension://${id}/managed/managed.html`);
  const rpc=(type,args={})=>ui.evaluate(async({type,args})=>{const r=await chrome.runtime.sendMessage({type:'wt:'+type,...args});if(!r.ok)throw Error(r.error);return r.result;},{type,args});
  const command=args=>rpc('dictionary-action',args);
  const wait=async predicate=>{for(let i=0;i<200;i++){const s=await rpc('state');if(predicate(s))return s;await new Promise(r=>setTimeout(r,50));}throw Error('等待词库状态超时');};
  await rpc('state');await command({action:'configure',repository:{owner:'Ffive55',repo:'website-translator',branch:'main'},token:'fixture-only'});
  check((await rpc('state')).dictionary.ready,'实际后台启动迁移与新词库服务');
  await rpc('install',{origin});await command({action:'update',group});
  let state=await rpc('state');check(state.dictionary.groups[group].installed,'实际安装入口下载并安装已选网址');
  await context.route(origin+'/**',r=>r.fulfill({contentType:'text/html',body:'<html lang="en"><body><main><button>Save</button><input value="private-input"><pre>private-code</pre></main></body></html>'}));
  const page=await context.newPage();await page.goto(origin+'/');await page.waitForFunction(()=>document.querySelector('button').textContent==='远端基础');check(true,'实际内容脚本从已下载词库翻译，不调用 AI');
  await rpc('change',{siteId:origin,kind:'entry',payload:{...row('本地人工').entry,origin:'manual',userSelected:true}});await page.waitForFunction(()=>document.querySelector('button').textContent==='本地人工');
  check(await page.locator('input').inputValue()==='private-input' && await page.locator('pre').textContent()==='private-code','本地编辑即时应用，输入和代码保持原样');
  await command({action:'check'});check(!(await rpc('state')).dictionary.check.groups.find(g=>g.group===group).hasUpdate,'检查更新依据词库内容，不受本地修改影响');
  const preview=await command({action:'preview',group});check(preview.changes.length===1,'上传预览只包含本地新增和修改');
  await command({action:'publish',id:preview.id});state=await rpc('state');check(state.dictionary.groups[group].pending===0,'实际 Git 提交流程成功后推进基线并清除已上传修改');
  check(await worker.evaluate(()=>__remote.writes.filter(w=>w.path==='/git/trees').every(w=>w.body.tree.every(f=>f.path.startsWith('dictionaries/')))&&__remote.writes.find(w=>w.method==='PATCH').body.force===false),'上传只写词库目录，词库及索引同提交且不强制覆盖');
  await rpc('change',{siteId:origin,kind:'entry',payload:{...row('第二次人工').entry,origin:'manual'}});
  const stale=await command({action:'preview',group});await rpc('change',{siteId:origin,kind:'entry',payload:{...row('预览后修改').entry,origin:'manual'}});
  let rejected=false;try{await command({action:'publish',id:stale.id});}catch{rejected=true;}check(rejected,'预览后的新编辑使旧上传失效');
  await rpc('change',{siteId:origin,kind:'setting',payload:{key:'enabled',value:false}});await page.waitForFunction(()=>document.querySelector('button').textContent==='Save');check(await page.locator('html').getAttribute('lang')==='en','停用立即恢复原文及语言');
  const synced=await worker.evaluate(async()=>{await new Promise(r=>setTimeout(r,1200));return chrome.storage.sync.get(null);});check(!!synced.wt_install_head&&!JSON.stringify(synced).includes('fixture-only'),'真实 storage.sync 写入安装清单，不含 GitHub 凭据');
  for(const origin of ['https://tailscale.com','https://github.com']){await rpc('install',{origin});await command({action:'update',group:new URL(origin).hostname});}
  await context.route('https://tailscale.com/**',r=>r.fulfill({contentType:'text/html',body:'<html lang="en"><body><nav><button>Pricing</button></nav></body></html>'}));
  const tailscale=await context.newPage();await tailscale.goto('https://tailscale.com/');await tailscale.waitForFunction(()=>document.querySelector('button').textContent==='价格');check(true,'真实旧网站适配器从 JSON 异步加载后执行');
  await context.route('https://github.com/**',r=>r.fulfill({contentType:'text/html',body:'<html lang="en"><head><title>GitHub</title></head><body><header><a>Pull requests</a></header></body></html>'}));
  const github=await context.newPage();await github.goto('https://github.com/');await github.waitForFunction(()=>document.querySelector('a').textContent!=='Pull requests');check(true,'GitHub 专用引擎从 JSON 加载，未加载 locals.js');
  await ui.locator('#tab-websites').click();await ui.locator('#dictionaryCheck').click();await ui.waitForFunction(()=>document.querySelector('#message').textContent.includes('已检查'));
  check(await ui.locator('#tab-sync').textContent()==='词库上传','管理界面已替换 OneDrive 常规入口');
  check(await worker.evaluate(async()=>!(await chrome.storage.local.get('wt_tasks')).wt_tasks || !Object.keys((await chrome.storage.local.get('wt_tasks')).wt_tasks).length),'迁移、下载和上传全过程未建立 AI 任务');
  await worker.evaluate(async()=>{const D=WTCore.dictionary,current=structuredClone(__remote.versions[__remote.head]),index=JSON.parse(current['dictionaries/index.json']);const item=index.groups.find(g=>g.group==='example.com'),manifest=JSON.parse(current[item.manifest.path]),data=manifest.languages['zh-Hans'],file=data.files.find(f=>f.kind==='entries');const pack=JSON.parse(current[file.path]);pack.records[0].entry.translation='远端新版';current[file.path]=JSON.stringify(pack,null,2)+'\n';file.bytes=D.bytes(current[file.path]);file.sha256=await D.digest(current[file.path]);data.revision=await D.digest({origins:data.origins,files:data.files});current[item.manifest.path]=JSON.stringify(manifest,null,2)+'\n';item.languages['zh-Hans']=data.revision;item.manifest.bytes=D.bytes(current[item.manifest.path]);item.manifest.sha256=await D.digest(current[item.manifest.path]);current['dictionaries/index.json']=JSON.stringify(index);__remote.head='f'.repeat(40);__remote.versions[__remote.head]=current;});
  await command({action:'check'});await ui.reload();await ui.locator('#tab-websites').click();
  await ui.locator('#dictionaryAll').waitFor({state:'visible'});check(await ui.locator('.group-actions').getByRole('button',{name:'更新',exact:true}).count()===1,'有新版时显示全部更新，单独更新只位于对应主域名分组行');
  await ui.screenshot({path:path.join(output,'updates.png'),fullPage:true});
  await command({action:'update',group});state=await rpc('state');check(state.dictionary.groups[group].conflicts.length===1,'真实下载遇到同条本地/远端修改时保留冲突候选');
  const conflict=state.dictionary.groups[group].conflicts[0];await command({action:'resolve',group,key:conflict.key,choice:'remote'});state=await rpc('state');check(!state.dictionary.groups[group].conflicts.length&&state.dictionary.groups[group].pending===0,'实际冲突选择采用远端后原子切换，不重新生成译文');
  await rpc('change',{siteId:origin,kind:'entry',payload:{...row('仅本机保留').entry,sourceText:'Unpublished',origin:'manual'}});
  const oldConflicts=await worker.evaluate(async origin=>{const {wt_database:db}=await chrome.storage.local.get('wt_database'),create=db.ops.find(o=>o.kind==='create'&&o.siteId===origin);return ['旧人工一','旧人工二'].map(translation=>{const deviceId=crypto.randomUUID();return {schemaVersion:1,deviceId,seq:1,opId:deviceId+'-1',deps:[create.opId],siteId:origin,generation:create.generation,kind:'entry',payload:{sourceText:'Legacy conflict',context:'main/button/text',path:'/',sourceLanguage:null,targetLanguage:'zh-Hans',category:'ui',action:'translate',translation,origin:'manual'}};});},origin);
  await command({action:'import-legacy',ops:oldConflicts});let blocked=false;try{await command({action:'preview',group});}catch{blocked=true;}check(blocked,'旧数据库并发人工候选未解决时禁止任意选择后上传');
  await rpc('change',{siteId:origin,kind:'entry',payload:{...row('最终人工').entry,sourceText:'Legacy conflict',origin:'manual'}});check(!Object.keys((await rpc('state')).sites[origin].conflicts).length,'显式保存人工译文解决旧并发候选');
  await command({action:'configure',repository:{owner:'Ffive55',repo:'another-dictionary',branch:'main'},token:'fixture-only'});await rpc('state');await command({action:'configure',repository:{owner:'Ffive55',repo:'website-translator',branch:'main'},token:'fixture-only'});state=await rpc('state');check(Object.values(state.sites[origin].entries).some(e=>e.translation==='远端新版')&&!Object.values(state.sites[origin].entries).some(e=>e.translation==='预览后修改'),'切换仓库再返回不重放已放弃的旧人工译文');
  const portableBackup=await command({action:'backup'});
  await command({action:'sync'});
  const latestSync=await worker.evaluate(async()=>{await new Promise(r=>setTimeout(r,1000));return chrome.storage.sync.get(null);});
  const latestRemote=await worker.evaluate(()=>__remote);
  await ui.screenshot({path:path.join(output,'management.png'),fullPage:true});
  await context.close();
  const secondMock=mock.replace(JSON.stringify(data),()=>JSON.stringify(latestRemote.versions[latestRemote.head])).replace("head:'a'.repeat(40)",'head:'+JSON.stringify(latestRemote.head));
  await fs.writeFile(workerFile,secondMock+(await fs.readFile(path.join(ROOT,'edge/managed/worker.js'),'utf8')));
  const second=await chromium.launchPersistentContext(path.join(output,'second-profile-'+Date.now()),{channel:'msedge',headless:true,args:[`--disable-extensions-except=${fixture}`,`--load-extension=${fixture}`]});
  try{
    let secondWorker=second.serviceWorkers()[0];if(!secondWorker)secondWorker=await second.waitForEvent('serviceworker',{timeout:15000});
    let secondUI=await second.newPage();await secondUI.goto(`chrome-extension://${id}/managed/managed.html`);
    const secondRPC=(type,args={})=>secondUI.evaluate(async({type,args})=>{const r=await chrome.runtime.sendMessage({type:'wt:'+type,...args});if(!r.ok)throw Error(r.error);return r.result;},{type,args});
    await secondRPC('state');await secondWorker.evaluate(values=>chrome.storage.sync.set(values),latestSync);
    await secondRPC('dictionary-action',{action:'configure',repository:{owner:'Ffive55',repo:'website-translator',branch:'main'},token:'fixture-second-only'});
    let restored;for(let i=0;i<100;i++){restored=await secondRPC('state');if(restored.dictionary.groups[group]?.installed&&Object.values(restored.sites[origin]?.entries||{}).some(e=>e.translation==='远端新版'))break;await new Promise(r=>setTimeout(r,100));}
    if(!restored.dictionary.groups[group]?.installed)console.log('RECOVERY',JSON.stringify({dictionary:restored.dictionary,sites:Object.keys(restored.sites)}));
    check(restored.dictionary.groups[group]?.installed&&restored.sites[origin]?.enabled===false,'第二个隔离设备从同步清单自动恢复词库，停用状态保留');
    check(Object.values(restored.sites[origin].entries).some(e=>e.translation==='远端新版')&&!Object.values(restored.sites[origin].entries).some(e=>e.translation==='仅本机保留'),'新设备仅恢复已上传词条，未上传修改留在原设备');
    check((await secondWorker.evaluate(()=>__remote.writes.length))===0,'新设备恢复只读取 GitHub，不触发上传或 AI');
    await secondWorker.evaluate(()=>{const write=chrome.storage.local.set.bind(chrome.storage.local);let first=true;chrome.storage.local.set=async values=>{if(first&&values.wt_database&&(await chrome.storage.local.get('wt_dictionary_import')).wt_dictionary_import){first=false;throw Error('fixture interrupted local database commit');}return write(values);};});
    let interrupted=false;try{await secondRPC('dictionary-action',{action:'import-file',value:portableBackup});}catch{interrupted=true;}check(interrupted,'IndexedDB 写入后浏览器数据库失败时不虚报导入成功');
    const journal=await secondWorker.evaluate(()=>chrome.storage.local.get('wt_dictionary_import'));check(!!journal.wt_dictionary_import?.before?.database,'中断导入保留持久化恢复日志和导入前数据');
    let unsafeEdit=false;try{await secondRPC('change',{siteId:origin,kind:'entry',payload:{...row('不得写入').entry,origin:'manual'}});}catch{unsafeEdit=true;}check(unsafeEdit,'未完成导入期间禁止其他词条写入');
    const reloadWorker=second.waitForEvent('serviceworker',{timeout:15000});await secondWorker.evaluate(()=>chrome.runtime.reload()).catch(()=>{});secondWorker=await reloadWorker;secondUI=await second.newPage();await secondUI.goto(`chrome-extension://${id}/managed/managed.html`);let imported;for(let i=0;i<200;i++){imported=await secondRPC('state');if(imported.dictionary.ready)break;await new Promise(r=>setTimeout(r,50));}check(imported.dictionary.groups[group].pending>=2,'重新加载自动恢复中断导入，未上传词条仍计入待上传');
    check(Object.values(imported.sites[origin].entries).some(e=>e.translation==='仅本机保留')&&Object.values(imported.sites[origin].entries).some(e=>e.translation==='远端新版'),'导出/导入保留未上传修改和已解决的远端基线，不复活旧人工结果');
  }finally{await second.close();}
  await fs.writeFile(path.join(output,'result.json'),JSON.stringify({checks,count:checks.length},null,2));
 }finally{await context.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
