'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const I=require('../extension/dictionary-initialize'),Discovery=require('../extension/dictionary-discovery'),D=require('../extension/dictionary-core');
const {seed}=require('../script/build-repository-seed.cjs'),{getDomain}=require('tldts');
const policy=require('../extension/dictionary-policy.json'),json=(v,status=200)=>new Response(JSON.stringify(v),{status});
const hash=raw=>createHash('sha1').update('blob '+Buffer.byteLength(raw)+'\0').update(raw).digest('hex');
let prepared;const bundle=()=>prepared ||= I.prepare(seed(),{getDomain,policy});
function fixture(provider='github'){
 const repository={...(provider==='gitee'?{provider}:{}),owner:'fixture',repo:'empty',branch:'main'};
 const f={repository,files:{},writes:[],saved:null,lose:false,deny:false,branches:[],head:null};
 f.fetch=async(url,options={})=>{
  assert.equal(options.headers.Authorization,'Bearer fixture-token');assert.ok(!url.includes('fixture-token'));
  const p=new URL(url).pathname.replace('/api/v5','').replace('/repos/fixture/empty',''),method=options.method||'GET';
  if(p==='')return json({full_name:'fixture/empty',permissions:{push:!f.deny}});
  if(p==='/branches')return json(f.head?[{name:'main',commit:{sha:f.head}},...f.branches]:f.branches);
  if(p==='/tags')return json([]);
  if(p.startsWith('/git/commits/'))return json({tree:{sha:f.head}});
  if(p.startsWith('/git/trees/'))return json({truncated:false,tree:Object.entries(f.files).map(([path,raw])=>({path,mode:'100644',type:'blob',sha:hash(raw)}))});
  if(p.startsWith('/contents/')&&method!=='GET'){
   const name=decodeURIComponent(p.slice(10)),body=JSON.parse(options.body);assert.ok(f.saved);assert.equal(body.sha,undefined);assert.equal(method,provider==='github'?'PUT':'POST');
   f.writes.push(name);if(Object.hasOwn(f.files,name))return json({},422);
   f.files[name]=Buffer.from(body.content,'base64').toString('utf8');f.head=f.writes.length.toString(16).padStart(40,'0');
   if(f.lose){f.lose=false;throw Error('lost response');}return json({commit:{sha:f.head}},201);
  }
  throw Error('Unexpected '+method+' '+p);
 };
 f.writer=()=>I.create({repository,token:'fixture-token',fetch:f.fetch,journal:async saved=>{f.saved=structuredClone(saved);}});
 return f;
}
test('初始化包仅含 github.com 主站，来源和 GPL 完整，README 不枚举网站',async()=>{
 const s=await bundle(),index=JSON.parse(s.files['dictionaries/index.json']);assert.deepEqual(index.groups.map(g=>g.group),['github.com']);
 const manifest=JSON.parse(s.files['dictionaries/github.com/manifest.json']);assert.deepEqual(manifest.languages['zh-Hans'].origins,['https://github.com']);
 assert.equal(manifest.languages['zh-Hans'].files.length,1);assert.ok(s.files.LICENSE.includes('GNU GENERAL PUBLIC LICENSE'));assert.ok(s.files['source.json'].includes('fa48c902'));
 assert.ok(!s.files['README.md'].includes('github.com 主站'));assert.ok(s.files['README.md'].includes('仓库测试'));
 const bad=seed();bad.files['extra.json']='{}';await assert.rejects(()=>I.prepare(bad,{getDomain,policy}));
});
for(const provider of ['github','gitee'])test(provider+' 空仓库逐步初始化，索引最后上传，可重建 writer 恢复且不重复提交',async()=>{
 const f=fixture(provider),s=await bundle();let result;
 for(let n=0;n<12;n++){result=await f.writer().step(s,f.saved);if(result.done)break;}
 assert.equal(result.done,true);assert.equal(f.writes.length,8);assert.equal(f.writes.at(-1),'dictionaries/index.json');
 for(const [p,raw] of Object.entries(s.files))assert.equal(f.files[p],raw);
 await f.writer().step(s,f.saved);assert.equal(f.writes.length,8);
 assert.ok(!JSON.stringify(f.saved).includes('fixture-token'));
});
test('首文件响应丢失后只读核查已提交内容，继续剩余文件',async()=>{
 const f=fixture('gitee'),s=await bundle();f.lose=true;await assert.rejects(()=>f.writer().step(s,null),/初始化未完成/);
 assert.equal(f.saved.pendingPath,'dictionary-initialization.json');assert.equal(f.writes.length,1);
 await f.writer().step(s,f.saved);assert.equal(f.writes.length,2);assert.equal(f.writes[1],'README.md');
});
test('已有内容、只读权限、外部新增或修改、种子变化均停止且不覆盖',async()=>{
 const s=await bundle();
 const nonempty=fixture();nonempty.head='a'.repeat(40);nonempty.files['README.md']='existing';await assert.rejects(()=>nonempty.writer().step(s,null),/不是空仓库/);assert.equal(nonempty.writes.length,0);
 const denied=fixture();denied.deny=true;await assert.rejects(()=>denied.writer().step(s,null),/写入权限/);assert.equal(denied.writes.length,0);
 for(const tamper of ['foreign','marker']){const f=fixture();await f.writer().step(s,null);if(tamper==='foreign')f.files['user.txt']='keep';else f.files['dictionary-initialization.json']='changed';await assert.rejects(()=>f.writer().step(s,f.saved),/内容已变化/);assert.equal(f.writes.length,1);}
 const f=fixture();await f.writer().step(s,null);await assert.rejects(()=>f.writer().step({...s,digest:'changed'},f.saved),/来源已变化/);assert.equal(f.writes.length,1);
});
test('空仓库检测不把 404、403 或仅有标签的仓库当成空仓库',async()=>{
 const f=fixture();assert.equal(await I.empty(f.repository,'fixture-token',f.fetch),true);
 for(const status of [403,404])await assert.rejects(()=>I.empty(f.repository,'fixture-token',async()=>json({},status)));
 assert.equal(await I.empty(f.repository,'fixture-token',async url=>url.includes('/tags?')?json([{name:'v1'}]):url.includes('/branches?')?json([]):json({full_name:'fixture/empty'})),false);
});
test('带默认分支名的真正空仓库也是候选，测试全程只读；只读空仓库不提供初始化',async()=>{
 for(const writable of [true,false]){
  const scan=Discovery.create({provider:'github',token:'fixture-token',getDomain,policy,fetch:async(url,options)=>{
   assert.equal(options.method,'GET');const p=new URL(url).pathname;
   if(p==='/user')return json({login:'fixture'});
   if(p==='/user/repos')return json([{full_name:'fixture/empty',default_branch:'main',permissions:{push:writable}}]);
   if(p.endsWith('/git/ref/heads/main'))return json({},409);
   if(p.endsWith('/branches')||p.endsWith('/tags'))return json([]);
   if(p==='/repos/fixture/empty')return json({full_name:'fixture/empty'});
   throw Error('Unexpected '+p);
  }});
  let r;for(let n=0;n<10;n++){r=await scan.next();if(r.done)break;}
  assert.equal(r.done,true);assert.equal(r.empty,1);assert.equal(r.candidates.length,writable?1:0);if(writable)assert.equal(r.candidates[0].type,'empty');
 }
});
