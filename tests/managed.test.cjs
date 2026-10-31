'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {JSDOM}=require('jsdom');
const C=require('../extension/managed-core');
const {exchange,acknowledge,envelope,verify,immutable,confirmDirectory}=require('../native/sync.cjs');
const {readSSE}=require('../native/oauth.cjs');
const {encode}=require('../native/host.cjs');
const {OAuth}=require('../native/oauth.cjs');
const {randomUUID}=require('node:crypto');
const source=name=>fs.readFileSync(path.join(__dirname,'../extension',name),'utf8');
const origin='https://example.com';
function builder(deviceId=randomUUID()){
  let seq=0;return (kind,payload,deps=[],generation=1)=>({schemaVersion:1,opId:`${deviceId}-${++seq}`,deviceId,seq,deps,siteId:origin,generation,kind,payload});
}
const sitePayload={origin,name:'Example',group:'example.com',builtinId:null};
const entry=(translation='保存',targetLanguage='zh-Hans',origin='ai')=>({sourceText:'Save {count}',context:'main/button/text',path:'/settings',sourceLanguage:null,targetLanguage,category:'ui',action:'translate',translation:`${translation} {count}`,origin});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
test('同步服务选择复用最新公共配置，并保留本设备 API Key',async t=>{
  require('../extension/dictionary-core');let hooks;
  const runtime={create:value=>{hooks=value;return {start:async()=>{},changed(){},enrich:async site=>site,summary:async()=>({})};}};
  const w=await worker(t,undefined,undefined,{WTDictionaryRuntime:runtime});
  await w.request('config',{ai:{provider:'api',model:'old',endpoint:'https://api.example.com/v1/chat/completions',apiKey:'fixture-local-only'}});
  const old={provider:'api',model:'old',endpoint:'https://api.example.com/v1/chat/completions',region:'',reasoningEffort:'auto'},latest={...old,model:'new-public-model'};
  await hooks.applySync([{kind:'preference',field:'aiSettings',value:old},{kind:'preference',field:'aiProfile:api',value:latest}]);
  assert.equal(w.local.wt_ai.model,'new-public-model');assert.equal(w.local.wt_ai.apiKey,'fixture-local-only');
});
test('AI 返回严格校验数量、ID、分类、占位符、脚本字段和 HTML',()=>{
  const input=[{id:'t0',sourceText:'Save {count}',context:'main/button/text',path:'/'}];
  const good={id:'t0',category:'ui',action:'translate',translation:'保存 {count}',reason:''};
  assert.equal(C.validateResult(JSON.stringify([good]),input,'zh-Hans')[0].sourceLanguage,null);
  for(const value of [[],[good,good],[{...good,id:'evil'}],[{...good,selector:'body'}],[{...good,translation:'保存'}],[{...good,category:'dynamic_content'}],[{...good,translation:'<b>{count}</b>'}]])assert.throws(()=>C.validateResult(JSON.stringify(value),input,'zh-Hans'));
});
test('乱序、缺少依赖及重复 opId；字段独立合并，删除不复活，重新添加新代次',()=>{
  const a=builder(),b=builder();const create=a('create',sitePayload),edit=a('entry',entry(),[create.opId]),off=b('setting',{key:'enabled',value:false},[create.opId]);
  const unknown=C.materialize([edit]);assert.equal(unknown.pending.length,1);assert.equal(Object.keys(unknown.sites).length,0);
  const state=C.materialize([edit,off,create,edit]);assert.equal(state.sites[origin].enabled,false);assert.equal(Object.keys(state.sites[origin].entries).length,1);
  const del=b('delete',{},[create.opId]);assert.equal(C.materialize([edit,del,create]).sites[origin].deleted,true);
  const again=a('create',sitePayload,[del.opId],2);assert.equal(C.materialize([again,edit,del,create]).sites[origin].deleted,false);assert.equal(Object.keys(C.materialize([again,edit,del,create]).sites[origin].entries).length,0);
  assert.throws(()=>C.materialize([create,{...create,payload:{...sitePayload,name:'changed'}}]),/冲突/);
});
test('人工词条优先，跨语言隔离，并发人工候选保留及显式解决',()=>{
  const a=builder(),b=builder();const create=a('create',sitePayload);
  const manual=a('entry',entry('保存','zh-Hans','manual'),[create.opId]);
  const other=b('entry',entry('存储','zh-Hans','manual'),[create.opId]);
  const ai=b('entry',entry('覆盖'),[manual.opId]);
  const japanese=a('entry',entry('保存する','ja'),[create.opId]);
  const ops=[ai,manual,other,japanese,create],state=C.materialize(ops).sites[origin];
  assert.equal(Object.keys(state.entries).length,2);assert.equal(state.entries[C.entryKey(manual.payload)].origin,'manual');assert.equal(state.conflicts[C.entryKey(manual.payload)].length,2);
  const resolved=a('entry',entry('确认','zh-Hans','manual'),[manual.opId,other.opId]);assert.equal(Object.keys(C.materialize([...ops,resolved]).sites[origin].conflicts).length,0);
});
test('协议拒绝凭据、非法字段和无效语言',()=>{
  const a=builder();assert.throws(()=>C.validateOp(a('create',{...sitePayload,apiKey:'secret'})));
  assert.throws(()=>C.validateOp(a('setting',{key:'apiKey',value:'secret'})));
  assert.throws(()=>C.language('not a language'));
  assert.throws(()=>verify({...envelope({a:1}),data:{a:2}}));
});
async function temp(t){const root=path.join(__dirname,'../.cache/test-native',randomUUID());await fs.promises.mkdir(root,{recursive:true});t.after(()=>{assert.ok(path.resolve(root).startsWith(path.resolve(__dirname,'../.cache/test-native')+path.sep));fs.rmSync(root,{recursive:true,force:true});});return root;}
test('文件同步两设备往返、不可变校验、冲突副本幂等、坏文件和对端确认',async t=>{
  const root=await temp(t),a=builder(),create=a('create',sitePayload),edit=a('entry',entry(),[create.opId]);
  const deviceB=randomUUID();
  const first=await exchange({directory:root,deviceId:create.deviceId,ops:[create,edit]});assert.equal(first.ops.length,2);
  await fs.promises.copyFile(path.join(root,'changes',`${edit.opId}.json`),path.join(root,'changes','conflict-copy.json'));
  await fs.promises.writeFile(path.join(root,'changes','broken.json'),'{');
  const second=await exchange({directory:root,deviceId:deviceB,ops:[]});assert.equal(second.ops.length,2);assert.equal(second.invalid,1);
  assert.equal((await acknowledge({directory:root,deviceId:create.deviceId,applied:[create.opId,edit.opId]})).peerConfirmed,false);
  await acknowledge({directory:root,deviceId:deviceB,applied:[create.opId,edit.opId]});
  assert.equal((await acknowledge({directory:root,deviceId:create.deviceId,applied:[create.opId,edit.opId]})).peerConfirmed,true);
  await assert.rejects(()=>immutable(path.join(root,'changes',`${edit.opId}.json`),{...edit,seq:99}),/冲突/);
  await assert.rejects(()=>exchange({directory:path.join(root,'missing'),deviceId:deviceB,ops:[]}),/不存在/);
});
test('SSE 跨块与 CRLF 解码，未完成或失败不接受；native 帧长度使用 UTF-8 字节',async()=>{
  const stream=async function*(s){const bytes=Buffer.from(s);for(let i=0;i<bytes.length;i+=3)yield bytes.subarray(i,i+3);};
  const event='data: {"type":"response.output_text.delta","delta":"译文"}\r\n\r\n';
  assert.equal(await readSSE(stream(event+'data: {"type":"response.completed","response":{"status":"completed"}}\n\n')),'译文');
  await assert.rejects(()=>readSSE(stream(event+'data: {"type":"response.completed"}\n\n')),/未完成/);
  await assert.rejects(()=>readSSE(stream(event)),/中断/);
  await assert.rejects(()=>readSSE(stream(event+'data: {"type":"response.failed"}\n\n')),/失败/);
  const frame=encode({text:'中文'});assert.equal(frame.readUInt32LE(),frame.length-4);
});
test('Windows 本机令牌经 DPAPI 加密，重建实例可读取；续期原子替换令牌', {skip:process.platform!=='win32'}, async t=>{
  const root=await temp(t),oauth=new OAuth(root);
  const record={access_token:'synthetic-old-token',refresh_token:'synthetic-refresh',expiresAt:0,client_id:'test-client',scope:'chatgpt.tokens.use.direct',hostId:'test-host'};
  await oauth.save(record);assert.ok(!fs.readFileSync(path.join(root,'chatgpt.dat'),'utf8').includes('synthetic'));
  assert.deepEqual(await new OAuth(root).load(),record);
  const originalFetch=global.fetch;t.after(()=>{global.fetch=originalFetch;});
  global.fetch=async(url,options)=>{assert.equal(url,'https://auth.openai.com/api/accounts/oauth/token');assert.equal(options.body.get('grant_type'),'refresh_token');return new Response(JSON.stringify({token_type:'Bearer',access_token:'synthetic-new-token',refresh_token:'synthetic-rotated',expires_in:3600,scope:'chatgpt.tokens.use.direct'}));};
  assert.equal(await oauth.access(),'synthetic-new-token');assert.equal((await oauth.load()).refresh_token,'synthetic-rotated');
});
async function page(t){
  const dom=new JSDOM('<html lang="en"><body><main><button>Save {count}</button><p>Long stable text.</p><pre>Save {count}</pre><input value="Save {count}"><span data-device-name>Private laptop</span><p>user@example.com</p></main></body></html>',{url:origin+'/settings',runScripts:'outside-only'});t.after(()=>dom.window.close());
  const listeners=[];let calls=0;
  const site={...sitePayload,id:origin,generation:1,enabled:true,deleted:false,targetLanguage:'zh-Hans',excludedPaths:[],entries:{}};
  dom.window.chrome={runtime:{id:'test',onMessage:{addListener:fn=>listeners.push(fn)},sendMessage:async()=>{calls++;return {ok:true,result:{site,globalEnabled:true}};}}};
  dom.window.eval(source('managed-core.js'));dom.window.eval(source('text-provenance.js'));dom.window.eval(source('managed-content.js'));await pause(20);
  const update=async s=>{listeners.forEach(fn=>fn({type:'wt:apply',site:s,globalEnabled:true},{id:'test'},()=>{}));await pause(110);};
  const request=message=>new Promise(resolve=>listeners.forEach(fn=>fn(message,{id:'test'},resolve)));
  return {window:dom.window,site,update,request,calls:()=>calls};
}
test('原文采集保护输入、代码、设备名和地址；目标切换恢复原文，停用清理标记',async t=>{
  const p=await page(t),doc=p.window.document;
  assert.deepEqual(Array.from(p.window.WTPage.collect().items,i=>i.sourceText),['Save {count}','Long stable text.']);
  const zh=entry(),ja=entry('保存する','ja');p.site.entries[C.entryKey(zh)]=zh;p.site.entries[C.entryKey(ja)]=ja;
  await p.update(p.site);assert.equal(doc.querySelector('button').textContent,'保存 {count}');assert.equal(doc.documentElement.lang,'zh-Hans');
  assert.equal(p.window.WTText.source(doc.querySelector('button').firstChild),'Save {count}');assert.ok(!p.window.WTPage.collect().items.some(i=>i.sourceText==='Save {count}'));
  await p.update({...p.site,targetLanguage:'ja'});assert.equal(doc.querySelector('button').textContent,'保存する {count}');
  await p.update({...p.site,targetLanguage:'en'});assert.equal(doc.querySelector('button').textContent,'Save {count}');
  await p.update({...p.site,enabled:false});assert.equal(doc.documentElement.lang,'en');assert.equal(doc.querySelector('[data-website-translator]'),null);
  assert.equal(doc.querySelector('pre').textContent,'Save {count}');assert.equal(p.calls(),1,'普通浏览及语言切换不得发起 AI 请求');
});
test('动态页面仅匹配本页词条，外部改写成为新原文，排除路径不采集',async t=>{
  const p=await page(t),doc=p.window.document,zh=entry();p.site.entries[C.entryKey(zh)]=zh;await p.update(p.site);
  doc.querySelector('button').firstChild.data='Changed source';await pause(180);assert.equal(p.window.WTPage.collect().items[0].sourceText,'Changed source');
  p.window.history.pushState({},'', '/other');p.window.WTPage.apply();assert.equal(doc.querySelector('button').textContent,'Changed source');
  await p.update({...p.site,excludedPaths:['/other']});assert.equal(p.window.WTPage.collect().items.length,0);
});
test('固定 UI 数值使用受控占位符，变化数值复用译文且恢复当前原文',async t=>{
  const p=await page(t),button=p.window.document.querySelector('button');button.firstChild.data='3 items';await pause(120);
  const item=p.window.WTPage.collect().items.find(i=>i.sourceText.includes('items'));assert.equal(item.sourceText,'{WTN0} items');
  const e={...entry(),sourceText:item.sourceText,translation:'{WTN0} 个项目'};p.site.entries[C.entryKey(e)]=e;await p.update(p.site);assert.equal(button.textContent,'3 个项目');
  button.firstChild.data='12 items';await pause(140);assert.equal(button.textContent,'12 个项目');
  await p.update({...p.site,enabled:false});assert.equal(button.textContent,'12 items');
});
async function worker(t,fetcher,native,overrides={}){
  const local={},synced={readme_openai_api_key:'old-secret'},listeners=[],changed=[],activeTimers=new Set();
  const event=()=>({addListener:()=>{}});
  const area=(db,name)=>({get:async keys=>{if(keys===null)return {...db};if(typeof keys==='string')return {[keys]:db[keys]};if(Array.isArray(keys))return Object.fromEntries(keys.map(k=>[k,db[k]]));return {...keys,...db};},set:async values=>{Object.assign(db,structuredClone(values));changed.forEach(fn=>fn(Object.fromEntries(Object.entries(values).map(([k,v])=>[k,{newValue:v}])),name));},remove:async keys=>[].concat(keys).forEach(k=>delete db[k]),setAccessLevel:async()=>{}});
  const chrome={runtime:{id:'test',getURL:p=>'chrome-extension://test/'+p,getPlatformInfo:async()=>({}),sendNativeMessage:async(_host,m)=>({ok:true,result:m.action==='confirm-directory'?{writable:true,directory:m.directory || 'fixture'}:await native(m)}),onStartup:event(),onMessage:{addListener:fn=>listeners.push(fn)}},storage:{local:area(local,'local'),sync:area(synced,'sync'),onChanged:{addListener:fn=>changed.push(fn)}},permissions:{contains:async()=>true,onAdded:event(),onRemoved:event()},scripting:{getRegisteredContentScripts:async()=>[],registerContentScripts:async()=>{},executeScript:async()=>[]},tabs:{get:async()=>({id:1,url:origin+'/settings'}),query:async()=>[],sendMessage:async()=>({origin,items:[{id:'t0',sourceText:'Save {count}',context:'main/button/text',path:'/settings'}]})}};
  const alarms=new Map(),alarmListeners=[];chrome.alarms={get:async n=>alarms.get(n),create:async(n,v)=>alarms.set(n,v),clear:async n=>alarms.delete(n),onAlarm:{addListener:f=>alarmListeners.push(f)}};
  const menus=new Map(),menuListeners=[];chrome.contextMenus={create:async item=>menus.set(item.id,item),remove:async id=>menus.delete(id),onClicked:{addListener:f=>menuListeners.push(f)}};
  const context=vm.createContext({console,chrome,WTCore:C,WTBatch:require('../extension/managed-batching'),WTProviders:require('../extension/managed-providers'),tldts:require('tldts'),SUPPORTED_SITES:[],crypto:require('node:crypto').webcrypto,URL,AbortSignal,TextDecoder,structuredClone,setTimeout,clearTimeout,fetch:fetcher,setInterval:(f,m)=>{const id=setInterval(f,m);activeTimers.add(id);return id;},clearInterval:id=>{clearInterval(id);activeTimers.delete(id);},...overrides});
  vm.runInContext(source('managed-background.js'),context);
  t.after(()=>activeTimers.forEach(clearInterval));
  const request=(type,data={},sender={id:'test',tab:{id:2},url:'chrome-extension://test/managed/managed.html'})=>new Promise(resolve=>listeners[0]({type:'wt:'+type,...data},sender,resolve));
  await request('state');return {request,local,synced,chrome,alarms,alarmListeners,menus,menuClick:info=>menuListeners[0]({menuItemId:'wt-add-selection',frameId:0,selectionText:'Missing text',...info},{id:1,url:origin+'/settings'})};
}
test('后台 API 添加保存、本地凭据迁移；内容脚本不能启动 AI',async t=>{
  const w=await worker(t,async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify([{id:'t0',category:'ui',action:'translate',translation:'保存 {count}',reason:''}])}}]})));
  assert.equal(w.synced.readme_openai_api_key,undefined);assert.equal(w.local.wt_legacy_secrets.readme_openai_api_key,'old-secret');
  await w.request('config',{ai:{provider:'api',model:'test',endpoint:'https://api.example.com/v1/chat/completions',apiKey:'secret'}});
  assert.equal((await w.request('start',{tabId:1},{id:'test',tab:{id:1},url:origin})).ok,false);
  assert.equal((await w.request('start',{tabId:1})).ok,true);await pause(120);
  const state=(await w.request('state')).result;assert.equal(Object.values(state.wt_tasks)[0].status,'completed');assert.equal(Object.keys(state.sites[origin].entries).length,1);
  assert.ok(!C.canonical(w.local.wt_database).includes('secret'));
});
test('删除/停用期间迟到结果被拒绝，不恢复网站、不写入词条',async t=>{
  let deliver;const w=await worker(t,()=>new Promise(r=>deliver=r));
  await w.request('config',{ai:{provider:'api',model:'test',endpoint:'https://api.example.com/v1/chat/completions',apiKey:'secret'}});
  await w.request('start',{tabId:1});for(let i=0;i<30&&!deliver;i++)await pause(10);assert.ok(deliver);
  await w.request('change',{siteId:origin,kind:'delete',payload:{}});
  deliver(new Response(JSON.stringify({choices:[{message:{content:JSON.stringify([{id:'t0',category:'ui',action:'translate',translation:'保存 {count}',reason:''}])}}]})));await pause(120);
  const state=(await w.request('state')).result;assert.equal(state.sites[origin].deleted,true);assert.equal(Object.keys(state.sites[origin].entries).length,0);assert.equal(Object.values(state.wt_tasks)[0].status,'failed');
});
test('同步中文大词条按 UTF-8 字节读取；总量超限明确失败且不截断',async t=>{
  const root=await temp(t),a=builder(),create=a('create',sitePayload);
  const large=a('entry',{...entry(),sourceText:'原'.repeat(4000),translation:'译'.repeat(8000)},[create.opId]);
  const result=await exchange({directory:root,deviceId:create.deviceId,ops:[create,large]});assert.equal(result.ops.length,2);
  assert.ok(Buffer.byteLength(C.canonical(large))>30000,'确实覆盖原 30KB 读取上限');
  const many=Array.from({length:40},(_,i)=>a('entry',{...entry(),sourceText:`Label ${i}`,translation:'译'.repeat(8000)},[create.opId]));
  await assert.rejects(()=>exchange({directory:root,deviceId:create.deviceId,ops:[create,large,...many]}),/UTF-8/);
  const names=await fs.promises.readdir(path.join(root,'changes'));assert.equal(names.filter(n=>n.endsWith('.json')).length,42);
});
test('不把损坏确认或本机确认当成对端确认；依赖缺失不被快照吞掉',async t=>{
  const root=await temp(t),a=builder(),create=a('create',sitePayload),edit=a('entry',entry(),[create.opId]);
  const state=await exchange({directory:root,deviceId:create.deviceId,ops:[edit]});assert.equal(state.pending,1);
  await immutable(path.join(root,'acks','bad.json'),{schemaVersion:1,applied:[edit.opId]});
  assert.equal((await acknowledge({directory:root,deviceId:create.deviceId,applied:[edit.opId]})).peerConfirmed,false);
  const full=await exchange({directory:root,deviceId:create.deviceId,ops:[create,edit]});assert.equal(full.pending,0);assert.equal(full.ops.length,2);
});
test('跨代次复活必须依赖前代删除；无网站依赖的记录不记为已合并',()=>{
  const a=builder();assert.throws(()=>C.materialize([a('create',sitePayload,[],2)]),/删除依赖/);
  assert.throws(()=>C.materialize([a('entry',entry())]),/创建依赖/);
  assert.throws(()=>C.validateOp(a('setting',{key:'targetLanguage',value:'EN-us'})),/规范/);
});
test('同一 opId 的内容冲突不能被坏文件计数掩盖',async t=>{
  const root=await temp(t),a=builder(),create=a('create',sitePayload);
  await exchange({directory:root,deviceId:create.deviceId,ops:[create]});
  await immutable(path.join(root,'changes','conflict.json'),{...create,payload:{...sitePayload,name:'different'}});
  await assert.rejects(()=>exchange({directory:root,deviceId:randomUUID(),ops:[]}),/opId 冲突/);
});
async function until(fn){for(let i=0;i<600;i++){if(fn())return;await pause(10);}assert.fail('等待测试条件超时');}

test('跨页采集本机去重、页面不得调用 AI，完成才发送并使用全局语言和自定义提示词',async t=>{
  const sent=[];
  const w=await worker(t,async(_url,init)=>{
    const body=JSON.parse(init.body),payload=JSON.parse(body.messages[1].content);sent.push({body,payload});
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(payload.inputs.map(i=>({id:i.id,category:'ui',action:'translate',translation:i.sourceText==='Save {count}'?'保存する {count}':'名前',reason:''})))}}]}));
  });
  await w.request('config',{ai:{provider:'api',model:'test',endpoint:'https://api.example.com/v1/chat/completions',apiKey:'secret'},prompt:'使用简洁措辞',preferences:{targetLanguage:'ja'}});
  assert.equal((await w.request('capture-start',{tabId:1})).ok,true);
  const c=w.local.wt_capture;
  const sender={id:'test',tab:{id:1},url:origin+'/signup'};
  const scan={origin,items:[{sourceText:'First name',context:'form/input/@placeholder',path:'/signup'}]};
  assert.equal((await w.request('capture-data',{captureId:c.id,scan},sender)).ok,true);
  await w.request('capture-data',{captureId:c.id,scan},sender);
  assert.equal(w.local.wt_capture.items.length,2);assert.equal(sent.length,0);
  assert.equal((await w.request('capture-data',{captureId:c.id,scan},{...sender,tab:{id:9}})).ok,false);
  assert.equal((await w.request('capture-finish',{},sender)).ok,false);
  assert.equal((await w.request('capture-finish')).ok,true);
  await until(()=>Object.values(w.local.wt_tasks).some(t=>t.status==='completed'));
  assert.equal(sent.length,1);assert.equal(sent[0].payload.targetLanguage,'ja');assert.match(sent[0].body.messages[0].content,/使用简洁措辞/);
  assert.deepEqual(sent[0].payload.inputs.map(i=>i.path).sort(),['/settings','/signup']);
  assert.equal(Object.keys((await w.request('state')).result.sites[origin].entries).length,2);
  assert.equal((await w.request('page',{},sender)).result.site.targetLanguage,'ja');
  await w.request('group-change',{group:'example.com',action:'enabled',enabled:false});
  assert.equal((await w.request('page',{},sender)).result.site.enabled,false);
  await w.request('group-change',{group:'example.com',action:'delete'});
  assert.equal((await w.request('state')).result.sites[origin].deleted,true);
});

test('取消采集清除草稿且不调用 AI；页面无权修改提示词和分组',async t=>{
  let calls=0;const w=await worker(t,async()=>{calls++;throw new Error('不应调用');});
  await w.request('capture-start',{tabId:1});
  assert.equal((await w.request('capture-cancel')).ok,true);assert.equal(w.local.wt_capture,undefined);assert.equal(calls,0);
  for(const type of ['config','group-change'])assert.equal((await w.request(type,{},{id:'test',tab:{id:1},url:origin})).ok,false);
});

test('采集启动立即保存当前页，SPA 使用快照路径而非 sender 的旧路径，错误可见并恢复',async t=>{
  const w=await worker(t);await w.request('capture-start',{tabId:1});
  assert.deepEqual(w.local.wt_capture.pages,[origin+'/settings']);assert.equal(w.local.wt_capture.items.length,1);
  const captureId=w.local.wt_capture.id;
  const sender={id:'test',url:origin+'/original-document',tab:{id:1,url:origin+'/routing'},frameId:0};
  const item=path=>({id:'t0',path,context:'main/h1/text',sourceText:'Logs'});
  const scan={origin,path:'/logs',items:[item('/logs')]};
  assert.equal((await w.request('capture-data',{captureId,scan},sender)).ok,true,'已发出的快照不能被随后 SPA 导航丢弃');
  assert.ok(w.local.wt_capture.pages.includes(origin+'/logs'));
  assert.equal((await w.request('capture-data',{captureId,scan:{origin,items:[item('/routing')]}},sender)).ok,true,'旧内容脚本也可使用 tab 的当前路径继续采集');
  const invalid=await w.request('capture-data',{captureId,scan:{...scan,items:[item('/wrong')]}},sender);assert.equal(invalid.ok,false);assert.match(w.local.wt_capture.lastError,/条目无效/);
  assert.equal((await w.request('capture-data',{captureId,scan},sender)).ok,true);assert.equal(w.local.wt_capture.lastError,null);
  assert.equal((await w.request('capture-data',{captureId,scan:{...scan,origin:'https://elsewhere.example'}},sender)).ok,false);
  assert.equal((await w.request('capture-data',{captureId,scan},{...sender,frameId:2})).ok,false);
  await w.request('change',{siteId:origin,kind:'setting',payload:{key:'excludedPaths',value:['/private']}});
  const excluded=await w.request('capture-data',{captureId,scan:{origin,path:'/private',items:[item('/private')]}},sender);assert.equal(excluded.result,false);assert.ok(!w.local.wt_capture.pages.includes(origin+'/private'));
});

test('合并服务后台使用原生机器翻译协议并保留各服务配置',async t=>{
  for(const provider of ['deepl','google','azure','qwen_mt']) {
    let sent;
    const w=await worker(t,async(url,init)=>{
      sent={url:String(url),headers:init.headers,body:JSON.parse(init.body)};
      const text='保存 {count}',data=provider==='deepl'?{translations:[{text}]}:provider==='google'?{data:{translations:[{translatedText:text}]}}:provider==='azure'?[{translations:[{text}]}]:{choices:[{message:{content:text}}]};
      return new Response(JSON.stringify(data));
    });
    assert.equal((await w.request('config',{ai:{provider,model:provider==='qwen_mt'?'fixture-model':'',endpoint:require('../extension/managed-providers').catalog[provider].endpoint,apiKey:'synthetic-key',region:'eastasia'}})).ok,true);
    assert.equal((await w.request('start',{tabId:1})).ok,true);await until(()=>Object.values(w.local.wt_tasks).some(t=>t.status!=='running'));
    assert.equal(Object.values(w.local.wt_tasks)[0].status,'completed',provider);assert.ok(sent);
    assert.equal(w.local.wt_ai_profiles[provider].apiKey,'synthetic-key');assert.ok(!C.canonical(w.local.wt_database).includes('synthetic-key'));
    if(provider==='google')assert.equal(sent.headers['X-goog-api-key'],'synthetic-key');
    if(provider==='azure')assert.match(sent.url,/api-version=3.0/);
  }
});
async function seededWorker(t,native){
  const w=await worker(t,async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify([{id:'t0',category:'ui',action:'translate',translation:'保存 {count}',reason:''}])}}]})),native);
  await w.request('config',{ai:{provider:'api',model:'test',endpoint:'https://api.example.com/v1/chat/completions',apiKey:'fixture'}});await w.request('start',{tabId:1});
  await until(()=>Object.values(w.local.wt_tasks).some(t=>t.status==='completed'));return w;
}
test('同步进行中的本地修改排入下一轮；旧对端确认立即失效',async t=>{
  let unblock,round=0;
  const w=await seededWorker(t,async m=>{
    if(m.action==='ack')return {peerConfirmed:true};round++;
    if(round===1)await new Promise(r=>unblock=r);
    return {ops:m.ops,invalid:0,directory:'fixture'};
  });
  await w.request('config',{sync:{enabled:true,directory:'fixture'}});await until(()=>!!unblock);
  await w.request('change',{siteId:origin,kind:'setting',payload:{key:'targetLanguage',value:'ja'}});assert.equal(w.local.wt_sync_status.peerConfirmed,false);
  unblock();await until(()=>round>=2 && w.local.wt_sync_status.pendingLocal===false);
  assert.equal(round,2);assert.equal(w.local.wt_sync_status.peerConfirmed,true);assert.equal(w.local.wt_sync_status.exported,w.local.wt_database.ops.length);
});
test('关闭同步后迟到导入不得落地或写确认，旧路径结果不显示成功',async t=>{
  let unblock,ack=0;const remote=builder();
  const w=await seededWorker(t,async m=>{if(m.action==='ack'){ack++;return {peerConfirmed:true};}await new Promise(r=>unblock=r);return {ops:[...m.ops,remote('delete',{},[m.ops.at(-1).opId])],invalid:0,directory:'old'};});
  await w.request('config',{sync:{enabled:true,directory:'old'}});await until(()=>!!unblock);
  await w.request('config',{sync:{enabled:false,directory:'new'}});unblock();await pause(100);assert.equal(w.local.wt_sync.directory,'new');assert.equal(w.local.wt_sync_status.error,undefined);
  assert.equal((await w.request('state')).result.sites[origin].deleted,false);assert.equal(ack,0);assert.equal(w.local.wt_sync_status.peerConfirmed,false);
});
test('对端确认写失败仍先应用导入的删除并通知已打开页面',async t=>{
  const remote=builder();let applied=false;
  const w=await seededWorker(t,async m=>{if(m.action==='ack')throw new Error('ack write failed');return {ops:[...m.ops,remote('delete',{},[m.ops.at(-1).opId])],invalid:0,directory:'fixture'};});
  w.chrome.tabs.query=async()=>[{id:1,url:origin+'/settings'}];w.chrome.tabs.sendMessage=async(_id,m)=>{if(m.type==='wt:apply' && m.site.deleted)applied=true;};
  await w.request('config',{sync:{enabled:true,directory:'fixture'}});await until(()=>!!w.local.wt_sync_status.error);
  assert.equal(applied,true);assert.equal((await w.request('state')).result.sites[origin].deleted,true);assert.match(w.local.wt_sync_status.error,/ack write failed/);
  assert.equal(w.local.wt_sync_status.directorySaved,true,'确认失败不能谎报已经写入的文件未保存');
});

test('启用时自动创建词库目录并验证读写；失败不启用，提示词独立保存',async t=>{
  const root=await temp(t);assert.equal((await confirmDirectory(root)).writable,true);
  assert.ok(!(await fs.promises.readdir(root)).some(n=>n.startsWith('check-')));
  const created=path.join(root,'new','dictionary');assert.equal((await confirmDirectory(created)).writable,true);assert.ok(fs.existsSync(path.join(created,'changes')));
  const blocked=path.join(root,'existing-file');fs.writeFileSync(blocked,'fixture');
  await assert.rejects(()=>confirmDirectory(path.join(blocked,'dictionary')));
  const w=await worker(t);w.chrome.runtime.sendNativeMessage=async(_host,m)=>({ok:true,result:await confirmDirectory(m.directory)});
  assert.equal((await w.request('config',{sync:{enabled:true,directory:path.join(blocked,'dictionary')}})).ok,false);
  assert.equal(w.local.wt_sync,undefined);
  await w.request('config',{prompt:'独立提示词'});assert.equal(w.local.wt_prompt,'独立提示词');
  await w.request('config',{ai:{provider:'deepl',endpoint:'https://api-free.deepl.com/v2/translate',apiKey:'synthetic',model:''}});
  assert.equal(w.local.wt_prompt,'独立提示词');assert.ok(!C.canonical(w.local.wt_database).includes('独立提示词'));
});

test('默认路径只在已有 OneDrive 根目录内自动创建，未配置时不创建替代根目录',async t=>{
  const root=await temp(t),os=require('node:os'),original=os.homedir;os.homedir=()=>root;
  try {
    await assert.rejects(()=>confirmDirectory(''),/未找到本机 OneDrive/);assert.equal(fs.existsSync(path.join(root,'OneDrive')),false);
    await fs.promises.mkdir(path.join(root,'OneDrive'));const result=await confirmDirectory('');assert.equal(result.directory,path.join(root,'OneDrive','文档','website-translator'));assert.equal(result.writable,true);
  }finally{os.homedir=original;}
});

test('已确认目录：翻译未结束就写入成功批次，人工修改随后自动落盘',async t=>{
  const root=await temp(t);let releaseSecond,requests=0,firstSize=0;
  const scanItems=Array.from({length:60},(_,i)=>({id:'t'+i,sourceText:'Label '+i+' 界面说明'.repeat(600),context:'nav/button/text',path:'/settings'}));
  const w=await worker(t,async(_url,init)=>{
    const {inputs}=JSON.parse(JSON.parse(init.body).messages[1].content);
    if(++requests===1)firstSize=inputs.length;if(requests===2)await new Promise(resolve=>releaseSecond=resolve);
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(inputs.map(i=>({id:i.id,action:'translate',category:'ui',translation:'译文',reason:''})))}}]}));
  });
  w.chrome.runtime.sendNativeMessage=async(_host,m)=>({ok:true,result:m.action==='confirm-directory'?await confirmDirectory(m.directory):m.action==='sync'?await exchange(m):await acknowledge(m)});
  w.chrome.tabs.sendMessage=async()=>({origin,items:scanItems});
  await w.request('config',{ai:{provider:'api',model:'fixture',apiKey:'synthetic-secret',endpoint:'https://api.example.com/v1/chat/completions'},sync:{enabled:true,directory:root}});
  assert.ok(w.local.wt_sync.confirmedAt);await w.request('start',{tabId:1});await until(()=>!!releaseSecond);
  await until(()=>w.local.wt_sync_status.directorySaved && w.local.wt_sync_status.exported>=firstSize+1);
  assert.equal(Object.values(w.local.wt_tasks)[0].status,'running');
  const readChanges=async()=>Promise.all((await fs.promises.readdir(path.join(root,'changes'))).filter(n=>n.endsWith('.json')).map(async n=>verify(JSON.parse(await fs.promises.readFile(path.join(root,'changes',n),'utf8')))));
  const written=(await readChanges()).filter(o=>o.kind==='entry').length;assert.ok(written>=firstSize && written<scanItems.length,'独立批次可以在另一批仍等待时先保存');
  releaseSecond();await until(()=>Object.values(w.local.wt_tasks)[0].status==='completed' && w.local.wt_sync_status.directorySaved);
  const manual={sourceText:scanItems[0].sourceText,context:'nav/button/text',path:'/settings',targetLanguage:'zh-Hans',sourceLanguage:null,action:'translate',category:'ui',origin:'manual',translation:'人工修正'};
  await w.request('change',{siteId:origin,kind:'entry',payload:manual});await until(()=>w.local.wt_sync_status.directorySaved && w.local.wt_sync_status.exported===w.local.wt_database.ops.length);
  const changes=await readChanges();assert.ok(changes.some(o=>o.payload.translation==='人工修正'));assert.ok(!C.canonical(changes).includes('synthetic-secret'));assert.equal(w.local.wt_sync_status.peerConfirmed,false);
});

test('文件写失败保留词库，浏览器闹钟自动重试；暂停后不继续写',async t=>{
  const root=await temp(t);let failing=true,syncs=0;
  const w=await seededWorker(t,async m=>{if(m.action==='ack')return {peerConfirmed:false};syncs++;if(failing)throw new Error('fixture disk unavailable');return exchange(m);});
  await w.request('config',{sync:{enabled:true,directory:root}});await until(()=>!!w.local.wt_sync_status.error);
  assert.equal(w.local.wt_sync_status.directorySaved,false);assert.ok(w.local.wt_database.ops.length);assert.ok(w.alarms.has('wt-sync-retry'));
  failing=false;w.alarmListeners.forEach(fn=>fn({name:'wt-sync-retry'}));await until(()=>w.local.wt_sync_status.directorySaved);await until(()=>!w.alarms.has('wt-sync-retry'));assert.ok(syncs>=2);
  await w.request('config',{sync:{enabled:false,directory:root}});const before=syncs;
  await w.request('change',{siteId:origin,kind:'setting',payload:{key:'enabled',value:false}});w.alarmListeners.forEach(fn=>fn({name:'wt-sync-retry'}));await pause(80);assert.equal(syncs,before);
});

test('本地主机授权拒绝明确显示当前扩展 ID 和重注册方法',async t=>{
  const w=await worker(t);w.chrome.runtime.sendNativeMessage=async()=>{throw new Error('Access to the specified native messaging host is forbidden.');};
  const result=await w.request('native',{action:'ping'});assert.equal(result.ok,false);assert.match(result.error,/未授权当前扩展（test）/);assert.match(result.error,/重新运行安装命令/);
});

const translationResponse=inputs=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(inputs.map(i=>({id:i.id,category:'ui',action:'translate',translation:'译文',reason:''})))}}]}));
const longInputs=()=>Array.from({length:60},(_,i)=>({id:'t'+i,sourceText:'Label '+i+' 界面说明'.repeat(600),context:'nav/button/text',path:'/settings'}));
async function configureFixture(w){await w.request('config',{ai:{provider:'api',model:'fixture-model',endpoint:'https://api.example.com/v1/chat/completions',apiKey:'synthetic-key'}});}

test('500 个短标签合并为一个请求，完成后清除重试草稿',async t=>{
  const lengths=[];const w=await worker(t,async(_url,init)=>{const {inputs}=JSON.parse(JSON.parse(init.body).messages[1].content);lengths.push(inputs.length);return translationResponse(inputs);});
  w.chrome.tabs.sendMessage=async()=>({origin,items:Array.from({length:500},(_,i)=>({id:'t'+i,sourceText:'Label '+i,context:'nav/button/text',path:'/settings'}))});
  await configureFixture(w);const started=await w.request('start',{tabId:1});await until(()=>w.local.wt_tasks[started.result.id].status!=='running');
  const task=w.local.wt_tasks[started.result.id];assert.equal(task.status,'completed',task.message);assert.deepEqual(lengths,[500]);assert.equal(task.completed,500);assert.equal(task.batchTotal,1);assert.equal(task.contextBudget,200000);assert.equal(w.local.wt_task_inputs[task.id],undefined);
});

test('长文本有限并发、429退避重试，任务保持启动时的模型配置',async t=>{
  let active=0,peak=0;const attempts=new Map(),models=[];
  const w=await worker(t,async(_url,init)=>{const body=JSON.parse(init.body),{inputs}=JSON.parse(body.messages[1].content),key=inputs[0].id;models.push(body.model);attempts.set(key,(attempts.get(key)||0)+1);active++;peak=Math.max(peak,active);await pause(20);active--;if(key==='t0' && attempts.get(key)===1)return new Response('{}',{status:429,headers:{'Retry-After':'0.1'}});return translationResponse(inputs);});
  w.chrome.tabs.sendMessage=async()=>({origin,items:longInputs()});await configureFixture(w);const started=await w.request('start',{tabId:1});await until(()=>models.length>=2);
  await w.request('config',{ai:{provider:'api',model:'other-model',endpoint:'https://other.example/v1/chat/completions',apiKey:'other-key'}});
  await until(()=>w.local.wt_tasks[started.result.id].status!=='running');const task=w.local.wt_tasks[started.result.id];assert.equal(task.status,'completed',task.message);assert.equal(peak,2);assert.equal(task.retries,1);assert.ok(models.every(m=>m==='fixture-model'));assert.equal(attempts.get('t0'),2);assert.equal(task.completed,60);
});

test('失败批次自动重试耗尽后保留成功结果，手动只重试剩余文本',async t=>{
  let failing=true;const sent=[];
  const w=await worker(t,async(_url,init)=>{const {inputs}=JSON.parse(JSON.parse(init.body).messages[1].content);sent.push(inputs.map(i=>i.sourceText));if(failing && inputs[0].id==='t0')return new Response('{}',{status:503});return translationResponse(inputs);});
  w.chrome.tabs.sendMessage=async()=>({origin,items:longInputs()});await configureFixture(w);const started=await w.request('start',{tabId:1});await until(()=>w.local.wt_tasks[started.result.id].status!=='running');
  const task=w.local.wt_tasks[started.result.id];assert.equal(task.status,'partial',task.message);assert.ok(task.completed>0 && task.completed<60);assert.equal(task.retries,2);
  const saved=Object.values((await w.request('state')).result.sites[origin].entries).map(e=>e.sourceText),pending=w.local.wt_task_inputs[task.id].items;assert.equal(saved.length+pending.length,60);assert.equal((await w.request('state')).result.wt_tasks[task.id].canRetry,true);
  failing=false;const before=sent.length;assert.equal((await w.request('retry-task',{taskId:task.id})).ok,true);await until(()=>w.local.wt_tasks[task.id].status!=='running');
  assert.equal(w.local.wt_tasks[task.id].status,'completed');assert.ok(sent.slice(before).flat().every(source=>!saved.includes(source)));assert.equal(Object.keys((await w.request('state')).result.sites[origin].entries).length,60);assert.equal(w.local.wt_task_inputs[task.id],undefined);
});

test('服务上下文限制触发按文本量拆分，独立批次成功即保存',async t=>{
  const lengths=[];const w=await worker(t,async(_url,init)=>{const {inputs}=JSON.parse(JSON.parse(init.body).messages[1].content);lengths.push(inputs.length);return inputs.length>50?new Response(JSON.stringify({error:{code:'context_length_exceeded'}}),{status:400}):translationResponse(inputs);});
  w.chrome.tabs.sendMessage=async()=>({origin,items:Array.from({length:120},(_,i)=>({id:'t'+i,sourceText:'Label '+i,context:'nav/button/text',path:'/settings'}))});await configureFixture(w);const started=await w.request('start',{tabId:1});await until(()=>w.local.wt_tasks[started.result.id].status!=='running');
  const task=w.local.wt_tasks[started.result.id];assert.equal(task.status,'completed',task.message);assert.equal(lengths[0],120);assert.ok(lengths.slice(1).some(n=>n<=50));assert.ok(task.splits>=1);assert.equal(task.completed,120);
});

test('持续拒绝大批次时拆分有总量上限，保留已成功条目和剩余输入',async t=>{
  let calls=0;const w=await worker(t,async(_url,init)=>{calls++;const {inputs}=JSON.parse(JSON.parse(init.body).messages[1].content);return inputs.length>1?new Response(JSON.stringify({error:{code:'context_length_exceeded'}}),{status:400}):translationResponse(inputs);});
  w.chrome.tabs.sendMessage=async()=>({origin,items:Array.from({length:40},(_,i)=>({id:'t'+i,sourceText:'Label '+i,context:'nav/button/text',path:'/settings'}))});await configureFixture(w);const started=await w.request('start',{tabId:1});await until(()=>w.local.wt_tasks[started.result.id].status!=='running');
  const task=w.local.wt_tasks[started.result.id];assert.equal(task.status,'partial');assert.equal(task.splits,16);assert.ok(calls<50);assert.ok(task.completed>0 && task.completed<40);assert.equal(w.local.wt_task_inputs[task.id].items.length,40-task.completed);
});

test('两个网站任务共用最多两个请求槽',async t=>{
  let active=0,peak=0;const second='https://second.example.com';
  const w=await worker(t,async(_url,init)=>{const {inputs}=JSON.parse(JSON.parse(init.body).messages[1].content);active++;peak=Math.max(peak,active);await pause(20);active--;return translationResponse(inputs);});
  w.chrome.tabs.get=async id=>({id,url:(id===1?origin:second)+'/settings'});w.chrome.tabs.sendMessage=async id=>({origin:id===1?origin:second,items:longInputs()});await configureFixture(w);
  const [a,b]=await Promise.all([w.request('start',{tabId:1}),w.request('start',{tabId:2})]);assert.equal(a.ok,true);assert.equal(b.ok,true);await until(()=>Object.values(w.local.wt_tasks).every(t=>t.status!=='running'));assert.equal(peak,2);assert.ok(Object.values(w.local.wt_tasks).every(t=>t.status==='completed'));
});

test('一次采集的两个子域名并发翻译，提交时已持久化全部可恢复输入',async t=>{
  const second='https://app.example.com',releases=[];const w=await worker(t,async(_url,init)=>{const {inputs}=JSON.parse(JSON.parse(init.body).messages[1].content);await new Promise(r=>releases.push(r));return translationResponse(inputs);});
  w.chrome.tabs.get=async id=>({id,url:(id===1?origin:second)+'/settings',...(id===2?{openerTabId:1}:{})});
  w.chrome.tabs.sendMessage=async id=>({origin:id===1?origin:second,path:'/settings',items:[{id:'t0',sourceText:id===1?'Root action':'Child action',context:'nav/button/text',path:'/settings'}]});
  await configureFixture(w);await w.request('capture-start',{tabId:1});const captureId=w.local.wt_capture.id;
  await w.request('page',{}, {id:'test',url:second+'/settings',tab:{id:2}});
  await w.request('capture-data',{captureId,scan:await w.chrome.tabs.sendMessage(2)},{id:'test',url:second+'/settings',tab:{id:2},frameId:0});
  assert.equal((await w.request('capture-finish')).ok,true);assert.equal(Object.keys(w.local.wt_task_inputs).length,2);
  await until(()=>releases.length===2);releases.forEach(r=>r());await until(()=>Object.values(w.local.wt_tasks).every(t=>t.status==='completed'));assert.equal(Object.keys(w.local.wt_task_inputs).length,0);
});


test('常规超时校验、局部设置保留及 API 请求固定启动值',async t=>{
  const timeouts=[];let calls=0;
  const w=await worker(t,async()=>{calls++;return translationResponse([{id:'t0'}]);},null,{AbortSignal:{timeout:ms=>{timeouts.push(ms);return new AbortController().signal;}}});
  assert.equal((await w.request('state')).result.wt_preferences.requestTimeoutMinutes,3);
  for(const value of [0,61,1.5,'5',null]) {
    if(value===null)continue;
    assert.equal((await w.request('config',{preferences:{requestTimeoutMinutes:value}})).ok,false);
  }
  await configureFixture(w);assert.equal((await w.request('config',{preferences:{requestTimeoutMinutes:12}})).ok,true);
  await w.request('config',{preferences:{targetLanguage:'ja'}});
  assert.equal((await w.request('state')).result.wt_preferences.requestTimeoutMinutes,12);
  const started=await w.request('start',{tabId:1});await until(()=>w.local.wt_tasks[started.result.id].status!=='running');
  assert.ok(timeouts.length);assert.ok(timeouts.every(ms=>ms===720000));assert.equal(calls,3); // Invalid placeholder result is retried without changing timeout.
  await w.request('config',{preferences:{requestTimeoutMinutes:20}});
  await w.request('retry-task',{taskId:started.result.id});await until(()=>w.local.wt_tasks[started.result.id].status!=='running');
  assert.equal(timeouts.at(-1),1200000);
});

test('自动展开秒数校验、局部保存保留并传递到页面与新扫描',async t=>{
  const w=await worker(t,async()=>translationResponse([]));await configureFixture(w);
  assert.equal((await w.request('state')).result.wt_preferences.autoExpandSeconds,12);
  for(const value of [0,121,1.5,'30',null])assert.equal((await w.request('config',{preferences:{autoExpandSeconds:value}})).ok,false);
  assert.equal((await w.request('config',{preferences:{autoExpandSeconds:45}})).ok,true);
  await w.request('config',{preferences:{inputContextK:50}});assert.equal((await w.request('state')).result.wt_preferences.autoExpandSeconds,45);
  const pageState=await w.request('page',{}, {id:'test',url:origin+'/settings',tab:{id:1}});assert.equal(pageState.result.autoExpandSeconds,45);
  const scans=[];w.chrome.tabs.sendMessage=async(_id,m)=>{if(m.type==='wt:collect')scans.push(m);return {origin,path:'/settings',items:[],truncated:false};};
  const task=await w.request('start',{tabId:1});await until(()=>w.local.wt_tasks[task.result.id].status!=='running');
  assert.equal(scans[0].autoExpandSeconds,45);assert.equal(scans[0].expand,true);
});

function selectedFixture(w,sourceText='Missing text'){
  const item={sourceText,context:'main/p/text',path:'/settings'};
  w.chrome.tabs.sendMessage=async(_id,message)=>message.type==='wt:selection'?{ok:true,result:{origin,path:'/settings',items:[item],blocked:0}}:{origin,path:'/other',items:[],truncated:false};
  return item;
}

test('右键队列无 AI 请求、去重、旧 skip 补译、跨页处理和语言隔离',async t=>{
  const sent=[];const w=await worker(t,async(_url,init)=>{const payload=JSON.parse(JSON.parse(init.body).messages[1].content);sent.push(payload);return translationResponse(payload.inputs);});
  await configureFixture(w);const item=selectedFixture(w);
  await w.menuClick();assert.equal(sent.length,0);assert.equal(w.local.wt_manual_queue.length,1);assert.equal(w.menus.get('wt-add-selection').contexts[0],'selection');
  await w.menuClick();assert.equal(w.local.wt_manual_queue.length,1);
  await w.request('change',{siteId:origin,kind:'entry',payload:{...item,sourceLanguage:null,targetLanguage:'zh-Hans',origin:'ai',category:'uncertain',action:'skip',translation:null}});
  await w.request('config',{preferences:{targetLanguage:'ja'}});
  let started=await w.request('start',{tabId:1});await until(()=>w.local.wt_tasks[started.result.id].status!=='running');assert.equal(sent.length,0);assert.equal(w.local.wt_manual_queue.length,1);
  await w.request('config',{preferences:{targetLanguage:'zh-Hans'}});
  started=await w.request('start',{tabId:1});await until(()=>w.local.wt_tasks[started.result.id].status!=='running');
  assert.equal(w.local.wt_tasks[started.result.id].status,'completed');assert.equal(sent.length,1);assert.equal(sent[0].inputs[0].userSelected,true);assert.equal(sent[0].inputs[0].path,'/settings');assert.equal(sent[0].inputs[0].queueId,undefined);
  assert.equal(w.local.wt_manual_queue.length,0);
  const saved=Object.values((await w.request('state')).result.sites[origin].entries)[0];assert.equal(saved.action,'translate');assert.equal(saved.userSelected,true);assert.equal(saved.origin,'ai');
  await w.menuClick();assert.equal(w.local.wt_manual_queue.length,1);assert.equal(sent.length,1);
  await w.request('change',{siteId:origin,kind:'entry',payload:{...saved,origin:'manual',translation:'人工旧译'}});
  started=await w.request('start',{tabId:1});await until(()=>w.local.wt_tasks[started.result.id].status!=='running');assert.equal(sent.length,2);assert.equal(w.local.wt_manual_queue.length,0);assert.equal(Object.values((await w.request('state')).result.sites[origin].entries)[0].translation,'译文');
});

test('手动项仍被服务跳过时保留原文，移除会同时撤销重试草稿；页面无写队列权限',async t=>{
  const w=await worker(t,async(_url,init)=>{const {inputs}=JSON.parse(JSON.parse(init.body).messages[1].content);return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(inputs.map(item=>({id:item.id,category:'uncertain',action:'skip',translation:null,reason:'uncertain'})))}}]}));});
  await configureFixture(w);selectedFixture(w);await w.menuClick();const queued=w.local.wt_manual_queue[0];
  const started=await w.request('start',{tabId:1});await until(()=>w.local.wt_tasks[started.result.id].status!=='running');
  const task=w.local.wt_tasks[started.result.id];assert.equal(task.status,'failed');assert.match(task.message,/手动指定内容/);assert.equal(task.completed,0);assert.equal(w.local.wt_manual_queue.length,1);assert.equal(w.local.wt_task_inputs[task.id].items.length,1);
  assert.equal((await w.request('manual-remove',{id:queued.id},{id:'test',url:origin+'/settings',tab:{id:1}})).ok,false);
  assert.equal((await w.request('manual-remove',{id:queued.id})).ok,true);assert.equal(w.local.wt_manual_queue.length,0);assert.equal(w.local.wt_task_inputs[task.id],undefined);
});

test('右键尊重 iframe、输入区、网站停用、排除路径和删除代次',async t=>{
  const w=await worker(t,()=>assert.fail('must not translate'));selectedFixture(w);
  await w.menuClick({frameId:2});assert.match(w.local.wt_selection_status.message,/iframe/);
  await w.menuClick({editable:true});assert.match(w.local.wt_selection_status.message,/输入区域/);
  await w.menuClick();assert.equal(w.local.wt_manual_queue.length,1);
  await w.request('change',{siteId:origin,kind:'setting',payload:{key:'enabled',value:false}});await w.menuClick();assert.match(w.local.wt_selection_status.message,/停用/);
  await w.request('change',{siteId:origin,kind:'setting',payload:{key:'enabled',value:true}});
  await w.request('change',{siteId:origin,kind:'setting',payload:{key:'excludedPaths',value:['/settings']}});await w.menuClick();assert.match(w.local.wt_selection_status.message,/排除/);
  await w.request('change',{siteId:origin,kind:'delete',payload:{}});assert.equal((await w.request('state')).result.wt_manual_queue.length,0);
  selectedFixture(w,'New generation');await w.menuClick();assert.equal(w.local.wt_manual_queue.length,1);assert.equal(w.local.wt_manual_queue[0].generation,2);
});

test('选区补全节点、保留结构与原文，手动译文可越过普通误筛但仍保护设备名',async t=>{
  const p=await page(t),w=p.window,d=w.document;
  d.querySelector('main').insertAdjacentHTML('beforeend','<p class="account-settings"><span>Account preferences</span> <a href="/help">Learn more</a></p><p class="device-name">Private machine</p>');
  const choose=async(el,start=0,end=el.firstChild.length)=>{const range=d.createRange();range.setStart(el.firstChild,start);range.setEnd(el.firstChild,end);w.getSelection().removeAllRanges();w.getSelection().addRange(range);el.dispatchEvent(new w.MouseEvent('contextmenu',{bubbles:true}));return p.request({type:'wt:selection',selectionText:w.getSelection().toString()});};
  const span=d.querySelector('.account-settings span');span.className='account-panel';const selected=await choose(span,2,6);assert.equal(selected.ok,true);assert.equal(selected.result.items[0].sourceText,'Account preferences');
  const e={...selected.result.items[0],sourceLanguage:null,targetLanguage:'zh-Hans',origin:'ai',category:'stable_content',action:'translate',translation:'账户偏好',userSelected:true};p.site.entries[C.entryKey(e)]=e;await p.update(p.site);assert.equal(span.textContent,'账户偏好');assert.equal(d.querySelector('a').getAttribute('href'),'/help');
  assert.equal((await choose(span)).result.items[0].sourceText,'Account preferences');
  assert.equal((await choose(d.querySelector('pre'))).ok,false);assert.equal((await choose(d.querySelector('.device-name'))).ok,false);assert.equal((await choose(d.querySelector('[data-device-name]'))).ok,false);
  const range=d.createRange();range.selectNodeContents(d.querySelector('.account-settings'));w.getSelection().removeAllRanges();w.getSelection().addRange(range);d.body.dispatchEvent(new w.MouseEvent('contextmenu',{bubbles:true}));
  const multi=await p.request({type:'wt:selection',selectionText:w.getSelection().toString()});assert.deepEqual(Array.from(multi.result.items,item=>item.sourceText),['Account preferences','Learn more']);
  await p.update({...p.site,enabled:false});assert.equal(span.textContent,'Account preferences');
});

test('手动选区可加入普通扫描 500 项之后的文字，拒绝已经改变的选区',async t=>{
  const p=await page(t),w=p.window,d=w.document;d.querySelector('main').innerHTML=Array.from({length:510},(_,i)=>'<p>Option '+i+'</p>').join('');
  assert.equal(w.WTPage.collect().items.length,500);
  const node=d.querySelector('main').lastChild.firstChild,range=d.createRange();range.selectNodeContents(node);w.getSelection().removeAllRanges();w.getSelection().addRange(range);d.body.dispatchEvent(new w.MouseEvent('contextmenu',{bubbles:true}));
  const result=await p.request({type:'wt:selection',selectionText:'Option 509'});assert.equal(result.result.items[0].sourceText,'Option 509');
  d.body.dispatchEvent(new w.MouseEvent('contextmenu',{bubbles:true}));node.data='Changed';assert.equal((await p.request({type:'wt:selection',selectionText:'Option 509'})).ok,false);
});


test('订阅长连接传递超时设置，流超时进入自动重试并保留手动队列直到成功',async t=>{
  const {OAuth}=require('../native/oauth.cjs');let attempts=0;const minutes=[];
  const oauth=new OAuth('unused-fixture-directory');oauth.withSession=run=>run('synthetic',new AbortController().signal);
  oauth.fetch=async(_url,init)=>{const inputs=JSON.parse(JSON.parse(init.body).input[0].content).inputs;return {ok:true,body:(async function*(){attempts++;if(attempts<2)throw new DOMException('The operation was aborted due to timeout','TimeoutError');const output=JSON.stringify(inputs.map(item=>({id:item.id,category:'stable_content',action:'translate',translation:'译文',reason:''})));yield Buffer.from('data: '+JSON.stringify({type:'response.output_text.delta',delta:output})+'\n\n'+'data: {"type":"response.completed","response":{"status":"completed"}}\n\n');})()};};
  const w=await worker(t,()=>assert.fail('API not expected'));let connections=0,disconnections=0;
  w.chrome.runtime.connectNative=()=>{connections++;let onMessage;return {onMessage:{addListener:fn=>onMessage=fn},onDisconnect:{addListener(){}},disconnect:()=>disconnections++,postMessage:message=>{minutes.push(message.timeoutMinutes);oauth.translate(message.model,message.payload,message.prompt,message.reasoningEffort,message.timeoutMinutes).then(result=>onMessage({ok:true,result}),e=>onMessage({ok:false,error:e.message,kind:e.kind}));}};};
  await w.request('config',{ai:{provider:'chatgpt',model:'fixture'},preferences:{requestTimeoutMinutes:9}});selectedFixture(w);await w.menuClick();
  const started=await w.request('start',{tabId:1});await until(()=>w.local.wt_tasks[started.result.id].status!=='running');
  const task=w.local.wt_tasks[started.result.id];assert.equal(task.status,'completed',task.message);assert.equal(task.retries,1);assert.equal(w.local.wt_manual_queue.length,0);assert.deepEqual(minutes,[9,9]);assert.equal(connections,2);assert.equal(disconnections,2);
});


test('普通采集为空时完成采集仍处理已访问网站的手动队列',async t=>{
  let calls=0;const w=await worker(t,async(_url,init)=>{calls++;const {inputs}=JSON.parse(JSON.parse(init.body).messages[1].content);return translationResponse(inputs);});
  await configureFixture(w);selectedFixture(w);await w.menuClick();
  const before=w.chrome.tabs.sendMessage;
  w.chrome.tabs.sendMessage=async(id,message)=>message.type==='wt:collect'?{origin,path:'/settings',items:[],truncated:false}:before(id,message);
  assert.equal((await w.request('capture-start',{tabId:1})).ok,true);assert.equal(w.local.wt_capture.items.length,0);
  const finished=await w.request('capture-finish');assert.equal(finished.ok,true,finished.error);await until(()=>Object.values(w.local.wt_tasks).some(task=>task.status==='completed'));
  assert.equal(calls,1);assert.equal(w.local.wt_manual_queue.length,0);
});


test('机器翻译可处理手动指定正文；失败任务重试不会带入之后新加的队列项',async t=>{
  let fail=true;const sent=[];const w=await worker(t,async(_url,init)=>{const body=JSON.parse(init.body);sent.push(body.text);return fail?new Response('{}',{status:401}):new Response(JSON.stringify({translations:body.text.map(()=>({text:'译文'}))}));});
  assert.equal((await w.request('config',{ai:{provider:'deepl',model:'',apiKey:'synthetic',endpoint:'https://api-free.deepl.com/v2/translate'}})).ok,true);
  selectedFixture(w,'First selection');await w.menuClick();let started=await w.request('start',{tabId:1});await until(()=>w.local.wt_tasks[started.result.id].status!=='running');assert.equal(w.local.wt_tasks[started.result.id].status,'failed');
  selectedFixture(w,'Second selection');await w.menuClick();fail=false;
  await w.request('retry-task',{taskId:started.result.id});await until(()=>w.local.wt_tasks[started.result.id].status!=='running');assert.equal(w.local.wt_tasks[started.result.id].status,'completed');assert.deepEqual(sent.at(-1),['First selection']);assert.equal(w.local.wt_manual_queue.length,1);assert.equal(w.local.wt_manual_queue[0].sourceText,'Second selection');
});


test('同节点邮箱前标签可单独补译，邮箱不进入队列或采集，刷新和邮箱变化继续本地复用',async t=>{
  const p=await page(t),w=p.window,d=w.document;d.querySelector('main').innerHTML='<p>Personal Account: fixture@example.com</p>';
  const el=d.querySelector('p');
  const choose=async(start,end)=>{const r=d.createRange();r.setStart(el.firstChild,start);r.setEnd(el.firstChild,end);w.getSelection().removeAllRanges();w.getSelection().addRange(r);el.dispatchEvent(new w.MouseEvent('contextmenu',{bubbles:true}));return p.request({type:'wt:selection',selectionText:w.getSelection().toString()});};
  assert.equal(w.WTPage.collect().items.length,0);
  assert.equal((await choose(18,25)).ok,false);assert.equal((await choose(0,22)).ok,false);
  const selected=await choose(0,16);assert.equal(selected.ok,true);assert.equal(selected.result.items[0].sourceText,'Personal Account');assert.equal(JSON.stringify(selected.result).includes('fixture@example.com'),false);
  const e={...selected.result.items[0],sourceLanguage:null,targetLanguage:'zh-Hans',origin:'ai',category:'ui',action:'translate',translation:'个人账户',userSelected:true};p.site.entries[C.entryKey(e)]=e;
  await p.update(p.site);assert.equal(el.textContent,'个人账户: fixture@example.com');assert.equal(w.WTPage.collect().items.length,0);
  assert.equal((await choose(0,4)).result.items[0].sourceText,'Personal Account');
  el.firstChild.data='Personal Account: changed@example.net';await pause(150);assert.equal(el.textContent,'个人账户: changed@example.net');
  el.replaceChildren(d.createTextNode('Personal Account: fixture@example.com'));await pause(150);assert.equal(el.textContent,'个人账户: fixture@example.com');
  await p.update({...p.site,targetLanguage:'ja'});assert.equal(el.textContent,'Personal Account: fixture@example.com');
  await p.update({...p.site,enabled:false});assert.equal(el.textContent,'Personal Account: fixture@example.com');
  el.setAttribute('data-private','');assert.equal((await choose(0,16)).ok,false);
});


test('已翻译和 skip 在单页上限前过滤，后续内容及属性不再被饿死，设置按语言生效',async t=>{
  const p=await page(t),w=p.window,d=w.document;d.querySelector('main').innerHTML=Array.from({length:800},(_,i)=>'<p>Entry '+i+'</p>').join('')+'<input placeholder="New prompt">';
  for(let i=0;i<500;i++){const e={sourceText:'Entry '+i,context:'main/p/text',path:'/settings',sourceLanguage:null,targetLanguage:'zh-Hans',origin:'ai',category:i%2?'uncertain':'ui',action:i%2?'skip':'translate',translation:i%2?null:'译文'};p.site.entries[C.entryKey(e)]=e;}
  await p.update(p.site);let scan=w.WTPage.collect();assert.equal(scan.items.length,301);assert.equal(scan.items[0].sourceText,'Entry 500');assert.equal(scan.items.at(-1).sourceText,'New prompt');assert.equal(scan.reused,500);assert.equal(scan.truncated,false);
  scan=await p.request({type:'wt:collect',site:p.site,captureLimits:{pageCaptureItems:2}});assert.equal(scan.items.length,2);assert.equal(scan.truncated,true);
  scan=await p.request({type:'wt:collect',site:p.site,captureLimits:{pageCaptureChars:9}});assert.equal(scan.items.length,1);
  scan=await p.request({type:'wt:collect',site:{...p.site,targetLanguage:'ja'},captureLimits:{pageCaptureItems:10}});assert.equal(scan.items[0].sourceText,'Entry 0');assert.equal(scan.items.length,10);
});

test('采集设置校验、后台过滤已有词条并在会话额度前合并跨页公共 UI，保留全部路径',async t=>{
  const w=await worker(t,async(_url,init)=>{const {inputs}=JSON.parse(JSON.parse(init.body).messages[1].content);return translationResponse(inputs);});await configureFixture(w);
  for(const prefs of [{pageCaptureItems:0},{sessionCaptureChars:2000001},{inputContextK:1001},{pageCaptureChars:2.2}])assert.equal((await w.request('config',{preferences:prefs})).ok,false);
  assert.equal((await w.request('config',{preferences:{pageCaptureItems:1000,sessionCaptureItems:2,inputContextK:10}})).ok,true);
  w.chrome.tabs.sendMessage=async()=>({origin,path:'/settings',items:[],truncated:false});await w.request('capture-start',{tabId:1});const captureId=w.local.wt_capture.id;
  const send=async(path,items)=>w.request('capture-data',{captureId,scan:{origin,path,items:items.map(([sourceText,context])=>({sourceText,context,path})),truncated:false}},{id:'test',url:origin+path,tab:{id:1,url:origin+path},frameId:0});
  await w.request('change',{siteId:origin,kind:'entry',payload:{...entry(),sourceText:'Known',translation:'已知',context:'nav/button/text',path:'/settings'}});
  await send('/one',[['Known','nav/button/text'],['Shared','nav/button/text']]);await send('/two',[['Shared','nav/button/text'],['New body','main/p/text']]);
  assert.equal(w.local.wt_capture.items.length,2);assert.deepEqual(w.local.wt_capture.items[0].paths,['/two']);assert.equal(w.local.wt_capture.truncated,false);
  await send('/three',[['Overflow','main/p/text']]);assert.equal(w.local.wt_capture.truncated,true);assert.equal(w.local.wt_capture.items.length,2);
  const state=await w.request('page',{}, {id:'test',url:origin+'/settings',tab:{id:1}});assert.equal(state.result.captureLimits.pageCaptureItems,1000);
  await w.request('capture-finish');await until(()=>Object.values(w.local.wt_tasks).some(task=>task.status==='completed'));const saved=Object.values((await w.request('state')).result.sites[origin].entries);assert.deepEqual(saved.filter(e=>e.sourceText==='Shared').map(e=>e.path).sort(),['/one','/two']);assert.equal(Object.values(w.local.wt_tasks)[0].contextBudget,10000);
});
