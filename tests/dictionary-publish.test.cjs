'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const P=require('../extension/dictionary-publish'),D=require('../extension/dictionary-core'),{getDomain}=require('tldts');
const repository={owner:'Ffive55',repo:'website-translator',branch:'main'},origin='https://example.com',group='example.com',lang='zh-Hans';
const row=translation=>({site:origin,entry:{sourceText:'Save',context:'main/button/text',path:'/',sourceLanguage:null,targetLanguage:lang,category:'ui',action:'translate',translation,origin:'manual'}});
async function draft(){
 const client={readIndex:async()=>({commit:'a'.repeat(40),index:{schemaVersion:1,minReaderVersion:1,groups:[]}}),manifest:async()=>null};
 return P.prepare(client,repository,{baseline:{},local:D.recordsMap([row('保存')]),revision:3},[origin],lang,getDomain,{});
}
test('上传生成词库和两个清单，凭据与本机历史不进入预览',async()=>{
 const result=await draft();assert.equal(result.changes.length,1);assert.equal(Object.keys(result.files).length,3);
 const pack=JSON.parse(result.files['dictionaries/example.com/zh-Hans/managed-entries.json']);D.validatePackage(pack,{getDomain});
 const manifest=JSON.parse(result.files['dictionaries/example.com/manifest.json']);await D.validateManifest(manifest,getDomain);D.validateIndex(JSON.parse(result.files['dictionaries/index.json']));
});
test('GitHub 并发更新拒绝发布，不创建树、不强制覆盖',async()=>{
 const calls=[];const publisher=P.create({repository,token:'fixture-only',fetch:async(url,options)=>{calls.push(options);return new Response(JSON.stringify({object:{sha:'b'.repeat(40)}}));}});
 const data=await draft();await assert.rejects(()=>publisher.publish(data),/远端已更新/);assert.equal(calls.length,1);assert.equal(calls[0].method,'GET');
});
test('发布持久化待确认提交，响应丢失后核查而不是重复发布',async()=>{
 const data=await draft(),calls=[],commit='c'.repeat(40);let head=data.parent,journal;
 const publisher=P.create({repository,token:'fixture-only',journal:async value=>{journal=value;},fetch:async(url,options)=>{
   const pathname=new URL(url).pathname;calls.push({pathname,options});
   if(options.method==='PATCH'){assert.equal(journal.commit,commit);assert.equal(JSON.parse(options.body).force,false);head=commit;throw Error('response lost');}
   if(pathname.includes('/git/refs/'))return new Response(JSON.stringify({object:{sha:head}}));
   if(options.method==='POST')return new Response(JSON.stringify({sha:pathname.endsWith('/trees')?'d'.repeat(40):commit}));
   return new Response(JSON.stringify({tree:{sha:'e'.repeat(40)}}));
 }});
 assert.equal((await publisher.publish(data)).commit,commit);assert.equal(calls.filter(c=>c.options.method==='PATCH').length,1);
});
test('上传路径越界在任何网络请求前被拒绝',async()=>{
 const data=await draft();delete data.files['dictionaries/index.json'];data.files['.github/workflows/run.yml']='bad';let calls=0;
 const publisher=P.create({repository,token:'fixture-only',fetch:async()=>{calls++;throw Error('must not request');}});
 await assert.rejects(()=>publisher.publish(data));assert.equal(calls,0);
});
test('准备 Git 对象期间本地状态改变，在更新分支前再次拒绝提交',async()=>{
 const data=await draft();let branchWrites=0,journal;
 const publisher=P.create({repository,token:'fixture',journal:async value=>{journal=value;},beforeCommit:async()=>{throw Error('本地已改变');},fetch:async(url,options)=>{
  if(options.method==='PATCH')branchWrites++;
  if(url.includes('/git/refs/'))return new Response(JSON.stringify({object:{sha:data.parent}}));
  if(options.method==='POST')return new Response(JSON.stringify({sha:'d'.repeat(40)}));
  return new Response(JSON.stringify({tree:{sha:'e'.repeat(40)}}));
 }});
 await assert.rejects(()=>publisher.publish(data),/本地已改变/);assert.equal(branchWrites,0);assert.ok(journal.commit);
});
