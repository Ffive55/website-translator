'use strict';
// Explicit live-site check: isolated Edge profile, public page, no account or AI calls.
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const ROOT=path.resolve(__dirname,'..');
async function main(){
  const output=path.join(ROOT,'.cache/openrouter-smoke');await fs.mkdir(output,{recursive:true});
  const fixture=path.join(output,'extension');await fs.cp(path.join(ROOT,'edge'),fixture,{recursive:true,filter:p=>!p.includes(path.sep+'local-helper')});
  const manifest=JSON.parse(await fs.readFile(path.join(fixture,'manifest.json'),'utf8'));manifest.host_permissions.push('https://openrouter.ai/*');await fs.writeFile(path.join(fixture,'manifest.json'),JSON.stringify(manifest));
  const context=await chromium.launchPersistentContext(path.join(output,'profile-'+Date.now()),{channel:'msedge',headless:true,args:[`--disable-extensions-except=${fixture}`,`--load-extension=${fixture}`],viewport:{width:1440,height:1000}});
  try{
    let [worker]=context.serviceWorkers();if(!worker)worker=await context.waitForEvent('serviceworker');
    const page=await context.newPage();await page.goto('https://openrouter.ai/rankings#top-models',{waitUntil:'domcontentloaded',timeout:60000});
    await page.locator('#task-spend [data-base-ui-tooltip-trigger]').first().waitFor({timeout:45000});
    const tabId=await worker.evaluate(async()=> (await chrome.tabs.query({url:'https://openrouter.ai/*'}))[0].id);
    await worker.evaluate(tabId=>chrome.scripting.executeScript({target:{tabId},files:['managed/core.js','managed/text-provenance.js','managed/content.js']}),tabId);
    const site={id:'https://openrouter.ai',enabled:true,deleted:false,targetLanguage:'zh-Hans',excludedPaths:[],entries:{}};
    const C=require('../extension/managed-core'),collected=new Map(),rounds=[],appSource='A coding agent that helps you build and ship with AI';
    const appCardItem=item=>item.sourceText===appSource && !item.context.endsWith('/span/button') && !item.context.includes('/@');
    await page.evaluate(()=>{window.__wtInfoOpens=0;window.__wtMenuOpens=[0,0];document.querySelector('#task-spend button[data-base-ui-tooltip-trigger][tabindex="-1"]').addEventListener('mouseenter',()=>window.__wtInfoOpens++);Array.from(document.querySelectorAll('#leaderboard-table [role="combobox"]')).slice(0,2).forEach((el,index)=>el.addEventListener('pointerdown',()=>{if(el.getAttribute('aria-expanded')==='false')window.__wtMenuOpens[index]++;}));});
    for(let round=0;round<10;round++){
      const scan=await worker.evaluate(({tabId,site})=>chrome.tabs.sendMessage(tabId,{type:'wt:collect',expand:true,site,autoExpandSeconds:60}),{tabId,site});assert.ok(!scan.error,scan.error);
      rounds.push(scan.exploration);console.log('round',round+1,JSON.stringify(scan.exploration));
      // Simulate successful local processing so quotas are released without sending data to AI.
      for(const item of scan.items){collected.set(C.canonical(item),item);const e={...item,targetLanguage:'zh-Hans',sourceLanguage:null,translation:null,category:'ui',action:'skip',origin:'manual'};site.entries[C.entryKey(e)]=e;}
      if(scan.exploration.attempted===0 || ([...collected.values()].some(appCardItem) && [...collected.values()].some(i=>!i.context.includes('/@') && i.sourceText.startsWith('Tasks are inferred'))))break;
    }
    const tips=[...collected.values()].filter(i=>!i.context.includes('/@') && /Tasks are inferred|representative sample of prompts/.test(i.sourceText));
    const again=await worker.evaluate(({tabId,site})=>chrome.tabs.sendMessage(tabId,{type:'wt:collect',expand:true,site}),{tabId,site});
    const infoOpens=await page.evaluate(()=>window.__wtInfoOpens);assert.equal(infoOpens,1,'已采集提示只能自动展开一次');
    const menuOpens=await page.evaluate(()=>window.__wtMenuOpens);assert.deepEqual(menuOpens,[1,1],'已采集的两个排行榜下拉框不能在后续更新重复展开');
    const dropdownOptions=[];
    for(const dropdown of await page.locator('[role="combobox"][aria-haspopup="listbox"]').all()) {
      if(!await dropdown.isVisible() || !await dropdown.isEnabled())continue;
      const initialValue=await dropdown.innerText(),label=await dropdown.getAttribute('aria-label');
      await dropdown.click();await page.getByRole('option').first().waitFor();
      const options=(await page.getByRole('option').allTextContents()).map(text=>text.trim());
      for(const text of options)assert.ok([...collected.values()].some(i=>i.sourceText.trim()===text),'自动采集应包含 '+(label || initialValue)+' 下拉选项：'+text);
      dropdownOptions.push({label:label || initialValue,options});
      await page.keyboard.press('Escape');await page.getByRole('option').first().waitFor({state:'hidden'});assert.equal(await dropdown.innerText(),initialValue,'只展开不改变选择');
    }
    const appCards=[...collected.values()].filter(appCardItem);assert.ok(appCards.length,'必须采集热门应用简介的悬浮卡片正文');
    const report={url:page.url(),browser:await context.browser().version(),rounds,nextRoundAttempted:again.exploration.attempted,infoOpens,menuOpens,dropdownOptions,taskTooltip:tips,appCards,aiRequests:0};
    console.log(JSON.stringify(report,null,2));await fs.writeFile(path.join(output,'result.json'),JSON.stringify(report,null,2));
    assert.ok(tips.length,'必须采集实际提示层文字，不能把 aria-label 误当作悬浮正文');
    for(const item of tips){const e={...item,targetLanguage:'zh-Hans',sourceLanguage:null,translation:'任务由分类器根据具有代表性的提示样本推断。百分比表示样本校正后的支出占比；变化量与上一时间窗口比较。',category:'ui',action:'translate',origin:'manual'};site.entries[C.entryKey(e)]=e;}
    await worker.evaluate(({tabId,site})=>chrome.tabs.sendMessage(tabId,{type:'wt:apply',globalEnabled:true,site}),{tabId,site});
    await page.locator('#task-spend button[data-base-ui-tooltip-trigger][tabindex="-1"]').hover();
    await page.locator('[data-base-ui-portal] [data-base-ui-focusable][data-side]').filter({hasText:'任务由分类器根据具有代表性的提示样本推断'}).waitFor({timeout:10000});
    await page.screenshot({path:path.join(output,'task-tooltip.png')});
    // Client rendering can change the card wrapper; bind its actual trigger before translation.
    const appTrigger=page.locator('#apps [data-base-ui-click-trigger],#apps [data-base-ui-tooltip-trigger]').filter({hasText:appSource});
    console.log('app trigger',await appTrigger.evaluate(el=>el.outerHTML));
    const appTriggerId=await appTrigger.getAttribute('id');assert.ok(appTriggerId);
    for(const item of appCards){const e={...item,targetLanguage:'zh-Hans',sourceLanguage:null,translation:'帮助你借助 AI 构建和交付的编程智能体',category:'stable_content',action:'translate',origin:'manual'};site.entries[C.entryKey(e)]=e;}
    await worker.evaluate(({tabId,site})=>chrome.tabs.sendMessage(tabId,{type:'wt:apply',globalEnabled:true,site}),{tabId,site});
    await page.locator(await page.evaluate(id=>'#'+CSS.escape(id),appTriggerId)).hover();
    await page.locator('[data-base-ui-portal]').getByText('帮助你借助 AI 构建和交付的编程智能体',{exact:true}).waitFor({timeout:10000});
    assert.equal(new URL(page.url()).pathname,'/rankings');await page.screenshot({path:path.join(output,'app-card.png')});
    await fs.writeFile(path.join(output,'result.json'),JSON.stringify({...report,localTranslationVerified:true,appCardTranslationVerified:true},null,2));
    console.log('PASS: live tooltip collected and locally translated; no AI request.');
  }finally{await context.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
