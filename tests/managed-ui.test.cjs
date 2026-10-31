'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');
const read=name=>fs.readFileSync(path.resolve(__dirname,'../extension',name),'utf8');
test('后台迁移请求未返回时，弹窗设置入口立即可点击且显示启动提示',async t=>{
 const html=fs.readFileSync(path.resolve(__dirname,'../edge/popup/popup.html'),'utf8');const dom=new JSDOM(html,{url:'https://fixture.invalid/',runScripts:'outside-only'});t.after(()=>dom.window.close());let opened;
 dom.window.chrome={runtime:{id:'fixture',getURL:p=>'chrome-extension://fixture/'+p,sendMessage:()=>new Promise(()=>{})},tabs:{create:async options=>{opened=options.url;}},storage:{sync:{set:async()=>{}},onChanged:{addListener(){}}}};
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
  d.querySelector('#tab-sync').click();assert.ok(d.querySelector('#repositoryForm'));assert.equal(d.querySelector('#syncHelper'),null);assert.equal(d.querySelector('#tab-sync').textContent,'词库上传');
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
