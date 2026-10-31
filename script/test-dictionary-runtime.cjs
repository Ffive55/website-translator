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
 if(String(url).startsWith('https://gitee.com/api/v5/')){
  const u=new URL(url),p=u.pathname.slice('/api/v5'.length),method=options.method||'GET';
  if(options.headers?.Authorization!=='Bearer fixture-gitee')throw Error('Gitee received wrong provider token');
  if(p==='/user')return new Response(JSON.stringify({login:'fixture'}));
  if(p==='/user/repos')return new Response(JSON.stringify([{full_name:'fixture/dictionary',default_branch:'main',private:true,permission:{push:true}},{full_name:'fixture/empty',default_branch:null}]));
  if(p.startsWith('/repos/fixture/empty')){
   const init=globalThis.__initial ||= {head:null,files:{},versions:{},writes:[],lose:true},part=p.slice('/repos/fixture/empty'.length);
   const json=(value,status=200)=>new Response(JSON.stringify(value),{status});
   if(part==='')return json({full_name:'fixture/empty',permission:{push:true}});
   if(part==='/branches')return json(init.head?[{name:'main',commit:{sha:init.head}}]:[]);
   if(part==='/tags')return json([]);
   if(part==='/branches/main')return init.head?json({name:'main',commit:{sha:init.head}}):json({},404);
   if(part.startsWith('/git/trees/')){
    const tree=await Promise.all(Object.entries(init.files).map(async([path,raw])=>{
     const bytes=new TextEncoder().encode(raw),prefix=new TextEncoder().encode('blob '+bytes.length+'\\0'),all=new Uint8Array(prefix.length+bytes.length);all.set(prefix);all.set(bytes,prefix.length);
     const sha=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-1',all)),v=>v.toString(16).padStart(2,'0')).join('');return {path,mode:'100644',type:'blob',sha};
    }));return json({tree,truncated:false});
   }
   if(part.startsWith('/contents/')&&method==='POST'){
    const path=decodeURIComponent(part.slice(10)),body=JSON.parse(options.body);if(Object.hasOwn(init.files,path))return json({},422);
    init.writes.push(path);init.files[path]=new TextDecoder().decode(Uint8Array.from(atob(body.content),c=>c.charCodeAt(0)));init.head=(init.writes.length+200).toString(16).padStart(40,'0');init.versions[init.head]={...init.files};
    if(init.lose){init.lose=false;throw Error('fixture lost response');}return json({commit:{sha:init.head}},201);
   }
   if(part.startsWith('/raw/')){const raw=init.versions[u.searchParams.get('ref')]?.[decodeURIComponent(part.slice(5))];return new Response(raw||'{}',{status:raw?200:404});}
   return json({},404);
  }
  if(!globalThis.__gitee){
   const D=WTCore.dictionary,files=structuredClone(__remote.versions[__remote.head]),index=JSON.parse(files['dictionaries/index.json']),item=index.groups.find(g=>g.group==='example.com'),manifest=JSON.parse(files[item.manifest.path]),data=manifest.languages['zh-Hans'],entry=data.files.find(f=>f.id==='managed-entries');
   // Existing dictionaries may use another entries filename: first upload must
   // create managed-entries.json despite Contents returning HTTP 200 + [].
   if(entry){const previous=entry.path;entry.id='remote-entries';entry.path=previous.replace('managed-entries.json','remote-entries.json');files[entry.path]=files[previous];delete files[previous];data.revision=await D.digest({origins:data.origins,files:data.files});files[item.manifest.path]=JSON.stringify(manifest);item.manifest.bytes=D.bytes(files[item.manifest.path]);item.manifest.sha256=await D.digest(files[item.manifest.path]);item.languages['zh-Hans']=data.revision;files['dictionaries/index.json']=JSON.stringify(index);}
   globalThis.__gitee={head:'a'.repeat(40),versions:{['a'.repeat(40)]:files},history:[],writes:[]};
  }
  const remote=globalThis.__gitee;
  const path=p.replace('/repos/fixture/dictionary','');
  if(path==='/branches/main')return new Response(JSON.stringify({name:'main',commit:{sha:remote.head}}));
  if(path.startsWith('/raw/')){const raw=remote.versions[u.searchParams.get('ref')]?.[decodeURIComponent(path.slice(5))];return new Response(raw||'{}',{status:raw?200:404});}
  if(path.startsWith('/contents/')){const filePath=decodeURIComponent(path.slice(10)),raw=remote.versions[u.searchParams.get('ref')]?.[filePath];return new Response(JSON.stringify(raw?{type:'file',path:filePath,sha:'c'.repeat(40)}:[]));}
  if(path==='/commits'&&method==='GET')return new Response(JSON.stringify(u.searchParams.has('path')?[{sha:remote.head}]:remote.history));
  if(path==='/commits'&&method==='POST'){
    const body=JSON.parse(options.body),sha=(remote.writes.length+100).toString(16).padStart(40,'0');remote.writes.push(body);
    const files={...remote.versions[remote.head]};for(const action of body.actions){if(action.action==='update'&&action.last_commit_id!==remote.head)return new Response('{}',{status:422});files[action.path]=action.content;}
    remote.versions[sha]=files;remote.head=sha;remote.history.unshift({sha,commit:{message:body.message}});return new Response(JSON.stringify({sha}),{status:201});
  }
  return new Response('{}',{status:404});
 }
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
 const m=JSON.parse(await fs.readFile(path.join(fixture,'manifest.json'),'utf8'));m.host_permissions.push(origin+'/*','https://gitee.com/*');await fs.writeFile(path.join(fixture,'manifest.json'),JSON.stringify(m));
 const context=await chromium.launchPersistentContext(path.join(output,'profile-'+Date.now()),{channel:'msedge',headless:true,args:[`--disable-extensions-except=${fixture}`,`--load-extension=${fixture}`]});
 context.on('page',p=>{p.on('pageerror',e=>console.error('[pageerror]',e.message));p.on('console',m=>{if(m.type()==='error')console.error('[page]',m.text());});});
 const checks=[],check=(value,name)=>{assert.ok(value,name);checks.push(name);console.log('PASS '+name);};
 try{
  let worker=context.serviceWorkers()[0];if(!worker)worker=await context.waitForEvent('serviceworker');
  const id=worker.url().split('/')[2],ui=await context.newPage();await ui.goto(`chrome-extension://${id}/managed/managed.html`);
  const rpc=(type,args={})=>ui.evaluate(async({type,args})=>{const r=await chrome.runtime.sendMessage({type:'wt:'+type,...args});if(!r.ok)throw Error(r.error);return r.result;},{type,args});
  const command=args=>rpc('dictionary-action',args);
  const openPopup=async()=>{
    const popup=await context.newPage();
    // The real action popup queries its hosting page. This fixture opens it in
    // a tab, so supply that page explicitly while leaving background APIs real.
    await popup.addInitScript(origin=>{const query=chrome.tabs.query.bind(chrome.tabs);chrome.tabs.query=options=>options.active?Promise.resolve([{id:1,url:origin+'/'}]):query(options);},origin);
    await popup.goto(`chrome-extension://${id}/popup/popup.html`);return popup;
  };
  const wait=async predicate=>{for(let i=0;i<200;i++){const s=await rpc('state');if(predicate(s))return s;await new Promise(r=>setTimeout(r,50));}throw Error('等待词库状态超时');};
  await rpc('state');await command({action:'configure',repository:{owner:'Ffive55',repo:'website-translator',branch:'main'},token:'fixture-only'});
  check((await rpc('state')).dictionary.ready,'实际后台加载当前本机词库服务');
  let popup=await openPopup();await popup.locator('#wtDictionaryDownload').waitFor({state:'visible'});check(true,'弹窗按当前网页检测 GitHub 词库，未下载时显示下载按钮');
  await popup.locator('#wtDictionaryDownload').click();await popup.waitForFunction(()=>document.querySelector('#message').textContent.startsWith('已下载 example.com'));
  let state=await rpc('state');check(state.dictionary.groups[group].installed,'实际安装入口下载并安装已选网址');
  await context.route(origin+'/**',r=>r.fulfill({contentType:'text/html',body:'<html lang="en"><body><main><button>Save</button><input value="private-input"><pre>private-code</pre></main></body></html>'}));
  const page=await context.newPage();await page.goto(origin+'/');await page.waitForFunction(()=>document.querySelector('button').textContent==='远端基础');check(true,'实际内容脚本从已下载词库翻译，不调用 AI');
  await rpc('change',{siteId:origin,kind:'entry',payload:{...row('本地人工').entry,origin:'manual',userSelected:true}});await page.waitForFunction(()=>document.querySelector('button').textContent==='本地人工');
  check(await page.locator('input').inputValue()==='private-input' && await page.locator('pre').textContent()==='private-code','本地编辑即时应用，输入和代码保持原样');
  await command({action:'check'});check(!(await rpc('state')).dictionary.check.groups.find(g=>g.group===group).hasUpdate,'检查更新依据词库内容，不受本地修改影响');
  await ui.locator('#tab-websites').click();await ui.getByRole('button',{name:'上传 example.com 词库',exact:true}).click();
  await ui.waitForFunction(()=>document.querySelector('#message').textContent==='已上传 example.com');state=await rpc('state');check(state.dictionary.groups[group].pending===0,'主域名行点击直接上传，Git 提交成功后推进基线并清除已上传修改');
  await rpc('change',{siteId:origin,kind:'entry',payload:{...row('弹窗上传人工').entry,origin:'manual'}});await popup.locator('#wtDictionaryUpload').waitFor({state:'visible'});
  await popup.locator('#wtDictionaryUpload').click();await popup.waitForFunction(()=>document.querySelector('#message').textContent==='已上传 example.com');check((await rpc('state')).dictionary.groups[group].pending===0,'弹窗检测本地待上传修改并直接上传，完成后待上传归零');
  await popup.locator('#wtSiteToggle').click();await page.waitForFunction(()=>document.querySelector('button').textContent==='Save');check((await rpc('state')).sites[origin].enabled===false&&(await rpc('state')).globalEnabled,'弹窗停用只作用于当前网址，恢复原文并保留总开关');
  await popup.locator('#wtSiteToggle').click();await page.waitForFunction(()=>document.querySelector('button').textContent==='弹窗上传人工');check((await rpc('state')).sites[origin].enabled===true,'弹窗启用立即复用本机词库，不调用 AI');await popup.close();
  check(await ui.locator('#uploadPreview,#uploadGroups,#dictionaryBackup,#dictionaryImport').count()===0,'旧预览、备份和迁移导入界面已删除');
  check(await worker.evaluate(()=>__remote.writes.filter(w=>w.path==='/git/trees').every(w=>w.body.tree.every(f=>f.path.startsWith('dictionaries/')))&&__remote.writes.find(w=>w.method==='PATCH').body.force===false),'上传只写词库目录，词库及索引同提交且不强制覆盖');
  await rpc('change',{siteId:origin,kind:'entry',payload:{...row('第二次人工').entry,origin:'manual'}});
  await rpc('change',{siteId:origin,kind:'entry',payload:{...row('上传前修改').entry,origin:'manual'}});
  await rpc('change',{siteId:origin,kind:'setting',payload:{key:'enabled',value:false}});await page.waitForFunction(()=>document.querySelector('button').textContent==='Save');check(await page.locator('html').getAttribute('lang')==='en','停用立即恢复原文及语言');
  const synced=await worker.evaluate(async()=>{await new Promise(r=>setTimeout(r,1200));return chrome.storage.sync.get(null);});check(!!synced.wt_install_head&&JSON.stringify(synced).includes('fixture-only'),'真实 storage.sync 同步安装清单、仓库选择与 GitHub 连接令牌');
  const catalog=await command({action:'catalog',query:''});check(catalog.rows.length>0&&!catalog.rows.some(row=>row.origins.includes(origin)),'空搜索列出当前语言未下载词库，已经下载和停用的网站不重复列出');
  await ui.locator('#dictionaryQuery').fill('TAILSCALE');await ui.locator('#dictionarySearch').click();await ui.locator('.dictionary-result').first().waitFor();
  check((await ui.locator('.dictionary-result').count())===1,'搜索主域名不区分大小写，同组四个网址合并为一条结果');
  await ui.getByRole('button',{name:'下载 tailscale.com 词库',exact:true}).click();await ui.waitForFunction(()=>document.querySelector('#message').textContent.startsWith('已下载 tailscale.com'));
  check(await ui.getByRole('button',{name:'下载 tailscale.com 词库',exact:true}).count()===0&&(await rpc('state')).dictionary.groups['tailscale.com'].downloadedOrigins.length===4,'点击合并结果一次下载主域名及全部子域名，成功后移出结果');
  await rpc('change',{siteId:'https://login.tailscale.com',kind:'setting',payload:{key:'enabled',value:false}});
  await rpc('change',{siteId:'https://tailscale.com',kind:'entry',payload:{...row('合并下载保留本地词条').entry,sourceText:'Group retained local',origin:'manual'}});
  await command({action:'download-group',group:'tailscale.com'});state=await rpc('state');check(state.sites['https://login.tailscale.com'].enabled===false&&state.sites['https://tailscale.com'].enabled===true&&Object.values(state.sites['https://tailscale.com'].entries).some(entry=>entry.translation==='合并下载保留本地词条'),'合并下载保留原有子域名停用状态与本地修改');
  for(const origin of ['https://tailscale.com','https://github.com']){await rpc('install',{origin});await command({action:'update',group:new URL(origin).hostname});}
  await context.route('https://tailscale.com/**',r=>r.fulfill({contentType:'text/html',body:'<html lang="en"><body><nav><button>Pricing</button></nav></body></html>'}));
  const tailscale=await context.newPage();await tailscale.goto('https://tailscale.com/');await tailscale.waitForFunction(()=>document.querySelector('button').textContent==='价格');check(true,'真实旧网站适配器从 JSON 异步加载后执行');
  await context.route('https://github.com/**',r=>r.fulfill({contentType:'text/html',body:'<html lang="en"><head><title>GitHub</title></head><body><header><a>Pull requests</a></header></body></html>'}));
  const github=await context.newPage();await github.goto('https://github.com/');await github.waitForFunction(()=>document.querySelector('a').textContent!=='Pull requests');check(true,'GitHub 专用引擎从 JSON 加载，未加载 locals.js');
  await ui.locator('#tab-websites').click();await ui.locator('#dictionaryCheck').click();await ui.waitForFunction(()=>document.querySelector('#message').textContent.includes('已检查'));
  check(await ui.locator('#tab-sync').textContent()==='词库仓库'&&!await ui.locator('#dictionaryStatus').isVisible(),'仓库设置页独立，检查完成信息只显示悬浮提示');
  await rpc('change',{siteId:'https://tailscale.com',kind:'entry',payload:{...row('批量测试译文').entry,sourceText:'Fixture bulk upload',origin:'manual'}});
  await ui.locator('#dictionaryUploadAll').click();await ui.waitForFunction(()=>document.querySelector('#message').textContent.includes('已上传 2 个主域名'));
  state=await rpc('state');check(state.dictionary.groups[group].pending===0&&state.dictionary.groups['tailscale.com'].pending===0,'上传全部逐组发布所有本地修改，全部成功后两个分组待上传归零');
  await rpc('change',{siteId:origin,kind:'entry',payload:{...row('批量上传后的本地修改').entry,origin:'manual'}});
  check(await worker.evaluate(async()=>!(await chrome.storage.local.get('wt_tasks')).wt_tasks || !Object.keys((await chrome.storage.local.get('wt_tasks')).wt_tasks).length),'初始化、下载和上传全过程未建立 AI 任务');
  await worker.evaluate(async()=>{const D=WTCore.dictionary,current=structuredClone(__remote.versions[__remote.head]),index=JSON.parse(current['dictionaries/index.json']);const item=index.groups.find(g=>g.group==='example.com'),manifest=JSON.parse(current[item.manifest.path]),data=manifest.languages['zh-Hans'],file=data.files.find(f=>f.kind==='entries');const pack=JSON.parse(current[file.path]);pack.records[0].entry.translation='远端新版';current[file.path]=JSON.stringify(pack,null,2)+'\n';file.bytes=D.bytes(current[file.path]);file.sha256=await D.digest(current[file.path]);data.revision=await D.digest({origins:data.origins,files:data.files});current[item.manifest.path]=JSON.stringify(manifest,null,2)+'\n';item.languages['zh-Hans']=data.revision;item.manifest.bytes=D.bytes(current[item.manifest.path]);item.manifest.sha256=await D.digest(current[item.manifest.path]);current['dictionaries/index.json']=JSON.stringify(index);__remote.head='f'.repeat(40);__remote.versions[__remote.head]=current;});
  await command({action:'check'});await ui.reload();await ui.locator('#tab-websites').click();
  await ui.locator('#dictionaryAll').waitFor({state:'visible'});check(await ui.locator('.group-actions').getByRole('button',{name:'更新',exact:true}).count()===1,'有新版时显示全部更新，单独更新只位于对应主域名分组行');
  await ui.screenshot({path:path.join(output,'updates.png'),fullPage:true});
  popup=await openPopup();await popup.locator('#wtDictionaryUpdate').waitFor({state:'visible'});check(await popup.locator('#wtDictionaryUpload').isVisible(),'弹窗同时识别远端更新与本地修改，显示更新和上传两个入口');
  await popup.locator('main').screenshot({path:path.join(output,'popup-dictionary.png')});
  const writesBefore=await worker.evaluate(()=>__remote.writes.length);await popup.locator('#wtDictionaryUpload').click();await popup.locator('dialog').waitFor();
  await popup.locator('dialog').screenshot({path:path.join(output,'upload-confirm.png')});
  check((await popup.locator('dialog').textContent()).includes('保留双方其余修改'),'真实弹窗上传冲突明确采用本地，保留非冲突内容');
  await popup.locator('dialog button').getByText('取消',{exact:true}).click();await popup.close();
  state=await rpc('state');check(state.dictionary.groups[group].pending>0&&(await worker.evaluate(()=>__remote.writes.length))===writesBefore,'取消上传确认不写远端，本地修改保留');
  let plan=await command({action:'upload',group});check(plan.requiresConfirmation&&!plan.full,'有共同基线的冲突生成局部覆盖确认');
  await rpc('change',{siteId:origin,kind:'entry',payload:{...row('本地独有').entry,sourceText:'Local independent',origin:'manual'}});
  let stale=false;try{await command({action:'transfer-confirm',id:plan.id});}catch(e){stale=e.message.includes('本地又有修改');}check(stale,'确认后本地新增使旧覆盖确认失效');
  plan=await command({action:'upload',group});await worker.evaluate(()=>{const previous=__remote.head;__remote.head='9'.repeat(40);__remote.versions[__remote.head]=structuredClone(__remote.versions[previous]);});
  stale=false;try{await command({action:'transfer-confirm',id:plan.id});}catch(e){stale=e.message.includes('仓库又有修改');}check(stale,'确认后仓库提交改变使旧覆盖确认失效');
  await rpc('change',{siteId:'https://tailscale.com',kind:'entry',payload:{...row('批量部分成功').entry,sourceText:'Fixture partial upload',origin:'manual'}});
  await ui.reload();await ui.locator('#tab-websites').click();await ui.locator('#dictionaryUploadAll').click();await ui.locator('dialog').waitFor();await ui.locator('dialog button').getByText('取消',{exact:true}).click();
  await ui.waitForFunction(()=>document.querySelector('#message').textContent.includes('已上传 1 个主域名'));
  state=await rpc('state');check(state.dictionary.groups[group].pending>0&&state.dictionary.groups['tailscale.com'].pending===0,'批量上传逐组询问，取消冲突组仍完成其他组');
  popup=await openPopup();await popup.locator('#wtDictionaryUpload').waitFor({state:'visible'});await popup.locator('#wtDictionaryUpload').click();await popup.locator('dialog button.primary').click();await popup.waitForFunction(()=>document.querySelector('#message').textContent.includes('上传成功'));await popup.close();
  state=await rpc('state');check(state.dictionary.groups[group].pending===0&&Object.values(state.sites[origin].entries).some(e=>e.translation==='批量上传后的本地修改'),'确认上传采用本地冲突译文且上传本地独有内容');
  const uploadedSnapshot=await worker.evaluate(()=>__remote.head);
  // Create another conflict to exercise the opposite direction through the actual settings UI.
  await rpc('change',{siteId:origin,kind:'entry',payload:{...row('再次本地').entry,origin:'manual'}});
  await worker.evaluate(async()=>{const D=WTCore.dictionary,files=structuredClone(__remote.versions[__remote.head]),index=JSON.parse(files['dictionaries/index.json']),item=index.groups.find(g=>g.group==='example.com'),manifest=JSON.parse(files[item.manifest.path]),data=manifest.languages['zh-Hans'],description=data.files.find(f=>f.id==='managed-entries'),pack=JSON.parse(files[description.path]);pack.records.find(r=>r.entry.sourceText==='Save').entry.translation='远端新版';files[description.path]=JSON.stringify(pack);description.bytes=D.bytes(files[description.path]);description.sha256=await D.digest(files[description.path]);data.revision=await D.digest({origins:data.origins,files:data.files});files[item.manifest.path]=JSON.stringify(manifest);item.manifest.bytes=D.bytes(files[item.manifest.path]);item.manifest.sha256=await D.digest(files[item.manifest.path]);item.languages['zh-Hans']=data.revision;files['dictionaries/index.json']=JSON.stringify(index);__remote.head='8'.repeat(40);__remote.versions[__remote.head]=files;});
  await command({action:'check'});await ui.reload();await ui.locator('#tab-websites').click();await ui.locator('.domain-group').filter({has:ui.locator('summary strong',{hasText:'example.com'})}).getByRole('button',{name:'更新',exact:true}).click();
  await ui.locator('dialog').screenshot({path:path.join(output,'update-confirm.png')});await ui.locator('dialog button.primary').click();await ui.waitForFunction(()=>document.querySelector('#message').textContent.includes('已采用仓库内容'));
  state=await rpc('state');check(state.dictionary.groups[group].pending===0&&!state.dictionary.check.groups.find(g=>g.group===group).hasUpdate&&Object.values(state.sites[origin].entries).some(e=>e.sourceText==='Save'&&e.translation==='远端新版'),'确认更新采用仓库冲突译文，清除旧更新按钮且不重新生成译文');
  await rpc('change',{siteId:origin,kind:'entry',payload:{...row('整份覆盖应丢弃').entry,sourceText:'Full discard only',origin:'manual'}});
  await worker.evaluate(sha=>{__remote.head=sha;},uploadedSnapshot);
  plan=await command({action:'update',group});check(plan.requiresConfirmation&&plan.full,'仓库回到已见历史提交时不按时间猜测，要求整份覆盖确认');
  await command({action:'transfer-confirm',id:plan.id});state=await rpc('state');
  check(state.dictionary.groups[group].pending===0&&!Object.values(state.sites[origin].entries).some(e=>e.sourceText==='Full discard only'),'确认整份更新丢弃本地独有修改且不会从旧操作重放');
  await worker.evaluate(()=>{__remote.head='8'.repeat(40);});
  plan=await command({action:'upload',group});check(plan.requiresConfirmation&&plan.full,'反向上传同样识别无法比较状态，要求整份仓库覆盖确认');
  await command({action:'transfer-confirm',id:plan.id});state=await rpc('state');
  check(state.dictionary.groups[group].pending===0&&await worker.evaluate(()=>__remote.writes.filter(w=>w.method==='PATCH').every(w=>w.body.force===false)),'整份上传经确认完成并刷新基线，始终通过普通提交保留历史');
  await rpc('change',{siteId:origin,kind:'entry',payload:{...row('远端新版').entry,origin:'manual'}});await command({action:'upload',group});
  await rpc('change',{siteId:origin,kind:'entry',payload:{...row('仅本机保留').entry,sourceText:'Unpublished',origin:'manual'}});
  await command({action:'configure',repository:{owner:'Ffive55',repo:'another-dictionary',branch:'main'},token:'fixture-only'});await rpc('state');await command({action:'configure',repository:{owner:'Ffive55',repo:'website-translator',branch:'main'},token:'fixture-only'});state=await rpc('state');check(Object.values(state.sites[origin].entries).some(e=>e.translation==='远端新版')&&!Object.values(state.sites[origin].entries).some(e=>e.translation==='预览后修改'),'切换仓库再返回不重放已放弃的旧人工译文');
  const beforeRemoved=(await rpc('state')).dictionary.groups[group].pending;
  await worker.evaluate(()=>chrome.storage.local.set({wt_dictionary_import:{marker:'obsolete-inert-journal'}}));
  for(const action of ['backup','import-file','import-files','import-legacy','import-resume','import-before','import-cancel','preview','publish','restart']){let rejected=false;try{await command({action});}catch{rejected=true;}assert.ok(rejected,action+' should be removed');}
  check((await rpc('state')).dictionary.groups[group].pending===beforeRemoved,'已删除的导入、备份及预览入口不能写入本机词库');
  await command({action:'sync'});
  await ui.locator('#tab-sync').click();
  await ui.locator('#repositoryProvider').selectOption('gitee');await ui.locator('#repositoryToken').fill('fixture-gitee');await ui.locator('#repositoryTest').click();
  await ui.waitForFunction(()=>document.querySelector('#repositoryTestStatus').textContent.startsWith('测试完成'));
  check((await rpc('state')).dictionary.repository.provider===undefined,'Gitee 测试完成仍保持原 GitHub 仓库和缓存');
  check(await ui.locator('#repositoryChoices option').count()===3&&(await ui.locator('#repositoryTestStatus').textContent()).includes('1 个空仓库'),'真实设置页同时列出已有词库和空仓库，无手动仓库或分支输入');
  const choice=await ui.locator('#repositoryChoices option').nth(1).getAttribute('value');await ui.locator('#repositoryChoices').selectOption(choice);await ui.locator('#repositoryConfirm').click();
  state=await wait(s=>s.dictionary.repository.provider==='gitee'&&(s.dictionary.groups[group]?.installed||s.dictionary.groups[group]?.conflicts.length));
  if(state.dictionary.groups[group].conflicts.length){
    check(!state.dictionary.groups[group].installed,'平台切换遇到同键不同译文时保留双方冲突，不静默覆盖');
    for(const conflict of state.dictionary.groups[group].conflicts)await command({action:'resolve',group,key:conflict.key,choice:'remote'});
  }
  state=await wait(s=>s.dictionary.repository.provider==='gitee'&&s.dictionary.groups[group]?.installed);
  check(state.dictionary.credentialPlatforms.github&&state.dictionary.credentialPlatforms.gitee&&!JSON.stringify(state.dictionary).includes('fixture-gitee'),'确认 Gitee 后保留两个平台独立令牌，状态不返回令牌内容');
  await rpc('change',{siteId:origin,kind:'entry',payload:{...row('Gitee 本机译文').entry,sourceText:'Gitee fixture label',origin:'manual'}});
  await command({action:'upload',group});
  check(await worker.evaluate(()=>__gitee.writes.length===1&&__gitee.writes[0].actions.length===3&&__gitee.writes[0].actions.some(a=>a.path.endsWith('/managed-entries.json')&&a.action==='create'&&!a.last_commit_id)),'实际后台 Gitee 识别 HTTP 200 空数组为新文件，一次提交新增词条文件和更新两个清单');
  await ui.locator('#repositoryTest').click();await ui.waitForFunction(()=>document.querySelector('#repositoryTestStatus').textContent.startsWith('测试完成'));
  const emptyChoice=await ui.locator('#repositoryChoices option').filter({hasText:'fixture/empty'}).getAttribute('value');await ui.locator('#repositoryChoices').selectOption(emptyChoice);
  check(await ui.locator('#repositoryConfirm').textContent()==='初始化并连接'&&await worker.evaluate(()=>__initial.writes.length===0),'选择空仓库明确显示初始化范围，确认前没有写入');
  await ui.screenshot({path:path.join(output,'repository-empty.png'),fullPage:true});
  await ui.locator('#repositoryConfirm').click();await ui.waitForFunction(()=>!document.querySelector('#repositoryConfirm').disabled);
  check(await worker.evaluate(()=>__initial.writes.length===1)&&(await rpc('state')).dictionary.repository.repo==='dictionary','初始化响应丢失保留进度且不切换当前仓库');
  await ui.reload();await ui.locator('#tab-sync').click();await ui.locator('#repositoryTest').click();await ui.waitForFunction(()=>document.querySelector('#repositoryTestStatus').textContent.startsWith('测试完成'));
  const resumeChoice=await ui.locator('#repositoryChoices option').filter({hasText:'fixture/empty'}).getAttribute('value');await ui.locator('#repositoryChoices').selectOption(resumeChoice);
  check(await ui.locator('#repositoryConfirm').textContent()==='继续初始化并连接','关闭重开设置后通过本机事务继续初始化');
  await ui.locator('#repositoryConfirm').click();await wait(s=>s.dictionary.repository.repo==='empty');
  check(await worker.evaluate(()=>__initial.writes.length===8&&new Set(__initial.writes).size===8&&__initial.writes.at(-1)==='dictionaries/index.json'),'断点恢复不重复写文件，全部八个文件完成且索引最后写入');
  const initialized=await worker.evaluate(()=>WTCore.dictionaryRepository.create({repository:{provider:'gitee',owner:'fixture',repo:'empty',branch:'main'},token:'fixture-gitee',getDomain:tldts.getDomain}).catalog('zh-Hans'));
  check(initialized.rows.length===1&&initialized.rows[0].origins.length===1&&initialized.rows[0].origins[0]==='https://github.com','初始化仓库校验完成后连接，只含 GitHub 主站词库');
  await ui.locator('#repositoryProvider').selectOption('github');await command({action:'configure',repository:{owner:'Ffive55',repo:'website-translator',branch:'main'},token:''});
  state=await rpc('state');check(state.dictionary.repository.provider===undefined&&state.dictionary.hasToken&&state.dictionary.groups[group].installed,'切回 GitHub 自动复用原平台令牌及下载缓存');
  await ui.screenshot({path:path.join(output,'repository-settings.png'),fullPage:true});
  await rpc('config',{ai:{provider:'api',endpoint:'https://fixture-ai.invalid/v1/chat/completions',model:'synced-fixture-model',apiKey:'fixture-ai-synced',region:'',reasoningEffort:'high'}});
  const latestSync=await worker.evaluate(async()=>{await new Promise(r=>setTimeout(r,1000));return chrome.storage.sync.get(null);});
  const latestRemote=await worker.evaluate(()=>__remote);
  await ui.screenshot({path:path.join(output,'management.png'),fullPage:true});
  await context.close();
  const secondMock=mock.replaceAll(JSON.stringify(data),()=>JSON.stringify(latestRemote.versions[latestRemote.head])).replace("__remote={head:'a'.repeat(40)",'__remote={head:'+JSON.stringify(latestRemote.head));
  await fs.writeFile(workerFile,secondMock+(await fs.readFile(path.join(ROOT,'edge/managed/worker.js'),'utf8')));
  const second=await chromium.launchPersistentContext(path.join(output,'second-profile-'+Date.now()),{channel:'msedge',headless:true,args:[`--disable-extensions-except=${fixture}`,`--load-extension=${fixture}`]});
  try{
    // Opening the extension page wakes its MV3 worker; do not rely on an eager
    // worker event before any page has requested the background on a fresh profile.
    let secondUI=await second.newPage();await secondUI.goto(`chrome-extension://${id}/managed/managed.html`);
    let secondWorker=second.serviceWorkers()[0];if(!secondWorker)secondWorker=await second.waitForEvent('serviceworker',{timeout:15000});
    const secondRPC=(type,args={})=>secondUI.evaluate(async({type,args})=>{const r=await chrome.runtime.sendMessage({type:'wt:'+type,...args});if(!r.ok)throw Error(r.error);return r.result;},{type,args});
    for(let i=0;i<200;i++){if((await secondRPC('state')).dictionary.ready)break;await new Promise(resolve=>setTimeout(resolve,50));}
    await secondWorker.evaluate(values=>chrome.storage.sync.set(values),latestSync);
    // Repository and both provider tokens restore from the synchronized records; no manual configuration.
    let restored;for(let i=0;i<100;i++){restored=await secondRPC('state');if(restored.dictionary.groups?.[group]?.installed&&Object.values(restored.sites[origin]?.entries||{}).some(e=>e.translation==='远端新版'))break;await new Promise(r=>setTimeout(r,100));}
    if(!restored.dictionary.groups?.[group]?.installed)console.log('RECOVERY',JSON.stringify({dictionary:restored.dictionary,sites:Object.keys(restored.sites)}));
    check(await secondWorker.evaluate(async()=>{const {wt_ai}=await chrome.storage.local.get('wt_ai');return wt_ai?.apiKey==='fixture-ai-synced'&&wt_ai.model==='synced-fixture-model'&&wt_ai.reasoningEffort==='high';}),'第二隔离设备恢复 AI 服务、模型、思考强度和 API Key，不调用 AI');
    check(restored.dictionary.hasToken&&restored.dictionary.credentialPlatforms.gitee,'第二隔离设备自动恢复仓库选择与两平台令牌，无需重新输入');
    check(restored.dictionary.groups?.[group]?.installed&&restored.sites[origin]?.enabled===false,'第二个隔离设备从同步清单自动恢复词库，停用状态保留');
    check(Object.values(restored.sites[origin].entries).some(e=>e.translation==='远端新版')&&!Object.values(restored.sites[origin].entries).some(e=>e.translation==='仅本机保留'),'新设备仅恢复已上传词条，未上传修改留在原设备');
    check((await secondWorker.evaluate(()=>__remote.writes.length))===0,'新设备恢复只读取 GitHub，不触发上传或 AI');
    await secondRPC('change',{siteId:origin,kind:'entry',payload:{...row('第二设备本机词条').entry,sourceText:'Device local',origin:'manual'}});
    const pendingBefore=(await secondRPC('state')).dictionary.groups[group].pending;
    const reloadWorker=second.waitForEvent('serviceworker',{timeout:15000});await secondWorker.evaluate(()=>chrome.runtime.reload()).catch(()=>{});secondWorker=await reloadWorker;secondUI=await second.newPage();await secondUI.goto('chrome-extension://'+id+'/managed/managed.html');
    let reloaded;for(let i=0;i<200;i++){reloaded=await secondRPC('state');if(reloaded.dictionary.ready)break;await new Promise(r=>setTimeout(r,50));}
    check(pendingBefore>0&&reloaded.dictionary.groups[group].pending===pendingBefore&&Object.values(reloaded.sites[origin].entries).some(entry=>entry.translation==='第二设备本机词条'),'重新加载保留当前词库和未上传修改，无需迁移或导入');
  }finally{await second.close();}
  await fs.writeFile(path.join(output,'result.json'),JSON.stringify({checks,count:checks.length},null,2));
 }finally{await context.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
