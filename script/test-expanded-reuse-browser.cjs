'use strict';
// Real public page + real extension task/storage/apply flow, using only a local mock translator.
const fs=require('node:fs/promises'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const ROOT=path.resolve(__dirname,'..');
async function main(){
  const output=path.join(ROOT,'.cache/expanded-reuse');await fs.mkdir(output,{recursive:true});let requests=0;
  const server=http.createServer(async(req,res)=>{
    try{let text='';for await(const part of req)text+=part;const payload=JSON.parse(JSON.parse(text).messages[1].content);requests++;
      const labels={'All models':'全部模型','Open models':'开放模型','Closed models':'闭源模型','This Week':'本周','This Month':'本月','Today':'今天','English':'英语','Weighted Avg Input Price':'加权平均输入价格','Intelligence Index Score':'智能指数得分','Throughput':'吞吐量'};
      const rows=payload.inputs.map(item=>({id:item.id,category:'ui',action:'translate',translation:labels[item.sourceText] || '译文：'+item.sourceText,reason:''}));
      await new Promise(resolve=>setTimeout(resolve,1000));
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(rows)}}]}));
    }catch(error){res.statusCode=500;res.end(error.message);}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const endpoint=`http://127.0.0.1:${server.address().port}/v1/chat/completions`;let context;
  try{
    const fixture=path.join(output,'extension');await fs.cp(path.join(ROOT,'edge'),fixture,{recursive:true,filter:p=>!p.includes(path.sep+'local-helper')});
    const manifest=JSON.parse(await fs.readFile(path.join(fixture,'manifest.json'),'utf8'));manifest.host_permissions.push('https://openrouter.ai/*','http://127.0.0.1/*');await fs.writeFile(path.join(fixture,'manifest.json'),JSON.stringify(manifest));
    context=await chromium.launchPersistentContext(path.join(output,'profile-'+Date.now()),{channel:'msedge',headless:true,args:[`--disable-extensions-except=${fixture}`,`--load-extension=${fixture}`],viewport:{width:1440,height:1000}});
    let [worker]=context.serviceWorkers();if(!worker)worker=await context.waitForEvent('serviceworker');const extensionId=worker.url().split('/')[2];
    const ui=await context.newPage();await ui.goto(`chrome-extension://${extensionId}/managed/managed.html`);
    const rpc=(type,data={})=>ui.evaluate(({type,data})=>chrome.runtime.sendMessage({type:'wt:'+type,...data}),{type,data});
    assert.equal((await rpc('config',{ai:{provider:'api',endpoint,apiKey:'isolated-fixture-key',model:'fixture'},preferences:{autoExpandSeconds:12}})).ok,true);
    const page=await context.newPage();await page.goto('https://openrouter.ai/rankings#top-models',{waitUntil:'domcontentloaded',timeout:60000});await page.locator('#leaderboard-table [role="combobox"]').first().waitFor({timeout:45000});
    const tabId=await worker.evaluate(async()=>(await chrome.tabs.query({url:'https://openrouter.ai/*'}))[0].id);
    await page.evaluate(()=>{window.__menuOpens={};document.addEventListener('pointerdown',event=>{
      const el=event.target.closest('[role="combobox"]');if(!el || el.getAttribute('aria-expanded')!=='false')return;
      let region=el.parentElement;while(region && (!region.id || region.id.startsWith('base-ui-')))region=region.parentElement;
      if(!region)return;const key=region.id+':'+[...region.querySelectorAll('[role="combobox"]')].indexOf(el);window.__menuOpens[key]=(window.__menuOpens[key] || 0)+1;
    },true);});
    const rounds=[];let quietRounds=0;
    for(let round=0;round<10;round++){
      await ui.bringToFront();const started=await rpc('start',{tabId});assert.equal(started.ok,true,started.error);await page.bringToFront();
      let task;const deadline=Date.now()+180000;
      while(Date.now()<deadline){const state=await rpc('state');task=state.result.wt_tasks[started.result.id];if(task.status!=='running')break;await new Promise(resolve=>setTimeout(resolve,100));}
      assert.equal(task.status,'completed',JSON.stringify(task));
      const result={round:round+1,total:task.total,translated:task.translated,requests,opens:await page.evaluate(()=>window.__menuOpens)};rounds.push(result);console.log(JSON.stringify(result));
      quietRounds=task.total===0?quietRounds+1:0;if(quietRounds>=2)break;
    }
    await fs.writeFile(path.join(output,'result.json'),JSON.stringify(rounds,null,2));
    assert.ok(Object.keys(rounds.at(-1).opens).length>=11,'应覆盖排行榜的全部下拉框');
    for(const [key,count] of Object.entries(rounds.at(-1).opens))assert.equal(count,1,'翻译完成后重复展开：'+key);
    assert.equal(new URL(page.url()).pathname,'/rankings');
  }finally{await context?.close();server.close();server.closeAllConnections();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
