'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');
const read=name=>fs.readFileSync(path.resolve(__dirname,'../extension',name),'utf8');
test('后台本机读取未返回时，弹窗设置入口立即可点击且显示启动提示',async t=>{
 const html=fs.readFileSync(path.resolve(__dirname,'../edge/popup/popup.html'),'utf8');const dom=new JSDOM(html,{url:'https://fixture.invalid/',runScripts:'outside-only'});t.after(()=>dom.window.close());let opened;
 dom.window.chrome={runtime:{id:'fixture',getURL:p=>'chrome-extension://fixture/'+p,sendMessage:()=>new Promise(()=>{})},tabs:{query:async()=>[],create:async options=>{opened=options.url;}},storage:{sync:{set:async()=>{}},onChanged:{addListener(){}}}};
 dom.window.eval(read('managed-ui.js'));dom.window.document.querySelector('#wtManage').click();await new Promise(r=>setTimeout(r,10));assert.match(opened,/managed\/managed.html$/);assert.equal(dom.window.document.querySelector('main').hasAttribute('inert'),false);assert.match(dom.window.document.querySelector('#wtProgress').textContent,/读取本机/);
});
test('服务选择切换字段、按钮与独立草稿，标签页和主域名分组操作',async t=>{
  const dom=new JSDOM(read('managed.html'),{url:'https://fixture.invalid/',runScripts:'outside-only'});t.after(()=>dom.window.close());const w=dom.window,d=w.document,calls=[];
  const site=origin=>({id:origin,origin,name:origin,group:'example.com',enabled:true,entries:{},conflicts:{},excludedPaths:[],authorized:true});
  const state={sites:{a:site('https://example.com'),b:site('https://app.example.com')},wt_tasks:{},wt_ai:{provider:'api',endpoint:'https://gateway.example.com/v1/chat/completions',model:'fixture',apiKey:'local-key'},wt_ai_profiles:{deepl:{provider:'deepl',endpoint:'https://api-free.deepl.com/v2/translate',apiKey:'deepl-key'}},defaultPrompt:'default',globalEnabled:true};
  w.chrome={runtime:{id:'fixture',sendMessage:async m=>{calls.push(m);return {ok:true,result:m.type==='wt:state'?state:true};}},storage:{onChanged:{addListener(){}}}};
  w.eval(read('managed-providers.js'));w.eval(read('managed-ui.js'));await new Promise(r=>setTimeout(r,20));
  d.querySelector('#prompt').value='全局提示词草稿';
  assert.equal(d.querySelector('#targetLanguage').tagName,'SELECT');assert.equal(d.querySelectorAll('datalist,input[list]').length,0);
  const choose=id=>{d.querySelector('#provider').value=id;d.querySelector('#provider').dispatchEvent(new w.Event('change'));};
  assert.equal(d.querySelectorAll('#provider option').length,13);assert.equal(d.querySelectorAll('[role=tab]').length,5);assert.equal(d.querySelector('#helper').hidden,true);choose('chatgpt');
  assert.equal(d.querySelector('#helper').hidden,false);assert.equal(d.querySelector('#helper').closest('section').id,'ai');
  assert.equal(d.querySelector('#endpointField').hidden,true);assert.equal(d.querySelector('#apiKey').disabled,true);assert.equal(d.querySelector('#reasoningField').hidden,false);assert.equal(d.querySelector('#modelSelect').hidden,false);assert.equal(d.querySelector('#model').hidden,true);assert.equal(d.querySelector('#login').hidden,false);
  d.querySelector('#reasoningEffort').value='high';choose('deepl');assert.equal(d.querySelector('#apiKey').value,'deepl-key');assert.equal(d.querySelector('#model').disabled,true);assert.equal(d.querySelector('#promptField').hidden,false);assert.equal(d.querySelector('#prompt').disabled,false);
  choose('azure');assert.equal(d.querySelector('#regionField').hidden,false);assert.equal(d.querySelector('#apiKey').value,'');assert.equal(d.querySelector('#helper').hidden,true);
  choose('api');assert.equal(d.querySelector('#apiKey').value,'local-key');choose('chatgpt');assert.equal(d.querySelector('#reasoningEffort').value,'high');
  assert.equal(d.querySelector('#prompt').value,'全局提示词草稿');assert.equal(d.querySelector('#prompt').closest('form').id,'promptForm');
  d.querySelector('#tab-sync').click();assert.ok(d.querySelector('#repositoryForm'));assert.equal(d.querySelector('#syncHelper'),null);assert.equal(d.querySelector('#tab-sync').textContent,'GitHub 仓库');
  d.querySelector('#tab-websites').click();assert.equal(d.querySelector('#general').hidden,true);assert.equal(d.querySelector('#websites').hidden,false);
  assert.equal(d.querySelectorAll('.domain-group').length,1);assert.equal(d.querySelectorAll('.site').length,2);assert.equal(d.querySelectorAll('[aria-label="BCP 47 目标语言"]').length,0);
  d.querySelector('.group-actions button').click();await new Promise(r=>setTimeout(r,20));assert.ok(calls.some(m=>m.type==='wt:group-change' && m.group==='example.com' && m.enabled===false));
});
test('登录端口无错误断开或返回未验证身份时 UI 不挂起、不声称成功',async t=>{
  for(const mode of ['disconnect','unverified']){
    const dom=new JSDOM(read('managed.html'),{url:'https://fixture.invalid/',runScripts:'outside-only'});t.after(()=>dom.window.close());
    let disconnected,message;
    const port={onMessage:{addListener:f=>message=f},onDisconnect:{addListener:f=>disconnected=f},postMessage:()=>queueMicrotask(()=>mode==='disconnect'?disconnected():message({ok:true,result:{signedIn:false}})),disconnect:()=>{}};
    dom.window.chrome={runtime:{id:'fixture',connectNative:()=>port,sendMessage:async()=>({ok:true,result:{sites:{},wt_tasks:{}}})},storage:{onChanged:{addListener:()=>{}}}};
    dom.window.eval(read('managed-providers.js'));dom.window.eval(read('managed-ui.js'));await new Promise(r=>setTimeout(r,10));dom.window.document.querySelector('#login').click();await new Promise(r=>setTimeout(r,10));
    assert.equal(dom.window.document.querySelector('#login').disabled,false);assert.match(dom.window.document.querySelector('#message').textContent,mode==='disconnect'?/断开/:/未返回已验证/);
  }
});

test('翻译记录显示动态批次，重试按钮只提交任务 ID',async t=>{
  const dom=new JSDOM(read('managed.html'),{url:'https://fixture.invalid/#tasks',runScripts:'outside-only'});t.after(()=>dom.window.close());const calls=[];
  const state={sites:{},wt_tasks:{job:{id:'job',siteId:'https://example.com',targetLanguage:'zh-Hans',status:'partial',completed:100,total:120,translated:100,batchTotal:3,batchCompleted:2,retries:2,canRetry:true}},defaultPrompt:'fixture'};
  dom.window.chrome={runtime:{id:'fixture',sendMessage:async m=>{calls.push(m);return {ok:true,result:m.type==='wt:state'?state:true};}},storage:{onChanged:{addListener(){}}}};
  dom.window.eval(read('managed-providers.js'));dom.window.eval(read('managed-ui.js'));await new Promise(r=>setTimeout(r,20));
  const list=dom.window.document.querySelector('#taskList');assert.match(list.textContent,/动态批次 2\/3/);assert.match(list.textContent,/重试 2 次/);list.querySelector('button').click();await new Promise(r=>setTimeout(r,20));assert.deepEqual(JSON.parse(JSON.stringify(calls.find(m=>m.type==='wt:retry-task'))),{type:'wt:retry-task',taskId:'job'});
});


test('常规分钟设置回显保存，待翻译列表展示原文、语言并按 ID 移除',async t=>{
  const dom=new JSDOM(read('managed.html'),{url:'https://fixture.invalid/',runScripts:'outside-only'});t.after(()=>dom.window.close());const w=dom.window,d=w.document,calls=[];
  const state={sites:{},wt_tasks:{},wt_preferences:{targetLanguage:'zh-Hans',requestTimeoutMinutes:12},wt_manual_queue:[{id:'queued',siteId:'https://example.com',path:'/settings',targetLanguage:'ja',sourceText:'Complete original text'}],defaultPrompt:'fixture'};
  w.chrome={runtime:{id:'fixture',sendMessage:async m=>{calls.push(m);return {ok:true,result:m.type==='wt:state'?state:true};}},storage:{sync:{set:async()=>{}},onChanged:{addListener(){}}}};
  w.eval(read('managed-providers.js'));w.eval(read('managed-ui.js'));await new Promise(r=>setTimeout(r,20));
  assert.equal(d.querySelector('#autoExpandSeconds').value,'12');d.querySelector('#autoExpandSeconds').value='45';
  assert.equal(d.querySelector('#requestTimeoutMinutes').value,'12');d.querySelector('#requestTimeoutMinutes').value='20';d.querySelector('#pageCaptureItems').value='1200';d.querySelector('#inputContextK').value='50';d.querySelector('#generalForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await new Promise(r=>setTimeout(r,20));
  assert.equal(calls.find(m=>m.type==='wt:config').preferences.requestTimeoutMinutes,20);assert.equal(calls.find(m=>m.type==='wt:config').preferences.pageCaptureItems,1200);assert.equal(calls.find(m=>m.type==='wt:config').preferences.inputContextK,50);
  assert.equal(calls.find(m=>m.type==='wt:config').preferences.autoExpandSeconds,45);
  assert.match(d.querySelector('#manualQueue').textContent,/Complete original text/);assert.match(d.querySelector('#manualQueue').textContent,/ja/);
  d.querySelector('#manualQueue button').click();await new Promise(r=>setTimeout(r,20));assert.equal(calls.find(m=>m.type==='wt:manual-remove').id,'queued');
});

test('所有设置保存统一悬浮反馈，连续保存重置消失时间，旧定时器不隐藏新的错误提示',async t=>{
  const dom=new JSDOM(read('managed.html'),{url:'https://fixture.invalid/',runScripts:'outside-only'});t.after(()=>dom.window.close());const w=dom.window,d=w.document,timers=[];let fail=false;
  const state={sites:{},wt_tasks:{},wt_ai:{provider:'api',endpoint:'https://gateway.example.com/v1/chat/completions',model:'fixture',apiKey:'fixture-key'},wt_sync:{enabled:false,directory:''},defaultPrompt:'fixture'};
  w.chrome={runtime:{id:'fixture',sendMessage:async m=>m.type==='wt:state'?{ok:true,result:state}:fail?{ok:false,error:'保存失败，请重试'}:{ok:true,result:true}},permissions:{request:async()=>true},storage:{sync:{set:async()=>{}},onChanged:{addListener(){}}}};
  const originalTimer=w.setTimeout.bind(w);w.setTimeout=(fn,delay,...args)=>{if(delay===3000 || delay===8000){timers.push({fn,delay});return 100000+timers.length;}return originalTimer(fn,delay,...args);};
  w.eval(read('managed-providers.js'));w.eval(read('managed-ui.js'));await new Promise(r=>setTimeout(r,20));const message=d.querySelector('#message');assert.equal(message.hidden,true);
  for(const id of ['generalForm','aiForm','promptForm','repositoryForm']){
    d.querySelector('#'+id).dispatchEvent(new w.Event('submit',{cancelable:true}));await new Promise(r=>setTimeout(r,20));
    assert.equal(message.hidden,false,id);assert.equal(message.dataset.kind,'success');assert.equal(message.getAttribute('role'),'status');assert.equal(timers.at(-1).delay,3000);
  }
  timers[0].fn();assert.equal(message.hidden,false,'旧提示的计时器不能隐藏新提示');
  timers.at(-1).fn();assert.equal(message.hidden,true);assert.equal(message.textContent,'');
  fail=true;d.querySelector('#generalForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await new Promise(r=>setTimeout(r,20));
  assert.equal(message.textContent,'保存失败，请重试');assert.equal(message.getAttribute('role'),'alert');assert.equal(message.dataset.kind,'error');assert.equal(timers.at(-1).delay,8000);
  timers[1].fn();assert.equal(message.hidden,false);timers.at(-1).fn();assert.equal(message.hidden,true);
});

function dictionaryUI(t,handler){
  const dom=new JSDOM(read('managed.html'),{url:'https://fixture.invalid/#websites',runScripts:'outside-only'});t.after(()=>dom.window.close());
  const w=dom.window,site=(origin,group)=>({id:origin,origin,name:origin,group,enabled:true,entries:{},conflicts:{},excludedPaths:[],authorized:true});
  const repository={owner:'Ffive55',repo:'website-translator',branch:'main'},state={sites:{a:site('https://example.com','example.com'),b:site('https://other.test','other.test')},wt_tasks:{},wt_preferences:{targetLanguage:'zh-Hans'},dictionary:{ready:true,repository,hasToken:true,status:{},groups:{'example.com':{pending:2,conflicts:[],installed:true,downloadedOrigins:['https://example.com']},'other.test':{pending:0,conflicts:[],installed:true,downloadedOrigins:['https://other.test']}},check:{groups:[]}}},calls=[];
  w.chrome={runtime:{id:'fixture',sendMessage:async m=>{calls.push(m);return {ok:true,result:m.type==='wt:state'?state:await handler(m,state)};}},permissions:{request:async()=>true},storage:{onChanged:{addListener(){}}}};
  w.eval(read('managed-providers.js'));w.eval(read('managed-ui.js'));return {w,d:w.document,state,calls};
}
const tick=()=>new Promise(r=>setTimeout(r,20));

test('上传入口位于主域名行和顶部，无本地修改时隐藏；点击直接上传，刷新不放开重复上传',async t=>{
  let release;const {d,calls,state}=dictionaryUI(t,async(m,s)=>{
    if(m.action==='upload'){await new Promise(resolve=>release=resolve);s.dictionary.groups[m.group].pending=0;return '已上传 '+m.group;}
    if(m.action==='upload-all'){s.dictionary.groups['other.test'].pending=0;return {message:'批量中有失败，本地修改保留',error:true};}
    return true;
  });await tick();
  assert.equal(d.querySelector('#uploadGroups'),null);assert.equal(d.querySelector('#uploadPreview'),null);
  assert.equal(d.querySelector('#dictionaryBackup'),null);assert.equal(d.querySelector('#dictionaryImport'),null);
  assert.equal(d.querySelector('#dictionaryUploadAll').hidden,false);assert.equal(d.querySelectorAll('.group-actions [data-dictionary-upload]').length,1);
  assert.equal(d.querySelector('#dictionarySearchForm').compareDocumentPosition(d.querySelector('#siteList'))&2,2,'搜索放在已安装列表后面');
  d.querySelector('.group-actions [data-dictionary-upload]').click();await tick();
  assert.equal(d.querySelector('#dictionaryUploadAll').disabled,true);d.querySelector('#dictionaryCheck').click();await tick();
  assert.equal(d.querySelector('.group-actions [data-dictionary-upload]').disabled,true);d.querySelector('#dictionaryUploadAll').click();await tick();
  assert.deepEqual(calls.filter(m=>m.type==='wt:dictionary-action'&&m.action!=='check').map(m=>m.action),['upload']);release();await tick();
  assert.equal(d.querySelectorAll('.group-actions [data-dictionary-upload]').length,0);assert.equal(d.querySelector('#dictionaryUploadAll').hidden,true);
  state.dictionary.groups['other.test'].pending=1;d.querySelector('#dictionaryCheck').click();await tick();
  d.querySelector('#dictionaryUploadAll').click();await tick();assert.ok(calls.some(m=>m.action==='upload-all'));assert.equal(d.querySelector('#message').dataset.kind,'error');
});

test('空条件检索未下载词库，下载按钮添加并下载指定网址；已下载项和跨语言旧结果不展示',async t=>{
  const {w,d,calls}=dictionaryUI(t,async(m,s)=>{
    if(m.action==='catalog')return {repository:s.dictionary.repository,targetLanguage:s.wt_preferences.targetLanguage,rows:[{group:'example.com',origins:['https://example.com','https://app.example.com']}] };
    if(m.action==='download-group'){s.dictionary.groups['example.com'].downloadedOrigins.push('https://app.example.com');return '已下载 example.com 词库';}
    if(m.type==='wt:config')s.wt_preferences.targetLanguage='ja';
    return true;
  });await tick();
  const search=()=>d.querySelector('#dictionarySearchForm').dispatchEvent(new w.Event('submit',{cancelable:true}));search();await tick();
  assert.equal(calls.find(m=>m.action==='catalog').query,'');assert.equal(d.querySelectorAll('.dictionary-result').length,1);
  assert.match(d.querySelector('.dictionary-result').textContent,/example.com/);assert.ok(!d.querySelector('.dictionary-result').textContent.includes('app.example.com'));
  d.querySelector('.dictionary-result button').click();await tick();assert.equal(calls.find(m=>m.action==='download-group').group,'example.com');assert.equal(calls.some(m=>m.type==='wt:install'),false);assert.equal(d.querySelectorAll('.dictionary-result').length,0);
  d.querySelector('#dictionaryQuery').value='APP.EXAMPLE';search();await tick();assert.equal(calls.filter(m=>m.action==='catalog').at(-1).query,'APP.EXAMPLE');
  d.querySelector('#generalForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();assert.match(d.querySelector('#dictionarySearchStatus').textContent,/重新搜索/);
});

test('检查更新结果仅作为悬浮提示，重新刷新不把旧检查结果写到网站列表',async t=>{
  const {d}=dictionaryUI(t,async m=>m.action==='check'?{message:'已检查，0 个主域名有更新',error:false}:true);await tick();
  d.querySelector('#dictionaryCheck').click();await tick();assert.equal(d.querySelector('#message').textContent,'已检查，0 个主域名有更新');assert.equal(d.querySelector('#message').getAttribute('role'),'status');
  assert.equal(d.querySelector('#dictionaryStatus').hidden,true);assert.equal(d.querySelector('#dictionaryStatus').textContent,'');
});

function popupUI(t,handler){
  const html=fs.readFileSync(path.resolve(__dirname,'../edge/popup/popup.html'),'utf8'),dom=new JSDOM(html,{url:'https://fixture.invalid/',runScripts:'outside-only'});t.after(()=>dom.window.close());
  const w=dom.window,d=w.document,origin='https://example.com',group='example.com',calls=[],intervals=[];
  const state={sites:{[origin]:{id:origin,origin,group,enabled:true,entries:{},conflicts:{},excludedPaths:[]}},wt_preferences:{targetLanguage:'zh-Hans'},wt_tasks:{},globalEnabled:true,dictionary:{ready:true,repository:{owner:'fixture',repo:'fixture',branch:'main'},hasToken:true,groups:{[group]:{pending:0,pendingOrigins:{},contentRevision:'first'}},status:{}}};
  const tab={url:origin+'/settings',id:1};w.setInterval=fn=>{intervals.push(fn);return intervals.length;};
  w.chrome={runtime:{id:'fixture',getURL:p=>'chrome-extension://fixture/'+p,sendMessage:async m=>{calls.push(m);return {ok:true,result:['wt:state','wt:popup-state'].includes(m.type)?state:await handler(m,state,origin)};}},tabs:{query:async()=>[tab],create:async()=>{}},permissions:{request:async()=>true},storage:{sync:{set:async()=>{throw Error('网站开关不得改总开关');}},onChanged:{addListener(){}}}};
  w.eval(read('managed-ui.js'));return {w,d,state,calls,tab,poll:()=>intervals[0]()};
}

test('弹窗检测远端未下载词库，点击下载不调用 AI；本地进度轮询复用检测结果',async t=>{
  let installed=false;const {d,calls,poll}=popupUI(t,async(m,s,origin)=>{
    if(m.action==='page-status')return {origin,group:'example.com',available:true,installed,hasUpdate:false};
    if(m.action==='download-group'){installed=true;s.dictionary.groups['example.com'].contentRevision='downloaded';return '已更新 example.com';}
    return true;
  });await tick();assert.equal(d.querySelector('#wtDictionaryDownload').hidden,false);assert.equal(d.querySelector('#wtDictionaryUpdate').hidden,true);
  poll();await tick();poll();await tick();assert.equal(calls.filter(m=>m.action==='page-status').length,1);
  d.querySelector('#wtDictionaryDownload').click();await tick();assert.equal(calls.some(m=>m.type==='wt:install'),false);assert.ok(calls.some(m=>m.action==='download-group'&&m.group==='example.com'));assert.equal(d.querySelector('#wtDictionaryDownload').hidden,true);
  assert.equal(calls.some(m=>m.type==='wt:start'||m.type==='wt:capture-start'),false);
});

test('弹窗同时显示远端更新和本地待上传，直接上传，并单独启停当前网址',async t=>{
  const {d,state,calls,poll}=popupUI(t,async(m,s,origin)=>{
    if(m.action==='page-status')return {origin,group:'example.com',available:true,installed:true,hasUpdate:true};
    if(m.action==='upload'){s.dictionary.groups['example.com'].pendingOrigins={};return '已上传 example.com';}
    if(m.type==='wt:change')s.sites[origin].enabled=m.payload.value;
    return true;
  });state.dictionary.groups['example.com'].pendingOrigins={'https://example.com':2};state.globalEnabled=false;await tick();poll();await tick();
  assert.equal(d.querySelector('#wtDictionaryUpdate').hidden,false);assert.equal(d.querySelector('#wtDictionaryUpload').hidden,false);assert.match(d.querySelector('#wtDictionaryStatus').textContent,/2 项待上传/);
  d.querySelector('#wtDictionaryUpload').click();await tick();assert.ok(calls.some(m=>m.action==='upload'));assert.equal(calls.some(m=>m.action==='preview'),false);assert.equal(d.querySelector('#wtDictionaryUpload').hidden,true);
  d.querySelector('#wtSiteToggle').click();await tick();assert.equal(state.sites['https://example.com'].enabled,false);assert.equal(d.querySelector('#wtSiteToggle').textContent,'启用当前网页');assert.equal(state.globalEnabled,false);
  d.querySelector('#wtSiteToggle').click();await tick();assert.equal(state.sites['https://example.com'].enabled,true);assert.equal(d.querySelector('#wtSiteToggle').textContent,'停用当前网页');assert.equal(state.globalEnabled,false);
  assert.ok(calls.filter(m=>m.type==='wt:change').every(m=>m.siteId==='https://example.com'&&m.kind==='setting'&&m.payload.key==='enabled'));
});

test('弹窗切换网页忽略迟到检测，内部页面不检测；离线仍显示本机待上传',async t=>{
  let release;const {d,state,tab,poll,calls}=popupUI(t,async(m,s,origin)=>{
    if(m.action==='page-status'&&m.origin===origin)return new Promise(resolve=>release=()=>resolve({origin,group:'example.com',available:true,installed:false,hasUpdate:false}));
    if(m.action==='page-status')throw Error('GitHub 暂不可用');return true;
  });await tick();tab.url='https://other.test/';state.sites['https://other.test']={id:'https://other.test',origin:'https://other.test',group:'other.test',enabled:true};state.dictionary.groups['other.test']={pendingOrigins:{'https://other.test':1},contentRevision:'other'};poll();await tick();release();await tick();
  assert.equal(d.querySelector('#wtDictionaryDownload').hidden,true);assert.equal(d.querySelector('#wtDictionaryUpload').hidden,false);assert.match(d.querySelector('#wtDictionaryStatus').title,/GitHub 暂不可用/);
  const before=calls.filter(m=>m.action==='page-status').length;tab.url='edge://extensions/';poll();await tick();assert.equal(calls.filter(m=>m.action==='page-status').length,before);assert.equal(d.querySelector('#wtSiteToggle').hidden,true);assert.equal(d.querySelector('#wtDictionaryUpload').hidden,true);
});
