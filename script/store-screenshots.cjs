'use strict';
// Actual settings UI in an isolated Edge profile. All repository traffic is mocked.
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{Resvg}=require('@resvg/resvg-js');
const ROOT=path.resolve(__dirname,'..');
async function main(){
 const {name,version}=JSON.parse(await fs.readFile(path.join(ROOT,'package.json'),'utf8'));
 const output=path.join(ROOT,'dist',`${name}-v${version}-edge-submission`,'screenshots'),cache=path.join(ROOT,'.cache/store-screenshots'),fixture=path.join(cache,'extension');
 await fs.mkdir(output,{recursive:true});await fs.mkdir(cache,{recursive:true});
 await fs.cp(path.join(ROOT,'edge'),fixture,{recursive:true,filter:p=>!p.includes(path.sep+'local-helper')});
 const mock=require('./dictionary-browser-fixture.cjs');const workerFile=path.join(fixture,'managed/worker.js');
 await fs.writeFile(workerFile,mock.readOnlyMock(await mock.readFiles(ROOT))+await fs.readFile(workerFile,'utf8'));
 const context=await chromium.launchPersistentContext(path.join(cache,'profile-'+Date.now()),{channel:'msedge',headless:true,viewport:{width:1280,height:800},deviceScaleFactor:1,args:[`--disable-extensions-except=${fixture}`,`--load-extension=${fixture}`]});
 try{
  await context.route(/^https?:\/\//,route=>route.abort());
  let worker=context.serviceWorkers()[0];if(!worker)worker=await context.waitForEvent('serviceworker');const id=worker.url().split('/')[2];
  const ui=await context.newPage();await ui.goto(`chrome-extension://${id}/managed/managed.html`);await ui.waitForFunction(()=>document.querySelector('#version').textContent.length>0);
  const locale=await ui.evaluate(()=>({defaultLocale:chrome.runtime.getManifest().default_locale,name:chrome.i18n.getMessage('extensionName')}));assert.equal(locale.defaultLocale,'zh_CN');assert.equal(locale.name,'网站翻译插件');
  const rpc=(type,args={})=>ui.evaluate(async({type,args})=>{const r=await chrome.runtime.sendMessage({type:'wt:'+type,...args});if(!r.ok)throw Error(r.error);return r.result;},{type,args});
  for(let i=0;i<100;i++){if((await rpc('state')).dictionary.ready)break;await new Promise(r=>setTimeout(r,50));}
  await rpc('dictionary-action',{action:'download-group',group:'github.com'});
  // A synthetic manual entry demonstrates the management controls without secrets or AI.
  await rpc('change',{siteId:'https://github.com',kind:'entry',payload:{sourceText:'Save changes',context:'main/button/text',path:'/settings',sourceLanguage:null,targetLanguage:'zh-Hans',category:'ui',action:'translate',translation:'保存更改',origin:'manual',userSelected:true}});
  await ui.reload();await ui.locator('#tab-websites').click();await ui.locator('.domain-group summary').first().click();await ui.screenshot({path:path.join(output,'01-website-management.png')});
  await ui.locator('#tab-ai').click();await ui.locator('#provider').selectOption('openai');await ui.screenshot({path:path.join(output,'02-api-translation.png')});
  await ui.locator('#tab-sync').click();await ui.screenshot({path:path.join(output,'03-dictionary-repository.png')});
  await ui.goto(`chrome-extension://${id}/managed/privacy.html`);await ui.screenshot({path:path.join(output,'04-privacy-policy.png')});
  const svg=await fs.readFile(path.join(ROOT,'assets/extension-icon.svg'));const png=new Resvg(svg,{fitTo:{mode:'width',value:300}}).render().asPng();await fs.writeFile(path.join(output,'store-logo-300.png'),png);
  for(const name of (await fs.readdir(output)).filter(name=>name.endsWith('.png')&&name.startsWith('0'))){const bytes=await fs.readFile(path.join(output,name));assert.equal(bytes.readUInt32BE(16),1280);assert.equal(bytes.readUInt32BE(20),800);}
  await fs.writeFile(path.join(output,'README.txt'),'1280×800 真实设置界面截图；使用隔离 Edge 和本地演示词库，仓库请求被模拟；没有真实账号、令牌、API Key 或付费请求。\n只将 PNG 用于商店展示，截图不代表真实账号或双设备验收。\n');
  console.log(JSON.stringify({output,screenshots:4,logo:'300x300',locale,realCredentialsUsed:false}));
 }finally{await context.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
