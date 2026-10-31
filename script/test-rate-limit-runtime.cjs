'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict'),{chromium}=require('playwright');
const ROOT=path.resolve(__dirname,'..');
async function main(){
 const output=path.join(ROOT,'.cache/rate-limit-runtime'),fixture=path.join(output,'extension');await fs.mkdir(output,{recursive:true});await fs.cp(path.join(ROOT,'edge'),fixture,{recursive:true,filter:p=>!p.includes(path.sep+'local-helper')});
 const workerFile=path.join(fixture,'managed/worker.js'),base=await fs.readFile(workerFile,'utf8');
 await fs.writeFile(workerFile,`const originalFetch=fetch.bind(globalThis);globalThis.__requests=0;globalThis.fetch=async(url,options)=>{if(!String(url).startsWith('https://api.github.com/'))return originalFetch(url,options);__requests++;return new Response(JSON.stringify({message:'API rate limit exceeded'}),{status:403,headers:{'x-ratelimit-limit':options.headers.Authorization?'5000':'60','x-ratelimit-remaining':'0','x-ratelimit-reset':String(Math.floor(Date.now()/1000)+3600)}});};\n`+base);
 const context=await chromium.launchPersistentContext(path.join(output,'profile-'+Date.now()),{channel:'msedge',headless:true,args:[`--disable-extensions-except=${fixture}`,`--load-extension=${fixture}`]});const checks=[];
 const check=(condition,label)=>{assert.ok(condition,label);checks.push(label);console.log('PASS '+label);};
 try{
  let worker=context.serviceWorkers()[0];if(!worker)worker=await context.waitForEvent('serviceworker',{timeout:15000});const id=worker.url().split('/')[2];let ui=await context.newPage();await ui.goto(`chrome-extension://${id}/managed/managed.html`);
  const rpc=(action,data={})=>ui.evaluate(async({action,data})=>chrome.runtime.sendMessage({type:'wt:dictionary-action',action,...data}),{action,data});
  await ui.evaluate(()=>chrome.runtime.sendMessage({type:'wt:state'}));const repository={owner:'Ffive55',repo:'website-translator',branch:'main'};
  const anonymous=await rpc('configure',{repository,token:''});check(anonymous.result.includes('尚未配置 GitHub Token'),'空 Token 保存明确说明匿名模式，不假称凭据已保存');
  const failed=await rpc('check');check(!failed.ok&&failed.error.includes('匿名请求')&&failed.error.includes('60/小时'),'限流提示包含匿名方式和真实配额');
  await rpc('check');check(await worker.evaluate(()=>__requests)===1,'同一线程重复检查不消耗新请求');
  const nextWorker=context.waitForEvent('serviceworker',{timeout:15000});await worker.evaluate(()=>chrome.runtime.reload()).catch(()=>{});worker=await nextWorker;ui=await context.newPage();await ui.goto(`chrome-extension://${id}/managed/managed.html`);await ui.evaluate(()=>chrome.runtime.sendMessage({type:'wt:state'}));
  const blocked=await rpc('check');check(!blocked.ok&&await worker.evaluate(()=>__requests)===0,'线程重启后手动检查继续遵守持久化等待时间');
  await rpc('configure',{repository,token:''});await rpc('check');check(await worker.evaluate(()=>__requests)===0,'重复保存同一访问方式不会清除限流等待');
  await rpc('configure',{repository,token:'fixture-different-budget'});const tokenResult=await rpc('check');check(!tokenResult.ok&&tokenResult.error.includes('已携带 Token')&&tokenResult.error.includes('5000/小时'),'新凭据使用独立访问身份，并准确显示 Token 请求额度');
  check(await worker.evaluate(()=>__requests)===1,'新凭据限流后同样停止后续请求');
  const stored=await worker.evaluate(()=>chrome.storage.local.get('wt_repository_status'));check(!JSON.stringify(stored).includes('fixture-different-budget'),'诊断仅保存不含令牌的访问标识和响应配额');
  await fs.writeFile(path.join(output,'result.json'),JSON.stringify({checks,count:checks.length},null,2));
 }finally{await context.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
