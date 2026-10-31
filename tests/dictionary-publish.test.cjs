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
 await assert.rejects(()=>publisher.publish(data),/本地已改变/);assert.equal(branchWrites,0);assert.ok(journal.commit);assert.equal(journal.rejected,true);
});

async function differing(){
 const base=row('基础'),local=row('本地'),remote=row('仓库'),key=D.entryIdentity(base);
 const remoteOnly={...row('仓库独有'),entry:{...row('仓库独有').entry,sourceText:'Remote only'}};
 const localOnly={...row('本地独有'),entry:{...row('本地独有').entry,sourceText:'Local only'}};
 const manifest={schemaVersion:1,minReaderVersion:1,group,languages:{[lang]:{origins:[origin],files:[],revision:'d'.repeat(64)},fr:{origins:[origin],files:[],revision:'e'.repeat(64)}}};
 // Build valid unaffected language metadata; the payload is not downloaded by prepare.
 const file={id:'other',path:`dictionaries/${group}/fr/other.json`,sha256:'f'.repeat(64),bytes:10,kind:'entries',origins:[origin],requires:[]};
 manifest.languages.fr={origins:[origin],files:[file],revision:await D.digest({origins:[origin],files:[file]})};
 const client={readIndex:async()=>({commit:'b'.repeat(40),index:{schemaVersion:1,minReaderVersion:1,groups:[]}}),manifest:async()=>manifest,downloadGroup:async()=>({files:[{pack:{records:[remote,remoteOnly]}}]})};
 return {client,manifest,key,remoteOnly,localOnly,state:{commit:'a'.repeat(40),contentRevision:'c'.repeat(64),baseline:D.recordsMap([base]),local:D.recordsMap([local,localOnly]),files:[],revision:7}};
}
test('已知基线上传冲突经确认采用本地，同时保留双方非冲突新增和其他语言',async()=>{
 const f=await differing();await assert.rejects(()=>P.prepare(f.client,repository,f.state,[origin],lang,getDomain,{}),/不同修改/);
 const result=await P.prepare(f.client,repository,f.state,[origin],lang,getDomain,{}, {interactive:true});
 assert.equal(result.confirmation.full,false);assert.equal(result.confirmation.conflicts,1);
 const pack=JSON.parse(result.files[`dictionaries/${group}/${lang}/managed-entries.json`]),map=D.recordsMap(pack.records);
 assert.equal(map[f.key].entry.translation,'本地');assert.ok(map[D.entryIdentity(f.remoteOnly)]);assert.ok(map[D.entryIdentity(f.localOnly)]);
 assert.deepEqual(JSON.parse(result.files[`dictionaries/${group}/manifest.json`]).languages.fr,f.manifest.languages.fr);
});
test('缺少基线上传须整份确认，仓库独有词条删除，本地新增保留',async()=>{
 const f=await differing();delete f.state.contentRevision;
 const result=await P.prepare(f.client,repository,f.state,[origin],lang,getDomain,{}, {interactive:true});
 assert.equal(result.confirmation.full,true);assert.match(result.confirmation.reason,/共同基线/);
 const map=D.recordsMap(JSON.parse(result.files[`dictionaries/${group}/${lang}/managed-entries.json`]).records);
 assert.equal(map[D.entryIdentity(f.remoteOnly)],null);assert.equal(map[f.key].entry.translation,'本地');assert.ok(map[D.entryIdentity(f.localOnly)]);
});
test('正常不同词条修改直接合并，网络错误或损坏内容不变成覆盖确认',async()=>{
 const f=await differing();delete f.state.local[f.key];
 const result=await P.prepare(f.client,repository,f.state,[origin],lang,getDomain,{}, {interactive:true});assert.equal(result.confirmation,null);
 f.client.readIndex=async()=>{throw Object.assign(Error('无权限'),{status:403});};
 await assert.rejects(()=>P.prepare(f.client,repository,f.state,[origin],lang,getDomain,{}, {interactive:true}),/无权限/);
});
test('整份上传包含本机静态适配器并重算引用，其他分组索引保留',async()=>{
 const fs=require('node:fs'),path=require('node:path'),root=path.resolve(__dirname,'..');
 const manifest=JSON.parse(fs.readFileSync(path.join(root,'dictionaries/tailscale.com/manifest.json'),'utf8'));
 const description=manifest.languages[lang].files[0],pack=JSON.parse(fs.readFileSync(path.join(root,description.path),'utf8'));
 const index=JSON.parse(fs.readFileSync(path.join(root,'dictionaries/index.json'),'utf8')),policy=JSON.parse(fs.readFileSync(path.join(root,'extension/dictionary-policy.json'),'utf8'));
 const client={readIndex:async()=>({commit:'a'.repeat(40),index}),manifest:async()=>manifest,downloadGroup:async()=>({files:[{pack}]})};
 const state={contentRevision:'b'.repeat(64),baseline:{},local:{},files:[{pack,description}],revision:1};
 const result=await P.prepare(client,repository,state,pack.origins,lang,getDomain,policy,{interactive:true});
 assert.equal(result.confirmation.full,true);assert.equal(Object.keys(result.files).length,4);assert.deepEqual(JSON.parse(result.files[description.path]),pack);
 const after=JSON.parse(result.files['dictionaries/tailscale.com/manifest.json']);
 const copied=after.languages[lang].files.find(file=>file.id===description.id);assert.equal(copied.sha256,await D.digest(result.files[description.path]));
 await D.verifyFile(result.files[description.path],copied,{getDomain,policy});
 assert.deepEqual(JSON.parse(result.files['dictionaries/index.json']).groups.filter(item=>item.group!=='tailscale.com'),index.groups.filter(item=>item.group!=='tailscale.com'));
});
