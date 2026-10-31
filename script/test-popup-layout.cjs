'use strict';
// Real Edge layout, isolated synthetic UI state; no personal profile or network.
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict'),{chromium}=require('playwright');
const ROOT=path.resolve(__dirname,'..');
async function nativePopups(output,checks){
  const extension=path.join(output,'native-extension');await fs.cp(path.join(ROOT,'edge'),extension,{recursive:true,filter:p=>!p.includes(path.sep+'local-helper')});
  for(const scenario of ['completed','collecting','error']){
  const context=await chromium.launchPersistentContext(path.join(output,'native-profile-'+scenario+'-'+Date.now()),{channel:'msedge',headless:true,args:['--disable-extensions-except='+extension,'--load-extension='+extension]});
  try{
    let worker=context.serviceWorkers()[0];if(!worker)worker=await context.waitForEvent('serviceworker',{timeout:15000});
    const cdp=await context.browser().newBrowserCDPSession();let sequence=0;const pending=new Map();
    cdp.on('Target.receivedMessageFromTarget',event=>{const message=JSON.parse(event.message),key=event.sessionId+':'+message.id,callback=pending.get(key);if(callback){pending.delete(key);message.error?callback.reject(Error(message.error.message)):callback.resolve(message.result);}});
    function command(sessionId,method,params={}){const id=++sequence,key=sessionId+':'+id;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(key);reject(Error('native popup CDP timeout '+method));},15000);pending.set(key,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});cdp.send('Target.sendMessageToTarget',{sessionId,message:JSON.stringify({id,method,params})}).catch(error=>{clearTimeout(timer);pending.delete(key);reject(error);});});}
    let nativeTarget,nativeSession;
      await worker.evaluate(async scenario=>{
        const origin='https://openrouter.ai',group='openrouter.ai',long='详细任务记录和错误说明 '.repeat(100);
        const state={sites:{[origin]:{id:origin,origin,group,enabled:true}},wt_preferences:{targetLanguage:'zh-Hans'},globalEnabled:true,manualPending:scenario==='completed'?0:5,wt_tasks:{job:{id:'job',siteId:origin,status:scenario==='error'?'failed':'completed',targetLanguage:'zh-Hans',total:61,completed:61,translated:55,reused:24,message:long,updatedAt:Date.now()}},dictionary:{ready:true,repository:{owner:'fixture',repo:'fixture',branch:'main'},hasToken:true,status:scenario==='error'?{syncError:long}:{},groups:{[group]:{pendingOrigins:{[origin]:61},contentRevision:'fixture'}}}};
        if(scenario==='collecting')state.wt_capture={status:'collecting',group,pageCount:12,itemCount:3000,truncated:true,lastError:long};
        await chrome.storage.local.set({__popupLayoutState:state});
      },scenario);
      if(!nativeTarget){await worker.evaluate(()=>chrome.action.openPopup());nativeTarget=(await cdp.send('Target.getTargets')).targetInfos.find(target=>target.url.endsWith('/popup/popup.html'));assert.ok(nativeTarget,'真实工具栏弹窗应创建浏览器目标');nativeSession=(await cdp.send('Target.attachToTarget',{targetId:nativeTarget.targetId,flatten:false})).sessionId;}
      const sessionId=nativeSession;
      const setup=await command(sessionId,'Runtime.evaluate',{expression:"(async()=>{for(let i=0;i<200&&document.readyState!=='complete';i++)await new Promise(r=>setTimeout(r,25));const get=chrome.storage.local.get.bind(chrome.storage.local);chrome.tabs.query=async()=>[{id:1,url:'https://openrouter.ai/rankings'}];chrome.runtime.sendMessage=async message=>{const {__popupLayoutState:state}=await get('__popupLayoutState');return {ok:true,result:message.type==='wt:popup-state'?state:{origin:'https://openrouter.ai',group:'openrouter.ai',origins:['https://openrouter.ai'],available:true,installed:true,hasUpdate:true}};};const {__popupLayoutState:state}=await get('__popupLayoutState');await chrome.storage.local.set({wt_tasks:state.wt_tasks});})()",awaitPromise:true,returnByValue:true});assert.ok(!setup.exceptionDetails,JSON.stringify(setup));
      const response=await command(sessionId,'Runtime.evaluate',{expression:"(async()=>{for(let i=0;i<200;i++){if(document.querySelector('#wtDictionaryUpdate')&&!document.querySelector('#wtDictionaryUpdate').hidden)break;await new Promise(r=>setTimeout(r,25));}await new Promise(r=>setTimeout(r,400));const settings=document.querySelector('#wtManage').getBoundingClientRect();return {width:innerWidth,height:innerHeight,body:document.body.clientHeight,bodyScroll:document.body.scrollHeight,bottomSpace:innerHeight-settings.bottom,font:getComputedStyle(document.querySelector('#wtStart')).fontSize,buttons:[...document.querySelectorAll('button')].filter(button=>button.getBoundingClientRect().height).map(button=>({id:button.id,bottom:button.getBoundingClientRect().bottom}))};})()",awaitPromise:true,returnByValue:true});assert.ok(!response.exceptionDetails,JSON.stringify(response));const layout=response.result.value;
      assert.equal(layout.width,360,'保留现有宽度');assert.ok(layout.height>=200&&layout.height<=600,JSON.stringify(layout));assert.ok(layout.bodyScroll<=layout.body,JSON.stringify(layout));assert.ok(layout.buttons.every(button=>button.bottom<=layout.height),JSON.stringify(layout));assert.ok(layout.bottomSpace>=18,JSON.stringify(layout));assert.ok(parseFloat(layout.font)>=16);
      const screenshot=await command(sessionId,'Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(output,'native-'+scenario+'.png'),Buffer.from(screenshot.data,'base64'));checks.push({native:true,scenario,...layout});console.log('PASS 真实工具栏弹窗 '+scenario+' '+layout.width+'x'+layout.height+' 字号 '+layout.font+' 底部留白 '+layout.bottomSpace);
  }finally{await context.close();}
  }
}
async function main(){
  const output=path.join(ROOT,'.cache/popup-layout');await fs.mkdir(output,{recursive:true});
  const html=(await fs.readFile(path.join(ROOT,'edge/popup/popup.html'),'utf8')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').replace(/<link\b[^>]*>/g,'');
  const css=await fs.readFile(path.join(ROOT,'edge/popup/popup.css'),'utf8'),ui=await fs.readFile(path.join(ROOT,'edge/managed/ui.js'),'utf8');
  const browser=await chromium.launch({channel:'msedge',headless:true}),checks=[];
  try{
    for(const height of [600,540,480])for(const scenario of ['completed','collecting','error','starting']){
      const page=await browser.newPage({viewport:{width:360,height}});
      try{
        await page.setContent(html);await page.addStyleTag({content:css});
        await page.evaluate(({scenario})=>{
          const origin='https://openrouter.ai',group='openrouter.ai',long='长任务详细记录与错误原因 '.repeat(100);
          const state={sites:{[origin]:{id:origin,origin,group,enabled:true}},wt_preferences:{targetLanguage:'zh-Hans'},globalEnabled:true,manualPending:scenario==='completed'?0:5,
            wt_tasks:{task:{id:'task',siteId:origin,targetLanguage:'zh-Hans',status:scenario==='error'?'failed':'completed',completed:61,total:61,translated:55,reused:24,deduplicated:0,batchTotal:1,batchCompleted:1,retries:0,contextBudget:240000,requestTimeoutMinutes:10,message:long,updatedAt:1}},
            dictionary:{ready:scenario!=='starting',starting:scenario==='starting',repository:{owner:'fixture',repo:'fixture',branch:'main'},hasToken:true,status:scenario==='error'?{error:long}:{},groups:{[group]:{pendingOrigins:{[origin]:61},contentRevision:'fixture'}}}};
          if(scenario==='collecting')state.wt_capture={status:'collecting',group,pageCount:12,itemCount:3000,lastError:long,truncated:true};
          window.__calls=[];window.__state=state;
          window.chrome={runtime:{id:'fixture',getURL:p=>'chrome-extension://fixture/'+p,sendMessage:async message=>{__calls.push(message);return {ok:true,result:message.type==='wt:popup-state'?state:{origin,group,available:true,installed:true,hasUpdate:true}};}},tabs:{query:async()=>[{id:1,url:origin+'/rankings'}],create:async()=>{}},permissions:{request:async()=>true},storage:{sync:{set:async()=>{}},onChanged:{addListener:fn=>window.__changed=fn}}};
        },{scenario});
        await page.addScriptTag({content:ui});await page.waitForFunction(()=>document.querySelector('#status').textContent==='已开启');
        if(scenario!=='starting')await page.locator('#wtDictionaryUpdate').waitFor({state:'visible'});
        await page.waitForFunction(()=>document.body.scrollHeight<=innerHeight&&[...document.querySelectorAll('button')].filter(button=>button.getBoundingClientRect().height).every(button=>button.getBoundingClientRect().bottom<=innerHeight));
        const layout=await page.evaluate(()=>{
          const root=document.documentElement,panel=document.querySelector('main');
          const buttons=[...document.querySelectorAll('button')].filter(el=>el.getBoundingClientRect().height>0).map(el=>{const r=el.getBoundingClientRect();return {id:el.id,top:r.top,bottom:r.bottom,left:r.left,right:r.right};});
          return {viewport:innerHeight,height:root.clientHeight,scrollHeight:root.scrollHeight,rootOverflow:getComputedStyle(root).overflow,bodyHeight:document.body.clientHeight,bodyScroll:document.body.scrollHeight,panelScroll:panel.scrollHeight,panelHeight:panel.clientHeight,buttons,progress:document.querySelector('#wtProgress').textContent,fullTitle:document.querySelector('#wtProgress').title,calls:__calls.map(call=>call.type)};
        });
        assert.equal(layout.rootOverflow,'hidden');assert.ok(layout.bodyScroll<=layout.bodyHeight,JSON.stringify({height,scenario,layout}));assert.ok(layout.panelScroll<=layout.panelHeight,JSON.stringify({height,scenario,layout}));
        assert.ok(layout.buttons.every(b=>b.top>=0&&b.bottom<=layout.viewport&&b.left>=0&&b.right<=360),JSON.stringify({height,scenario,buttons:layout.buttons}));
        assert.ok(layout.buttons.some(b=>b.id==='wtManage'));assert.ok(layout.calls.includes('wt:popup-state'));assert.ok(!layout.calls.includes('wt:state'));
        assert.ok(layout.progress.length<120);assert.ok(layout.fullTitle.length>layout.progress.length);
        if(height===600)await page.screenshot({path:path.join(output,scenario+'.png')});
        checks.push({height,scenario,contentHeight:layout.scrollHeight,settingsBottom:layout.buttons.find(b=>b.id==='wtManage').bottom});console.log('PASS '+height+'px '+scenario+' 无滚动且全部按钮可见');
      }finally{await page.close();}
    }
    await nativePopups(output,checks);
    await fs.writeFile(path.join(output,'result.json'),JSON.stringify({passed:true,count:checks.length,checks},null,2));
  }finally{await browser.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
