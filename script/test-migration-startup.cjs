'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict'),{chromium}=require('playwright');
const {fixture}=require('../tests/fixtures/history.cjs');
const ROOT=path.resolve(__dirname,'..');
async function main(){
 const output=path.join(ROOT,'.cache/migration-startup'),extension=path.join(output,'extension');await fs.mkdir(output,{recursive:true});await fs.cp(path.join(ROOT,'edge'),extension,{recursive:true,filter:p=>!p.includes(path.sep+'local-helper')});
 const database=fixture(4000),original=await fs.readFile(path.join(extension,'managed/worker.js'),'utf8');
 const seed=`const nativeGet=chrome.storage.local.get.bind(chrome.storage.local);globalThis.__cold=false;chrome.storage.local.get=async keys=>{const result=await nativeGet(keys);if(Array.isArray(keys)&&keys.includes('wt_database')&&!result.wt_database){globalThis.__cold=true;return {...result,wt_database:${JSON.stringify(database)}};}return result;};
 const open=IDBFactory.prototype.open;IDBFactory.prototype.open=function(...args){const request=open.apply(this,args);return {get result(){return request.result;},get error(){return request.error;},set onupgradeneeded(fn){request.onupgradeneeded=fn;},set onerror(fn){request.onerror=fn;},set onblocked(fn){request.onblocked=fn;},set onsuccess(fn){request.onsuccess=e=>setTimeout(()=>fn(e),globalThis.__cold?2500:0);}};};
 const nativeFetch=fetch.bind(globalThis);globalThis.__apiCalls=0;globalThis.fetch=async(url,options)=>{if(String(url).startsWith('https://api.github.com/')){__apiCalls++;return new Response(JSON.stringify({message:'Resource not accessible by personal access token'}),{status:403,headers:{'x-ratelimit-remaining':'4999'}});}return nativeFetch(url,options);};\n`;
 await fs.writeFile(path.join(extension,'managed/worker.js'),seed+original);
 const context=await chromium.launchPersistentContext(path.join(output,'profile-'+Date.now()),{channel:'msedge',headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
 try{
  let worker=context.serviceWorkers()[0];if(!worker)worker=await context.waitForEvent('serviceworker',{timeout:15000});const id=worker.url().split('/')[2];
  const popup=await context.newPage();const opened=context.waitForEvent('page');await popup.goto(`chrome-extension://${id}/popup/popup.html`);const clickStart=Date.now();await popup.locator('#wtManage').click({timeout:2000});let settings=await opened;await settings.waitForURL(/managed\/managed.html/);const settingsOpenMs=Date.now()-clickStart;
  assert.ok(settingsOpenMs<2500,'设置入口不应等待人为延迟的数据库连接');assert.equal(await popup.locator('main').getAttribute('inert'),null);
  const rpc=(type,data={})=>settings.evaluate(async({type,data})=>{const r=await chrome.runtime.sendMessage({type:'wt:'+type,...data});if(!r.ok)throw Error(r.error);return r.result;},{type,data});
  const start=Date.now();let state;for(let i=0;i<300;i++){state=await rpc('state');if(state.dictionary.ready)break;await new Promise(r=>setTimeout(r,50));}
  const coldReadyMs=Date.now()-start;assert.ok(state.dictionary.ready,'旧数据迁移应完成');assert.equal(state.dictionary.groups['example.com'].pending,4000);assert.equal(Object.keys(state.sites['https://history.example.com'].entries).length,4000);
  await new Promise(r=>setTimeout(r,500));state=await rpc('state');assert.equal(state.dictionary.status.networkKind,'authorization');const calls=await worker.evaluate(()=>__apiCalls);await rpc('dictionary-action',{action:'restore'});assert.equal(await worker.evaluate(()=>__apiCalls),calls,'授权拒绝后不继续重复请求');
  const warmStart=Date.now(),newWorker=context.waitForEvent('serviceworker',{timeout:15000});await worker.evaluate(()=>chrome.runtime.reload()).catch(()=>{});worker=await newWorker;settings=await context.newPage();await settings.goto(`chrome-extension://${id}/managed/managed.html`);
  for(let i=0;i<200;i++){state=await rpc('state');if(state.dictionary.ready)break;await new Promise(r=>setTimeout(r,50));}const warmReadyMs=Date.now()-warmStart;assert.ok(state.dictionary.ready);assert.equal(state.dictionary.groups['example.com'].pending,4000);
  const result={passed:true,entries:4000,injectedColdDatabaseDelayMs:2500,settingsOpenMs,coldReadyMs,warmReadyMs,apiCallsBeforeReload:calls,checks:['迁移期间设置立即打开','4000 条旧词条保留待上传状态','403 权限提示不误报限流','拒绝重复自动请求','重新加载不丢词条和待上传状态']};
  await fs.writeFile(path.join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
 }finally{await context.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
