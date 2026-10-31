'use strict';
// Isolated Microsoft Edge runtime with a local mock API; no personal browser/account.
const fs=require('node:fs/promises'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'..');
process.env.PLAYWRIGHT_BROWSERS_PATH=path.join(ROOT,'.cache/playwright');
const {chromium}=require('playwright');
async function main(){
  const output=path.join(ROOT,'.cache/browser-smoke');await fs.mkdir(output,{recursive:true});
  let requests=0,activeApi=0,peakApi=0;const apiBatches=[];
  const server=http.createServer(async(req,res)=>{
    if(req.url==='/v1/chat/completions'){
      let data='';for await(const chunk of req)data+=chunk;requests++;
      const {messages}=JSON.parse(data),payload=JSON.parse(messages[1].content);
      apiBatches.push(payload);
      activeApi++;peakApi=Math.max(peakApi,activeApi);
      if(payload.inputs.some(i=>i.sourceText.startsWith('Long option')))await new Promise(r=>setTimeout(r,100));
      const rows=payload.inputs.map(i=>({id:i.id,category:'ui',action:'translate',translation:payload.targetLanguage==='ja'?'保存する':'保存更改',reason:''}));
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(rows)}}]}));activeApi--;
    }else{res.setHeader('Content-Type','text/html');res.end('<!doctype html><html lang="en"><body><main><button>Save changes</button><pre>private-code</pre><input value="private-input"></main></body></html>');}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
  // Only the isolated fixture grants localhost ahead of time. Production keeps optional permission prompts.
  const fixture=path.join(output,'extension');await fs.cp(path.join(ROOT,'edge'),fixture,{recursive:true,filter:p=>!p.includes(path.sep+'local-helper')});
  const manifest=JSON.parse(await fs.readFile(path.join(fixture,'manifest.json'),'utf8'));manifest.host_permissions.push('http://127.0.0.1/*');await fs.writeFile(path.join(fixture,'manifest.json'),JSON.stringify(manifest));
  // Fixture-only hook invokes the registered browser menu handler after a real page contextmenu event.
  const workerFile=path.join(fixture,'managed/worker.js');
  const dictionaryMock=require('./dictionary-browser-fixture.cjs');
  await fs.writeFile(workerFile,dictionaryMock.readOnlyMock(await dictionaryMock.readFiles(ROOT))+"globalThis.__selectionHandlers=[]; const originalMenuListener=chrome.contextMenus.onClicked.addListener.bind(chrome.contextMenus.onClicked); chrome.contextMenus.onClicked.addListener=fn=>{__selectionHandlers.push(fn);originalMenuListener(fn);};\n"+await fs.readFile(workerFile,'utf8'));
  let context;
  try{
    context=await chromium.launchPersistentContext(path.join(output,`profile-${Date.now()}`),{channel:'msedge',headless:true,args:[`--disable-extensions-except=${fixture}`,`--load-extension=${fixture}`],viewport:{width:1280,height:900}});
    context.setDefaultTimeout(15000);
    console.log('[browser] launched');
    let [worker]=context.serviceWorkers();if(!worker)worker=await context.waitForEvent('serviceworker',{timeout:15000});
    const id=worker.url().split('/')[2],errors=[];
    console.log('[browser] worker ready');
    const ui=await context.newPage();ui.on('pageerror',e=>errors.push(e.message));
    await ui.goto(`chrome-extension://${id}/managed/managed.html`);
    console.log('[browser] management page loaded');
    console.log('[browser] initial state', await ui.locator('#message').textContent());
    await ui.evaluate(async()=>{await chrome.runtime.sendMessage({type:'wt:state'});for(const origin of ['https://tailscale.com','https://www.tailscale.com','https://login.tailscale.com','https://console.tailscale.com','https://github.com','https://www.githubstatus.com'])await chrome.runtime.sendMessage({type:'wt:install',origin});for(const group of ['tailscale.com','github.com','githubstatus.com']){const result=await chrome.runtime.sendMessage({type:'wt:dictionary-action',action:'update',group});if(!result.ok)throw Error(result.error);}});
    await ui.reload();
    try { await ui.waitForFunction(()=>document.querySelectorAll('.site').length>0); }
    catch(e) {
      console.log('[browser] errors',errors);
      console.log('[browser] message',await ui.locator('#message').textContent());
      console.log('[browser] background',await worker.evaluate(async()=>({core:typeof WTCore,catalog:typeof SUPPORTED_SITES,tldts:typeof tldts,keys:Object.keys(await chrome.storage.local.get(null)),registrations:await chrome.scripting.getRegisteredContentScripts()})));
      throw e;
    }
    console.log('[browser] sites rendered');
    await ui.getByRole('tab',{name:'AI 翻译',exact:true}).click();
    await ui.locator('#endpoint').fill(origin+'/v1/chat/completions');await ui.locator('#apiKey').fill('fixture-key');await ui.locator('#model').fill('fixture-model');await ui.getByRole('button',{name:'保存 AI 设置',exact:true}).click();
    await ui.waitForFunction(()=>document.querySelector('#message').textContent==='已保存');
    const toast=ui.locator('#message'),toastBox=await toast.boundingBox();assert.ok(toastBox && toastBox.y<80);assert.ok(Math.abs(toastBox.x+toastBox.width/2-640)<2,'保存提示应在视口上方居中');assert.equal(await toast.evaluate(el=>getComputedStyle(el).position),'fixed');
    await ui.screenshot({path:path.join(output,'save-toast.png')});await toast.waitFor({state:'hidden',timeout:5000});
    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(origin+'/settings');
    const tabId=await worker.evaluate(async origin=>(await chrome.tabs.query({})).find(t=>t.url?.startsWith(origin)).id,origin);
    const rpc=(type,data)=>ui.evaluate(async({type,data})=>chrome.runtime.sendMessage({type:'wt:'+type,...data}),{type,data});
    const waitState=async predicate=>{for(let i=0;i<300;i++){const r=await rpc('state');if(r.ok && predicate(r.result))return r.result;await new Promise(resolve=>setTimeout(resolve,50));}throw new Error('等待后台状态超时');};
    assert.equal((await rpc('start',{tabId})).ok,true);
    await page.waitForFunction(()=>document.querySelector('button').textContent==='保存更改').catch(async error=>{const response=await rpc('state'),state=response.result||{};console.log('[translation diagnostic]',JSON.stringify({requests,error:response.error,tasks:state.wt_tasks,site:state.sites?.[origin],errors}));throw error;});
    assert.equal(requests,1);assert.equal(await page.locator('pre').textContent(),'private-code');assert.equal(await page.locator('input').inputValue(),'private-input');
    await page.reload();await page.waitForFunction(()=>document.querySelector('button').textContent==='保存更改');assert.equal(requests,1);
    await rpc('config',{preferences:{targetLanguage:'ja'}});
    await page.waitForFunction(()=>document.querySelector('button').textContent==='Save changes');assert.equal(requests,1);
    await rpc('start',{tabId});await page.waitForFunction(()=>document.querySelector('button').textContent==='保存する');assert.equal(requests,2);
    await rpc('config',{preferences:{targetLanguage:'zh-Hans'}});
    await page.waitForFunction(()=>document.querySelector('button').textContent==='保存更改');assert.equal(requests,2);
    await rpc('change',{siteId:origin,kind:'setting',payload:{key:'enabled',value:false}});
    await page.waitForFunction(()=>document.querySelector('button').textContent==='Save changes');assert.equal(await page.locator('html').getAttribute('lang'),'en');
    await ui.reload();await ui.waitForFunction(()=>document.querySelectorAll('.site').length>0);
    await ui.screenshot({path:path.join(output,'management.png'),fullPage:true});
    await rpc('change',{siteId:origin,kind:'delete',payload:{}});
    await page.reload();assert.equal(await page.locator('button').textContent(),'Save changes');
    const initialNotice='Unlisted initial notice for independent review';
    await context.route('https://tailscale.com/**',route=>route.fulfill({contentType:'text/html',body:new URL(route.request().url()).searchParams.has('dynamic-fixture')
      ? `<!doctype html><html lang="en"><body><nav><button>Pricing</button></nav><main><p id="notice">${initialNotice}</p></main><script>document.querySelector('#notice').firstChild.data = sessionStorage.getItem('fixtureNotice') || ${JSON.stringify(initialNotice)};</script></body></html>`
      : '<!doctype html><html lang="en"><body><nav><button>Pricing</button></nav></body></html>'}));
    const builtin=await context.newPage();await builtin.goto('https://tailscale.com/');await builtin.waitForFunction(()=>document.querySelector('button').textContent==='价格');
    const builtinTab=await worker.evaluate(async()=>(await chrome.tabs.query({})).find(t=>t.url==='https://tailscale.com/').id);
    await rpc('start',{tabId:builtinTab});
    await waitState(state=>Object.values(state.wt_tasks).some(t=>t.siteId==='https://tailscale.com' && t.status==='completed'));
    assert.equal(requests,2,'内置人工词库已覆盖的内容不应再请求 AI');
    await rpc('config',{preferences:{targetLanguage:'ja'}});
    await builtin.waitForFunction(()=>document.querySelector('button').textContent==='Pricing');
    assert.equal(await builtin.locator('meta[data-fixed-site-translation]').count(),0);
    await rpc('config',{preferences:{targetLanguage:'zh-Hans'}});
    await builtin.waitForFunction(()=>document.querySelector('button').textContent==='价格');
    await builtin.goto('https://tailscale.com/?dynamic-fixture=1');
    await builtin.waitForFunction(()=>document.querySelector('button').textContent==='价格');
    const collectBuiltin=()=>worker.evaluate(tabId=>chrome.tabs.sendMessage(tabId,{type:'wt:collect'}),builtinTab);
    assert.deepEqual((await collectBuiltin()).items.map(i=>i.sourceText),[initialNotice]);
    const setNotice=async values=>{
      await builtin.evaluate(values=>{for(const value of values)document.querySelector('#notice').firstChild.data=value;sessionStorage.setItem('fixtureNotice',values.at(-1));},values);
      await builtin.waitForTimeout(300);
    };
    const changedNotice='New untranslated notice after the site updates';
    await setNotice([changedNotice]);
    assert.deepEqual((await collectBuiltin()).items.map(i=>i.sourceText),[changedNotice]);
    const latestNotice='Latest untranslated notice after consecutive updates';
    await setNotice(['Intermediate notice',latestNotice]);
    assert.deepEqual((await collectBuiltin()).items.map(i=>i.sourceText),[latestNotice]);
    assert.equal(requests,2,'网页自身更新及采集不应自动调用 AI');
    const updateBuiltin=async()=>{
      const started=await rpc('start',{tabId:builtinTab});assert.equal(started.ok,true);
      await waitState(state=>state.wt_tasks[started.result.id]?.status==='completed');
    };
    await updateBuiltin();await builtin.waitForFunction(()=>document.querySelector('#notice').textContent==='保存更改');
    assert.equal(requests,3);assert.deepEqual(apiBatches.at(-1).inputs.map(i=>i.sourceText),[latestNotice]);
    await updateBuiltin();assert.equal(requests,3,'已保存的动态原文应复用，内置 Pricing 不应被重复发送');
    const finalNotice='Final source after another website update';
    await setNotice([finalNotice]);assert.deepEqual((await collectBuiltin()).items.map(i=>i.sourceText),[finalNotice]);
    await updateBuiltin();await builtin.waitForFunction(()=>document.querySelector('#notice').textContent==='保存更改');
    assert.equal(requests,4);assert.deepEqual(apiBatches.at(-1).inputs.map(i=>i.sourceText),[finalNotice]);
    await rpc('change',{siteId:'https://tailscale.com',kind:'setting',payload:{key:'enabled',value:false}});
    await builtin.waitForFunction(source=>document.querySelector('#notice')?.textContent===source && document.querySelector('button')?.textContent==='Pricing',finalNotice);
    assert.equal(await builtin.locator('meta[data-fixed-site-translation],meta[data-website-translator]').count(),0);
    const japanese={sourceText:finalNotice,sourceLanguage:null,targetLanguage:'ja',translation:'最新のお知らせ',path:'/',context:'main/p/text',category:'ui',action:'translate',origin:'manual'};
    await rpc('change',{siteId:'https://tailscale.com',kind:'entry',payload:japanese});
    await rpc('config',{preferences:{targetLanguage:'ja'}});
    await rpc('change',{siteId:'https://tailscale.com',kind:'setting',payload:{key:'enabled',value:true}});
    await builtin.waitForFunction(()=>document.querySelector('#notice')?.textContent==='最新のお知らせ' && document.querySelector('button')?.textContent==='Pricing');
    await rpc('config',{preferences:{targetLanguage:'zh-Hans'}});
    await builtin.waitForFunction(()=>document.querySelector('#notice')?.textContent==='保存更改' && document.querySelector('button')?.textContent==='价格');
    assert.deepEqual((await collectBuiltin()).items.map(i=>i.sourceText),[]);assert.equal(requests,4);
    await rpc('config',{ai:{provider:'api',endpoint:origin+'/v1/chat/completions',model:'fixture-model',apiKey:'fixture-key',prompt:'使用简洁自然的界面译文'}});
    await page.goto(origin+'/capture-document');
    await worker.evaluate(tabId=>chrome.scripting.executeScript({target:{tabId},files:['managed/core.js','managed/text-provenance.js','managed/content.js']}),tabId);
    await page.evaluate(()=>history.pushState({},'','/capture'));
    assert.equal((await rpc('capture-start',{tabId})).ok,true);
    assert.ok((await rpc('state')).result.wt_capture.pages.includes(origin+'/capture'),'切换过 SPA 路由后开始采集，应立即持久化当前页');
    await waitState(state=>state.wt_capture?.items.length>0);
    const beforeCapture=requests;
    await page.evaluate(()=>{const dialog=document.createElement('dialog');dialog.open=true;dialog.innerHTML='<form><label>Email address</label><input placeholder="First name" value="private-name"><input type="email" placeholder="Enter your email address" value="private@example.com"><input type="password" placeholder="Create a password" value="private-password"></form>';document.body.append(dialog);});
    await waitState(state=>state.wt_capture.items.some(i=>i.sourceText==='Create a password'));
    await page.evaluate(()=>{history.pushState({},'','/capture-spa');const p=document.createElement('p');p.textContent='Routing options';document.querySelector('main').append(p);});
    await waitState(state=>state.wt_capture.pages.includes(origin+'/capture-spa') && state.wt_capture.items.some(i=>i.sourceText==='Routing options' && i.path==='/capture-spa'));
    await page.evaluate(()=>{history.replaceState({},'','/capture-replace');document.querySelector('main p').textContent='Updated routing options';});
    await waitState(state=>state.wt_capture.pages.includes(origin+'/capture-replace'));
    await page.goto(origin+'/capture-next');
    await waitState(state=>state.wt_capture.pages.length===4);
    // A real window.open descendant should join the same-domain session.
    await page.bringToFront();const childPromise=context.waitForEvent('page');await page.evaluate(()=>window.open('/capture-child','_blank'));const child=await childPromise;await child.waitForLoadState();
    await waitState(state=>state.wt_capture.pages.length===5);
    await child.close();
    assert.equal(requests,beforeCapture,'整个采集阶段不得请求 AI');
    assert.equal((await rpc('capture-finish')).ok,true);
    await page.waitForFunction(()=>document.querySelector('button').textContent==='保存更改');
    assert.equal(requests,beforeCapture+1,'一次完成跨页面采集的小批次');
    const collected=apiBatches.at(-1).inputs;
    assert.ok(collected.some(i=>i.path==='/capture-spa' && i.sourceText==='Routing options'));
    assert.ok(collected.some(i=>i.path==='/capture-replace' && i.sourceText==='Updated routing options'));
    assert.ok(collected.some(i=>i.sourceText==='Create a password' && i.context.endsWith('@placeholder')));
    assert.ok(!JSON.stringify(collected).includes('private-password'));assert.ok(!JSON.stringify(collected).includes('private@example.com'));
    assert.equal(collected.filter(i=>i.sourceText==='Save changes').length,1,'同上下文按钮跨五个页面只提交一次');
    await page.goto(origin+'/capture');await page.evaluate(()=>{const input=document.createElement('input');input.placeholder='First name';input.value='private-name';const form=document.createElement('form');form.append(input);const dialog=document.createElement('dialog');dialog.open=true;dialog.append(form);document.body.append(dialog);});
    await page.waitForFunction(()=>document.querySelector('[placeholder]')?.placeholder==='保存更改');assert.equal(await page.locator('[placeholder]').inputValue(),'private-name');assert.equal(requests,beforeCapture+1);
    await rpc('config',{preferences:{targetLanguage:'ja'}});await page.waitForFunction(()=>document.querySelector('[placeholder]')?.placeholder==='First name');
    await rpc('config',{preferences:{targetLanguage:'zh-Hans'}});await page.waitForFunction(()=>document.querySelector('[placeholder]')?.placeholder==='保存更改');
    await rpc('group-change',{group:new URL(origin).hostname,action:'enabled',enabled:false});await page.waitForFunction(()=>document.querySelector('[placeholder]')?.placeholder==='First name');
    await rpc('group-change',{group:new URL(origin).hostname,action:'enabled',enabled:true});await page.waitForFunction(()=>document.querySelector('[placeholder]')?.placeholder==='保存更改');
    // Lazy controls create their content only after the extension's explicit exploration.
    await context.route(origin+'/interactive',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><html lang="en"><body><main>
      <form><select name="sort"><option>Recommended ranking</option><option value="cost">Lowest cost</option></select><button aria-haspopup="menu">Never submit</button></form>
      <button type="button" id="menu-trigger" aria-haspopup="listbox" aria-expanded="false">Ranking choices</button>
      <button type="button" id="tip-trigger" tabindex="-1" data-base-ui-tooltip-trigger aria-label="About task estimates"><svg aria-hidden="true" width="16" height="16"><circle cx="8" cy="8" r="6"/></svg></button>
      <button type="button" id="danger">Delete project</button><a href="/unwanted" aria-haspopup="menu">Never follow</a>
      </main><script>
      window.actions=0;window.openCounts={menu:0,tip:0};document.querySelector('form').onsubmit=e=>{e.preventDefault();window.actions++};document.querySelector('#danger').onclick=()=>window.actions++;
      const trigger=document.querySelector('#menu-trigger');trigger.onpointerdown=()=>{const old=document.querySelector('#lazy-menu');if(old)return;window.openCounts.menu++;const menu=document.createElement('div');menu.id='lazy-menu';menu.setAttribute('role','listbox');menu.innerHTML='<div role="option">Highest throughput</div>';menu.onclick=()=>window.actions++;document.body.append(menu);trigger.setAttribute('aria-expanded','true');};
      document.addEventListener('keydown',e=>{if(e.key==='Escape'){document.querySelector('#lazy-menu')?.remove();trigger.setAttribute('aria-expanded','false');}});const tip=document.querySelector('#tip-trigger');let timer;tip.onpointermove=()=>{window.openCounts.tip++;clearTimeout(timer);timer=setTimeout(()=>{if(document.querySelector('#lazy-tip'))return;const wrapper=document.createElement('div');wrapper.id='lazy-tip';wrapper.setAttribute('data-base-ui-portal','');wrapper.innerHTML='<div data-base-ui-focusable data-side="top">Tasks are inferred from a representative sample</div>';document.body.append(wrapper);},600);};tip.onpointerleave=()=>{clearTimeout(timer);document.querySelector('#lazy-tip')?.remove();};
      </script></body></html>`}));
    await page.goto(origin+'/interactive');
    const beforeInteractive=requests,interactiveTask=await rpc('start',{tabId});assert.equal(interactiveTask.ok,true);
    await waitState(state=>state.wt_tasks[interactiveTask.result.id]?.status==='completed');
    const interactiveInputs=apiBatches.at(-1).inputs;
    for(const text of ['Highest throughput','Tasks are inferred from a representative sample','Recommended ranking','Lowest cost'])assert.ok(interactiveInputs.some(i=>i.sourceText===text),text);
    assert.equal(requests,beforeInteractive+1);assert.equal(await page.evaluate(()=>window.actions),0);assert.equal(new URL(page.url()).pathname,'/interactive');
    assert.equal(await page.locator('#menu-trigger').getAttribute('aria-expanded'),'false');assert.equal(await page.locator('#lazy-tip').count(),0);
    await page.waitForFunction(()=>document.querySelector('option').label==='保存更改');assert.equal(await page.locator('select').inputValue(),'Recommended ranking');
    const beforeRepeat=await page.evaluate(()=>window.openCounts),repeatTask=await rpc('start',{tabId});await waitState(state=>state.wt_tasks[repeatTask.result.id]?.status==='completed');
    assert.deepEqual(await page.evaluate(()=>window.openCounts),beforeRepeat,'同页更新不能重复打开已采集的菜单与提示');assert.equal(requests,beforeInteractive+1);
    await page.locator('#menu-trigger').click();await page.waitForFunction(()=>document.querySelector('[role=option]')?.textContent==='保存更改');await page.keyboard.press('Escape');
    await page.locator('#tip-trigger').hover();await page.waitForFunction(()=>document.querySelector('#lazy-tip > div')?.textContent==='保存更改');
    assert.equal(await page.evaluate(()=>window.actions),0);assert.equal(requests,beforeInteractive+1);
    await page.screenshot({path:path.join(output,'interactive-tooltip.png'),fullPage:true});await page.mouse.move(1200,850);
    await page.reload();await page.locator('#menu-trigger').click();await page.waitForFunction(()=>document.querySelector('[role=option]')?.textContent==='保存更改');assert.equal(requests,beforeInteractive+1);
    await rpc('group-change',{group:new URL(origin).hostname,action:'enabled',enabled:false});await page.waitForFunction(()=>!document.querySelector('option').hasAttribute('label') && document.querySelector('[role=option]')?.textContent==='Highest throughput');
    assert.equal(await page.locator('select').inputValue(),'Recommended ranking');await rpc('group-change',{group:new URL(origin).hostname,action:'enabled',enabled:true});
    console.log('[interactive]',JSON.stringify({autoExpanded:true,delayedTooltip:true,optionValuesPreserved:true,actions:0,refreshReused:true}));
    await page.goto(origin+'/speed-short');await page.evaluate(()=>{document.body.replaceChildren();const main=document.createElement('main');for(let i=0;i<160;i++){const b=document.createElement('button');b.textContent='Action option'+i;main.append(b);}document.body.append(main);});
    const beforeShort=requests,shortTask=await rpc('start',{tabId});assert.equal(shortTask.ok,true);await waitState(state=>state.wt_tasks[shortTask.result.id]?.status==='completed');assert.equal(requests-beforeShort,1);assert.equal(apiBatches.at(-1).inputs.length,160,'短标签不能再按20条拆请求');
    await page.goto(origin+'/speed-long');
    const renderLong=offset=>page.evaluate(offset=>{document.body.replaceChildren();const main=document.createElement('main');for(let i=offset;i<offset+20;i++){const b=document.createElement('button');b.textContent='Long option'+i+' 界面说明'.repeat(600);main.append(b);}document.body.append(main);},offset);
    await renderLong(0);assert.equal((await rpc('capture-start',{tabId})).ok,true);
    for(let part=1;part<3;part++){await page.evaluate(part=>history.pushState({},'','/speed-long-'+part),part);await renderLong(part*20);await waitState(state=>state.wt_capture.items.length>=(part+1)*20);}
    const knownTasks=new Set(Object.keys((await rpc('state')).result.wt_tasks)),beforeLong=requests;
    assert.equal((await rpc('capture-finish')).ok,true);
    const longState=await waitState(state=>Object.values(state.wt_tasks).some(t=>!knownTasks.has(t.id) && t.status==='completed'));
    const longTask=Object.values(longState.wt_tasks).find(t=>!knownTasks.has(t.id));assert.equal(longTask.total,60);assert.ok(requests-beforeLong>1);assert.equal(peakApi,2,'多批翻译实际网络请求应有两个并发');
    console.log('[batching]',JSON.stringify({shortItems:160,shortRequests:1,longItems:60,longRequests:requests-beforeLong,peakConcurrentRequests:peakApi}));
    await ui.getByRole('tab',{name:'常规',exact:true}).click();assert.equal(await ui.locator('#autoExpandSeconds').inputValue(),'12');await ui.locator('#autoExpandSeconds').fill('7');await ui.locator('#requestTimeoutMinutes').fill('8');await ui.getByRole('button',{name:'保存常规设置',exact:true}).click();
    await waitState(state=>state.wt_preferences.requestTimeoutMinutes===8);await ui.reload();await ui.waitForFunction(()=>document.querySelector('#requestTimeoutMinutes').value==='8');assert.equal(await ui.locator('#requestTimeoutMinutes').inputValue(),'8');
    assert.equal(await ui.locator('#autoExpandSeconds').inputValue(),'7');assert.equal((await rpc('state')).result.wt_preferences.autoExpandSeconds,7);
    const selectedSource='Missed selected account description';
    await context.route(origin+'/manual-queue',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="en"><body><main><p class="account-panel">'+selectedSource+'</p><a href="/help"><code>protected code</code></a><input value="private-input"></main></body></html>'}));
    await page.goto(origin+'/manual-queue');
    await rpc('change',{siteId:origin,kind:'entry',payload:{sourceText:selectedSource,context:'main/p/text',path:'/manual-queue',sourceLanguage:null,targetLanguage:'zh-Hans',origin:'ai',category:'uncertain',action:'skip',translation:null}});
    await page.evaluate(()=>{const node=document.querySelector('p').firstChild,r=document.createRange();r.setStart(node,2);r.setEnd(node,6);getSelection().removeAllRanges();getSelection().addRange(r);});
    const box=await page.locator('p').boundingBox();await page.mouse.click(box.x+24,box.y+8,{button:'right'});await page.keyboard.press('Escape');
    const selectionText=await page.evaluate(()=>getSelection().toString()),beforeManual=requests;
    assert.ok(selectionText.length,'真实右键后选区仍存在');
    await worker.evaluate(async({tabId,selectionText})=>{const tab=await chrome.tabs.get(tabId);await globalThis.__selectionHandlers[0]({menuItemId:'wt-add-selection',frameId:0,selectionText},tab);},{tabId,selectionText});
    await waitState(state=>state.wt_manual_queue.some(row=>row.sourceText===selectedSource));assert.equal(requests,beforeManual,'右键加入不请求 AI');
    await ui.getByRole('tab',{name:'翻译记录',exact:true}).click();await ui.locator('#manualQueue').getByText(selectedSource,{exact:true}).waitFor();await ui.screenshot({path:path.join(output,'manual-queue.png'),fullPage:true});
    await page.reload();assert.equal((await rpc('state')).result.wt_manual_queue.length,1,'刷新后待翻译队列保留');
    const manualTask=await rpc('start',{tabId});const manualState=await waitState(state=>state.wt_tasks[manualTask.result.id]?.status==='completed');
    assert.equal(manualState.wt_tasks[manualTask.result.id].requestTimeoutMinutes,8);assert.equal(manualState.wt_manual_queue.length,0);assert.equal(requests,beforeManual+1);assert.equal(apiBatches.at(-1).inputs[0].sourceText,selectedSource);assert.equal(apiBatches.at(-1).inputs[0].userSelected,true);
    await page.waitForFunction(()=>document.querySelector('p').textContent==='保存更改');assert.equal(await page.locator('a').getAttribute('href'),'/help');assert.equal(await page.locator('code').textContent(),'protected code');assert.equal(await page.locator('input').inputValue(),'private-input');
    await page.reload();await page.waitForFunction(()=>document.querySelector('p').textContent==='保存更改');assert.equal(requests,beforeManual+1,'刷新本地复用手动指定译文');
    console.log('[manual]',JSON.stringify({pendingAfterSelection:1,requestsWhenQueued:0,requestsToTranslate:1,timeoutMinutes:8,refreshReused:true}));
    await context.route(origin+'/email-label',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="en"><body><main><p>Personal Account: fixture@example.com</p></main></body></html>'}));
    await page.goto(origin+'/email-label');
    await page.evaluate(()=>{const r=document.createRange();r.setStart(document.querySelector('p').firstChild,0);r.setEnd(document.querySelector('p').firstChild,16);getSelection().removeAllRanges();getSelection().addRange(r);document.querySelector('p').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true}));});
    const beforeLabel=requests;
    await worker.evaluate(async tabId=>{const tab=await chrome.tabs.get(tabId);await globalThis.__selectionHandlers[0]({menuItemId:'wt-add-selection',frameId:0,selectionText:'Personal Account'},tab);},tabId);
    const labelState=await waitState(state=>state.wt_manual_queue.some(row=>row.sourceText==='Personal Account'));
    assert.ok(!JSON.stringify(labelState.wt_manual_queue).includes('fixture@example.com'));assert.equal(requests,beforeLabel);
    const labelTask=await rpc('start',{tabId});await waitState(state=>state.wt_tasks[labelTask.result.id]?.status==='completed');
    assert.equal(requests,beforeLabel+1);assert.ok(!JSON.stringify(apiBatches.at(-1)).includes('fixture@example.com'));assert.equal(apiBatches.at(-1).inputs[0].sourceText,'Personal Account');
    await page.waitForFunction(()=>document.querySelector('p').textContent==='保存更改: fixture@example.com');
    await page.reload();await page.waitForFunction(()=>document.querySelector('p').textContent==='保存更改: fixture@example.com');assert.equal(requests,beforeLabel+1);
    console.log('[email-label]',JSON.stringify({labelOnly:true,emailSent:false,refreshReused:true}));
    await ui.getByRole('tab',{name:'常规',exact:true}).click();
    await ui.locator('#pageCaptureItems').fill('2');await ui.locator('#pageCaptureChars').fill('90000');await ui.locator('#sessionCaptureItems').fill('4000');await ui.locator('#sessionCaptureChars').fill('500000');await ui.locator('#inputContextK').fill('10');await ui.getByRole('button',{name:'保存常规设置',exact:true}).click();
    await waitState(state=>state.wt_preferences.pageCaptureItems===2 && state.wt_preferences.inputContextK===10);await ui.reload();await ui.waitForFunction(()=>document.querySelector('#inputContextK').value==='10');assert.equal(await ui.locator('#inputContextK').inputValue(),'10');assert.equal(await ui.locator('#sessionCaptureChars').inputValue(),'500000');
    await page.goto(origin+'/progressive');await page.evaluate(()=>document.body.innerHTML='<main>'+Array.from({length:6},(_,i)=>'<p>Progressive item '+i+'</p>').join('')+'</main>');
    const beforeProgressive=requests;
    for(let round=0;round<3;round++){const task=await rpc('start',{tabId});const state=await waitState(state=>state.wt_tasks[task.result.id]?.status==='completed');assert.equal(state.wt_tasks[task.result.id].total,2);assert.equal(state.wt_tasks[task.result.id].contextBudget,10000);assert.deepEqual(apiBatches.at(-1).inputs.map(i=>i.sourceText),['Progressive item '+(round*2),'Progressive item '+(round*2+1)]);}
    const emptyTask=await rpc('start',{tabId});await waitState(state=>state.wt_tasks[emptyTask.result.id]?.status==='completed');assert.equal(requests,beforeProgressive+3);
    await builtin.evaluate(()=>{const node=document.querySelector('button').firstChild,r=document.createRange();r.selectNodeContents(node);getSelection().removeAllRanges();getSelection().addRange(r);document.querySelector('button').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true}));});
    const builtinSelected=await builtin.evaluate(()=>getSelection().toString()),beforeForced=requests;
    await worker.evaluate(async({tabId,selectionText})=>{await __selectionHandlers[0]({menuItemId:'wt-add-selection',frameId:0,selectionText},await chrome.tabs.get(tabId));},{tabId:builtinTab,selectionText:builtinSelected});
    await waitState(state=>state.wt_manual_queue.some(i=>i.sourceText==='Pricing'));
    const forcedTask=await rpc('start',{tabId:builtinTab});await waitState(state=>state.wt_tasks[forcedTask.result.id]?.status==='completed');assert.equal(requests,beforeForced+1);assert.equal(apiBatches.at(-1).inputs[0].sourceText,'Pricing');
    await builtin.waitForFunction(()=>document.querySelector('button').textContent==='保存更改');await builtin.reload();await builtin.waitForFunction(()=>document.querySelector('button').textContent==='保存更改');
    console.log('[limits]',JSON.stringify({pageItems:2,contextK:10,progressiveRequests:3,forcedBuiltinRequests:1}));


    await ui.reload();await ui.getByRole('tab',{name:'网站管理',exact:true}).click();
    for(const details of await ui.locator('.domain-group').all())await details.locator(':scope > summary').click();
    await ui.screenshot({path:path.join(output,'management.png'),fullPage:true});
    await ui.evaluate(()=>chrome.storage.local.set({wt_subscription_models:[{slug:'fixture-subscription-model',display_name:'测试订阅模型'},{slug:'fixture-other-model',display_name:'另一个模型'}]}));await ui.reload();
    await ui.getByRole('tab',{name:'AI 翻译',exact:true}).click();await ui.screenshot({path:path.join(output,'ai-settings.png'),fullPage:true});
    await ui.locator('#provider').selectOption('chatgpt');
    assert.equal(await ui.locator('#helper').isVisible(),true);assert.equal(await ui.locator('[role=tab]').count(),5);
    assert.equal(await ui.locator('#endpoint').isVisible(),false);assert.equal(await ui.locator('#apiKey').isVisible(),false);assert.equal(await ui.locator('#reasoningEffort').isVisible(),true);
    await ui.locator('#modelSelect').selectOption('fixture-subscription-model');assert.equal(await ui.locator('#modelSelect option').count(),3);await ui.locator('#reasoningEffort').selectOption('high');
    const buttonRows=await ui.locator('.service-actions button:visible').evaluateAll(nodes=>nodes.map(n=>Math.round(n.getBoundingClientRect().top)));assert.equal(new Set(buttonRows).size,1,'桌面宽度订阅按钮应保持同一行');
    await ui.screenshot({path:path.join(output,'subscription-settings.png'),fullPage:true});
    await ui.locator('#prompt').fill('所有服务共用的提示词');
    await ui.locator('#provider').selectOption('azure');assert.equal(await ui.locator('#region').isVisible(),true);assert.equal(await ui.locator('#model').isVisible(),false);assert.equal(await ui.locator('#prompt').isVisible(),true);assert.equal(await ui.locator('#prompt').inputValue(),'所有服务共用的提示词');
    await ui.locator('#provider').selectOption('deepl');await ui.locator('#promptForm button[type=submit]').click();await waitState(state=>state.wt_prompt==='所有服务共用的提示词');
    const fonts=await ui.evaluate(()=>Object.fromEntries(['body','#provider','#prompt','#promptField','.service-actions button'].map(selector=>[selector,getComputedStyle(document.querySelector(selector)).fontSize])));assert.deepEqual(fonts,{'body':'14px','#provider':'16px','#prompt':'16px','#promptField':'16px','.service-actions button':'14px'});
    await ui.screenshot({path:path.join(output,'deepl-prompt-settings.png'),fullPage:true});
    await ui.locator('#provider').selectOption('api');assert.equal(await ui.locator('#apiKey').inputValue(),'fixture-key');assert.equal(await ui.locator('#helper').isVisible(),false);
    await ui.getByRole('tab',{name:'常规',exact:true}).click();await ui.screenshot({path:path.join(output,'general-settings.png'),fullPage:true});
    await ui.getByRole('tab',{name:'GitHub 仓库',exact:true}).click();assert.equal(await ui.locator('#repositoryForm').isVisible(),true);assert.equal(await ui.locator('#syncHelper').count(),0);await ui.screenshot({path:path.join(output,'sync-settings.png'),fullPage:true});
    const popup=await context.newPage();popup.on('pageerror',e=>errors.push(e.message));await popup.setViewportSize({width:360,height:600});await popup.goto('chrome-extension://'+id+'/popup/popup.html');await popup.locator('#status').filter({hasText:'已开启'}).waitFor();await popup.locator('main').screenshot({path:path.join(output,'popup.png')});
    assert.equal(await popup.locator('#wtManage').isVisible(),true);assert.equal(await popup.locator('#wtDictionaryDownload').count(),1);assert.equal(await popup.locator('#wtSiteToggle').count(),1);
    assert.deepEqual(errors,[]);
    const result={passed:true,browser:await context.browser().version(),apiRequests:requests,dynamicSource:{initial:initialNotice,changed:changedNotice,latest:latestNotice,final:finalNotice,aiSources:apiBatches.slice(2).map(b=>b.inputs.map(i=>i.sourceText))},checks:['下拉自动展开兼容 pointerdown 且不选择选项','延迟悬浮提示自动触发与刷新复用','原生选项显示翻译保留隐式提交值','连续更新越过已翻译项','五项预算保存回显','右键强制重译内置词条并稳定复用','同节点邮箱标签独立补译与隐私隔离','常规超时保存回显与任务快照','真实选区加右键事件及注册菜单回调','待翻译刷新保留与旧skip补译','手动译文刷新复用与输入保护','管理页加载与保存','后台任务与真实内容脚本','API mock 添加','刷新本地复用不请求 AI','zh-Hans/ja 隔离与切换恢复','代码与输入保护','停用恢复 lang','删除持久化','内置人工词库不重复调用 AI','内置中文引擎受语言隔离并清理标记','内置网站原文更新重新采集','连续改写仅发送最新原文','已存动态词条复用不重复请求','动态原文停用及跨语言恢复','采集跨导航与 window.open 子页面','采集过程中零 AI 请求','一次提交多页及表单提示','输入值与密码从未提交','placeholder 本地复用及语言切换','主域名分组启停','新设置标签与弹窗加载'],limits:['localhost 权限在隔离测试 manifest 中预授予','模拟页面/API，无真实账号','不代表个人浏览器、真实账号或双设备验收']};
    await fs.writeFile(path.join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
  }finally{await context?.close();server.close();server.closeAllConnections();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
