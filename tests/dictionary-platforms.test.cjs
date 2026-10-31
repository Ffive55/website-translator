'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const R=require('../extension/dictionary-repository'),D=require('../extension/dictionary-core'),C=require('../extension/managed-core');
const Discovery=require('../extension/dictionary-discovery'),P=require('../extension/dictionary-publish');
const {getDomain}=require('tldts');
const index={schemaVersion:1,minReaderVersion:1,groups:[]},commit='a'.repeat(40);
const repo={provider:'gitee',owner:'fixture',repo:'dictionary',branch:'main'};
const json=(value,status=200)=>new Response(JSON.stringify(value),{status});
test('仓库选择及两平台令牌按字段随设置同步，独立合并清除操作，其他凭据仍被拒绝',async()=>{
 const device='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
 const row=(field,value,counter=1,deviceId=device)=>({kind:'preference',id:'settings',field,value,counter,deviceId});
 const records=[row('dictionaryRepository',repo),row('dictionaryToken:github','fixture-github'),row('dictionaryToken:gitee','fixture-gitee')];
 const merged=D.mergeSync(records,[row('dictionaryToken:gitee','',2,other)]);
 const restored=await D.unpackSync(await D.packSync(merged));
 assert.equal(restored.find(r=>r.field==='dictionaryToken:gitee').value,'');
 assert.equal(restored.find(r=>r.field==='dictionaryToken:github').value,'fixture-github');
 assert.deepEqual(restored.find(r=>r.field==='dictionaryRepository').value,repo);
 for(const field of ['apiKey','subscriptionToken','dictionaryToken:other'])assert.throws(()=>D.validateSyncRecord(row(field,'secret')));
 assert.throws(()=>D.validateSyncRecord(row('dictionaryToken:gitee','bad\nheader')));
 assert.throws(()=>D.validateSyncRecord(row('dictionaryRepository',{...repo,token:'secret'})));
});
test('显式 GitHub 平台保持旧缓存身份，Gitee 身份独立，拒绝其他平台',()=>{
 const old={owner:'fixture',repo:'dictionary',branch:'main'};
 assert.equal(C.canonical(R.configuration(old)),C.canonical(R.configuration({...old,provider:'github'})));
 assert.notEqual(C.canonical(R.configuration(old)),C.canonical(R.configuration({...old,provider:'gitee'})));
 assert.throws(()=>R.configuration({...old,provider:'unknown'}));
});
test('Gitee 下载固定同一提交，使用 Bearer 头而非 URL 携带令牌',async()=>{
 const calls=[];const client=R.create({repository:repo,token:'fixture-gitee-token',policy:{},getDomain,fetch:async(url,options)=>{
  calls.push({url,options});assert.equal(new URL(url).origin,'https://gitee.com');assert.equal(options.headers.Authorization,'Bearer fixture-gitee-token');assert.ok(!url.includes('fixture-gitee-token'));assert.equal(options.redirect,'error');
  return url.includes('/branches/')?json({name:'main',commit:{sha:commit}}):json(index);
 }});
 assert.equal((await client.readIndex()).commit,commit);assert.ok(calls[1].url.endsWith('/raw/dictionaries/index.json?ref='+commit));
});
test('仓库发现分页并检查非默认词库分支，不按名称筛选、不执行写入、不返回令牌',async()=>{
 const calls=[];const scan=Discovery.create({provider:'gitee',token:'secret-fixture',policy:{},getDomain,fetch:async(url,options)=>{
  calls.push(url);assert.equal(options.method,'GET');const u=new URL(url),p=u.pathname.replace('/api/v5','');
  if(p==='/user')return json({login:'fixture'});
  if(p==='/user/repos')return json(u.searchParams.get('page')==='1'?Array.from({length:100},(_,i)=>({full_name:'fixture/empty'+i,default_branch:null})):[{full_name:'fixture/unrelated-name',default_branch:'master',private:true,permission:{push:true}}]);
  if(/^\/repos\/fixture\/empty\d+$/.test(p))return json({full_name:p.slice('/repos/'.length)});
  if(p.includes('/empty')&&(p.endsWith('/branches')||p.endsWith('/tags')))return json([]);
  if(p.endsWith('/branches') )return json([{name:'master'},{name:'dictionary-data'}]);
  if(p.includes('/branches/'))return json({name:decodeURIComponent(p.split('/').at(-1)),commit:{sha:commit}});
  if(p.includes('/raw/'))return u.searchParams.get('ref')===commit&&calls.at(-2).includes('dictionary-data')?json(index):json({},404);
  throw Error('Unexpected route');
 }});
 let result;for(let i=0;i<120;i++){result=await scan.next();if(result.done)break;}
 assert.equal(result.done,true);assert.equal(result.scanned,101);assert.equal(result.empty,100);assert.equal(result.candidates.length,101);const found=result.candidates.find(c=>c.type==='dictionary');assert.equal(found.repository.branch,'dictionary-data');assert.equal(found.writePermission,true);assert.ok(!JSON.stringify(result).includes('secret-fixture'));
 assert.ok(calls.some(url=>url.includes('page=2')));assert.equal(scan.choice(found.id).repo,'unrelated-name');
});
test('发现无效索引和无权限仓库时不将其作为候选，网络限流显式停止',async()=>{
 const scanner=Discovery.create({provider:'github',token:'fixture',getDomain,policy:{},fetch:async url=>{
  if(url.endsWith('/user'))return json({login:'fixture'});if(url.includes('/user/repos?'))return json([{full_name:'fixture/source',default_branch:'main'}]);
  if(url.includes('/git/ref/'))return json({ref:'refs/heads/main',object:{type:'commit',sha:commit}});
  if(url.includes('/contents/'))return json({schemaVersion:999},200);if(url.includes('/branches?'))return json([{name:'main'}]);throw Error('Unexpected');
 }});
 let result;for(let i=0;i<10;i++){result=await scanner.next();if(result.done)break;}assert.equal(result.candidates.length,0);assert.ok(result.invalid>0);
 const limited=Discovery.create({provider:'gitee',token:'fixture',getDomain,policy:{},fetch:async()=>json({},429)});await assert.rejects(()=>limited.next(),e=>e.kind==='rate-limit');
});
function giteePublisher({loseResponse=false,rejectWrite=false}={}){
 const files={'dictionaries/index.json':'index','dictionaries/example.com/manifest.json':'manifest','dictionaries/example.com/zh-Hans/managed-entries.json':'entries'};
 const draft={parent:commit,group:'example.com',language:'zh-Hans',files};let saved,body,posted=0,history=[];
 const fetch=async(url,options)=>{
  const u=new URL(url),p=u.pathname;assert.ok(!url.includes('token'));
  if(p.includes('/branches/'))return json({commit:{sha:commit}});
  if(p.includes('/contents/'))return json({type:'file',path:decodeURIComponent(p.split('/contents/')[1]),sha:'c'.repeat(40)});
  if(p.endsWith('/commits')&&options.method==='POST'){
   body=JSON.parse(options.body);posted++;assert.ok(saved.transactionId);assert.equal(body.actions.length,3);for(const action of body.actions)assert.equal(action.last_commit_id,commit);
   if(rejectWrite)return json({},422);
   history=[{sha:'b'.repeat(40),commit:{message:body.message}}];if(loseResponse==='http')return json({},503);if(loseResponse)throw Error('lost response');return json({sha:'b'.repeat(40)},201);
  }
  if(p.endsWith('/commits'))return json(u.searchParams.has('path')?[{sha:commit}]:history);
  if(p.includes('/raw/'))return new Response(files[p.split('/raw/')[1]]);
  throw Error('Unexpected');
 };
 const publisher=P.create({repository:repo,token:'fixture',fetch,journal:async value=>{saved=value;}});
 return {publisher,draft,get saved(){return saved;},get posted(){return posted;}};
}
test('Gitee 一次提交三个版本受保护的文件；响应丢失按事务和哈希确认，不重复提交',async()=>{
 for(const mode of [true,'http']){const f=giteePublisher({loseResponse:mode});const result=await f.publisher.publish(f.draft);assert.equal(result.commit,'b'.repeat(40));assert.equal(f.posted,1);assert.equal(await f.publisher.confirm(f.saved),true);assert.equal(f.posted,1);}
});
test('Gitee 明确拒绝并发提交后记录拒绝状态，越界草稿在任何请求前失败',async()=>{
 const f=giteePublisher({rejectWrite:true});await assert.rejects(()=>f.publisher.publish(f.draft),e=>e.kind==='dictionary-conflict');assert.equal(f.saved.rejected,true);
 let calls=0;const bad=P.create({repository:repo,token:'fixture',fetch:async()=>{calls++;throw Error('must not fetch');}});const draft={...f.draft,files:{...f.draft.files}};delete draft.files['dictionaries/index.json'];draft.files['.github/workflows/bad.yml']='bad';await assert.rejects(()=>bad.publish(draft));assert.equal(calls,0);
});

test('Gitee 不存在文件返回 HTTP 200 空数组时按新建处理，不查询不存在文件的版本',async()=>{
 const files={'dictionaries/index.json':'index','dictionaries/example.com/manifest.json':'manifest','dictionaries/example.com/zh-Hans/managed-entries.json':'entries'};
 const newPath='dictionaries/example.com/zh-Hans/managed-entries.json',queries=[];let saved,body;
 const fetch=async(url,options)=>{
  const u=new URL(url),p=u.pathname;
  if(p.includes('/branches/'))return json({commit:{sha:commit}});
  if(p.includes('/contents/')){const path=decodeURIComponent(p.split('/contents/')[1]);assert.equal(u.searchParams.get('ref'),commit);return json(path===newPath?[]:{type:'file',path,sha:'c'.repeat(40)});}
  if(p.endsWith('/commits')&&options.method==='POST'){body=JSON.parse(options.body);return json({sha:'b'.repeat(40)},201);}
  if(p.endsWith('/commits')){if(u.searchParams.has('path')){queries.push(u.searchParams.get('path'));return json(u.searchParams.get('path')===newPath?[]:[{sha:commit}]);}return json([{sha:'b'.repeat(40),commit:{message:body.message}}]);}
  if(p.includes('/raw/'))return new Response(files[decodeURIComponent(p.split('/raw/')[1])]);
  throw Error('Unexpected');
 };
 const publisher=P.create({repository:repo,token:'fixture',fetch,journal:async value=>{saved=value;}});
 assert.equal((await publisher.publish({parent:commit,group:'example.com',language:'zh-Hans',files})).commit,'b'.repeat(40));
 assert.equal(body.actions.find(action=>action.path===newPath).action,'create');assert.equal(body.actions.find(action=>action.path===newPath).last_commit_id,undefined);assert.equal(queries.includes(newPath),false);
 assert.ok(body.actions.filter(action=>action.path!==newPath).every(action=>action.action==='update'&&action.last_commit_id===commit));assert.ok(saved.transactionId);
});
test('Gitee 目录或损坏元数据不会当作已存在文件，也不会发起提交',async()=>{
 for(const metadata of [[{type:'file'}],{type:'dir'},{type:'file',path:'another/path.json',sha:'c'.repeat(40)},{type:'file',path:'dictionaries/index.json',sha:'invalid'}]){
  let writes=0;const f=giteePublisher();const publisher=P.create({repository:repo,token:'fixture',fetch:async(url,options)=>{
   if(options.method!=='GET')writes++;
   return url.includes('/branches/')?json({commit:{sha:commit}}):json(metadata);
  }});
  await assert.rejects(()=>publisher.publish(f.draft),/不是有效文件/);assert.equal(writes,0);
 }
});
test('Gitee 确认文件存在但提交历史为空时继续停止，不省略版本保护',async()=>{
 const f=giteePublisher();let writes=0;const publisher=P.create({repository:repo,token:'fixture',fetch:async(url,options)=>{
  if(options.method!=='GET')writes++;
  const u=new URL(url);if(u.pathname.includes('/branches/'))return json({commit:{sha:commit}});
  if(u.pathname.includes('/contents/'))return json({type:'file',path:decodeURIComponent(u.pathname.split('/contents/')[1]),sha:'c'.repeat(40)});
  return json([]);
 }});
 await assert.rejects(()=>publisher.publish(f.draft),/无法确定文件版本/);assert.equal(writes,0);
});
