'use strict';
// Live public image leaderboard, isolated Edge and local dictionary only; no AI/account calls.
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),C=require('../extension/managed-core');
const ROOT=path.resolve(__dirname,'..');
async function main(){
  const output=path.join(ROOT,'.cache/show-more-smoke');await fs.mkdir(output,{recursive:true});
  const fixture=path.join(output,'extension');await fs.cp(path.join(ROOT,'edge'),fixture,{recursive:true,filter:p=>!p.includes(path.sep+'local-helper')});
  const manifest=JSON.parse(await fs.readFile(path.join(fixture,'manifest.json'),'utf8'));manifest.host_permissions.push('https://openrouter.ai/*');await fs.writeFile(path.join(fixture,'manifest.json'),JSON.stringify(manifest));
  const context=await chromium.launchPersistentContext(path.join(output,'profile-'+Date.now()),{channel:'msedge',headless:true,args:[`--disable-extensions-except=${fixture}`,`--load-extension=${fixture}`],viewport:{width:1440,height:1000}});
  try{
    let [worker]=context.serviceWorkers();if(!worker)worker=await context.waitForEvent('serviceworker');
    const page=await context.newPage();await page.goto('https://openrouter.ai/rankings/image#leaderboard-table',{waitUntil:'domcontentloaded',timeout:60000});
    const region=page.locator('#leaderboard-table');await region.getByRole('button',{name:'Show more',exact:true}).waitFor({timeout:45000});
    const tabId=await worker.evaluate(async()=>(await chrome.tabs.query({url:'https://openrouter.ai/*'}))[0].id);
    await worker.evaluate(tabId=>chrome.scripting.executeScript({target:{tabId},files:['managed/core.js','managed/text-provenance.js','managed/content.js']}),tabId);
    const site={id:'https://openrouter.ai',enabled:true,deleted:false,targetLanguage:'zh-Hans',excludedPaths:[],entries:{}};
    const send=message=>worker.evaluate(({tabId,message})=>chrome.tabs.sendMessage(tabId,message),{tabId,message});
    const baseline=await send({type:'wt:collect',site});
    for(const item of baseline.items)if(['Show more','by'].includes(item.sourceText.trim())){const e={...item,sourceLanguage:null,targetLanguage:'zh-Hans',category:'ui',action:'translate',origin:'manual',translation:item.sourceText.trim()==='Show more'?'显示更多':'作者 '};site.entries[C.entryKey(e)]=e;}
    await send({type:'wt:apply',site,globalEnabled:true});await region.getByRole('button',{name:'显示更多',exact:true}).waitFor();
    const before=await region.locator('a').allTextContents();
    await page.evaluate(()=>{window.__moreClicks=0;document.querySelector('#leaderboard-table').addEventListener('click',event=>{const b=event.target.closest('button');if(b && /^(Show more|显示更多)$/.test(b.textContent.trim()))window.__moreClicks++;},true);});
    const scan=await send({type:'wt:collect',site,expand:true,autoExpandSeconds:1});assert.ok(!scan.error,scan.error);
    await page.waitForFunction(count=>document.querySelectorAll('#leaderboard-table a').length>count,before.length);
    const after=await region.locator('a').allTextContents(),added=after.filter(text=>!before.includes(text));
    assert.ok(added.length>0);assert.ok(added.some(text=>scan.items.some(item=>item.sourceText.trim()===text.trim())),'新增行文字应进入采集结果');
    assert.equal(await page.evaluate(()=>window.__moreClicks),1);assert.equal(await region.getByRole('button',{name:'显示更多',exact:true}).count(),0);
    await send({type:'wt:collect',site,expand:true,autoExpandSeconds:1});assert.equal(await page.evaluate(()=>window.__moreClicks),1,'再次更新不能重复点击已经完成的展开按钮');
    const applied=await worker.evaluate(tabId=>chrome.scripting.executeScript({target:{tabId},func:()=>{const walker=document.createTreeWalker(document.querySelector('#leaderboard-table'),NodeFilter.SHOW_TEXT);let count=0;while(walker.nextNode())if(WTText.source(walker.currentNode).trim()==='by' && walker.currentNode.data.trim()==='作者')count++;return count;}}),tabId);
    assert.ok(applied[0].result>=20,'新显示行应自动复用已有标签译文');
    await region.screenshot({path:path.join(output,'expanded-leaderboard.png')});
    const report={passed:true,url:page.url(),beforeLinks:before.length,afterLinks:after.length,addedTexts:added,moreClicks:1,translatedAuthorLabels:applied[0].result,aiRequests:0};
    await fs.writeFile(path.join(output,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
  }finally{await context.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
