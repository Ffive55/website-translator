'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {randomUUID,createHash}=require('node:crypto');
const {OAuth,openCallback}=require('../native/oauth.cjs');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const base=path.resolve(__dirname,'../.cache/oauth-tests');
test('订阅不再限制20条，接受动态批次并拒绝超过200K预算的请求',async()=>{
  let sent;const oauth=new OAuth('unused',{fetch:async(_url,init)=>{sent=JSON.parse(init.body);return new Response('data: {"type":"response.output_text.delta","delta":"[]"}\n\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n');}});oauth.withSession=fn=>fn('synthetic-token',new AbortController().signal);
  const inputs=Array.from({length:100},(_,i)=>({id:'t'+i,sourceText:'Label '+i,context:'nav/button/text',path:'/'}));await oauth.translate('fixture',{inputs,targetLanguage:'zh-Hans',glossary:[]});assert.equal(JSON.parse(sent.input[0].content).inputs.length,100);
  await assert.rejects(()=>oauth.translate('fixture',{inputs:inputs.map(i=>({...i,sourceText:'长'.repeat(4000)})),targetLanguage:'zh-Hans',glossary:[]}),/请求无效|预算/);
});
test('订阅思考强度实际写入 Responses 请求；默认不发送，非法值拒绝',async()=>{
  const bodies=[];const oauth=new OAuth('unused',{fetch:async(_url,init)=>{bodies.push(JSON.parse(init.body));return new Response('data: {"type":"response.output_text.delta","delta":"[]"}\n\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n');}});
  oauth.withSession=fn=>fn('synthetic-token',new AbortController().signal);
  await oauth.translate('fixture',{inputs:[]},'简洁译文','high');await oauth.translate('fixture',{inputs:[]},'简洁译文');
  assert.deepEqual(bodies[0].reasoning,{effort:'high'});assert.match(bodies[0].instructions,/简洁译文/);assert.equal('reasoning' in bodies[1],false);
  await assert.rejects(()=>oauth.translate('fixture',{inputs:[]},'','invented'),/思考强度/);
});
async function fixture(t,overrides={}) {
  const dir=path.join(base,randomUUID());await fs.mkdir(dir,{recursive:true});
  t.after(async()=>{assert.ok(dir.startsWith(base+path.sep));await fs.rm(dir,{recursive:true,force:true});});
  const {generateKeyPair,SignJWT}=await import('jose');
  const keys=await generateKeyPair('RS256');
  let authorization,exchanges=0,callbackURL;
  const options={protect:async v=>v,unprotect:async v=>v,jwks:keys.publicKey,callbackTimeout:2000,...overrides};
  options.fetch=overrides.fetch || (async(url,init)=>{
    assert.equal(url,'https://auth.openai.com/api/accounts/oauth/token');exchanges++;
    const form=init.body;assert.equal(form.get('client_id'),'oaiapp_test');assert.equal(form.get('resource'),'https://api.openai.com/v1');
    assert.equal(form.get('redirect_uri'),authorization.searchParams.get('redirect_uri'));
    assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'),authorization.searchParams.get('code_challenge'));
    const claims={nonce:authorization.searchParams.get('nonce'),...(overrides.claims || {})};
    let jwt=new SignJWT(claims).setProtectedHeader({alg:'RS256'}).setIssuer(overrides.issuer || 'https://auth.openai.com').setAudience(overrides.audience || 'oaiapp_test').setSubject(overrides.subject || 'subject-A').setIssuedAt().setExpirationTime(overrides.expiry || '5m');
    const id_token=await jwt.sign(overrides.signKey || keys.privateKey);
    return new Response(JSON.stringify({access_token:'fixture-access',refresh_token:'fixture-refresh',token_type:'Bearer',expires_in:3600,id_token,scope:overrides.scope || 'chatgpt.tokens.use.direct offline_access'}));
  });
  const oauth=new OAuth(dir,options);
  const notify=async({authorizeUrl})=>{
    authorization=new URL(authorizeUrl);callbackURL=new URL(authorization.searchParams.get('redirect_uri'));
    callbackURL.searchParams.set('state',authorization.searchParams.get('state'));callbackURL.searchParams.set('code','fixture-code');callbackURL.searchParams.set('client_id','oaiapp_test');
    const r=await fetch(callbackURL);assert.equal(r.status,200);
  };
  return {dir,oauth,notify,exchanges:()=>exchanges,url:()=>authorization,callback:()=>callbackURL};
}
test('真实 loopback 回调、PKCE 与签名校验贯通；重建实例保留身份和注册',async t=>{
  const f=await fixture(t);assert.equal((await f.oauth.login(f.notify)).signedIn,true);assert.equal(f.exchanges(),1);
  const record=await f.oauth.load();assert.equal(record.subject,'subject-A');assert.equal(record.client_id,'oaiapp_test');assert.ok(record.sessionEpoch);
  assert.equal(f.url().searchParams.get('client_id'),'dynamic_agent_client');assert.equal(f.url().searchParams.get('agent_name_hint'),'website-translator');
  assert.equal((await f.oauth.login(f.notify)).signedIn,true);assert.equal(f.url().searchParams.get('client_id'),'oaiapp_test');assert.equal(f.url().searchParams.has('agent_name_hint'),false);
  assert.equal((await f.oauth.load()).hostId,record.hostId);
  await assert.rejects(()=>fetch(f.callback()),/fetch failed/);
});
test('OIDC 错误 issuer、audience、nonce、签名、过期和身份替换均保留旧凭据',async t=>{
  const {generateKeyPair}=await import('jose'),other=await generateKeyPair('RS256');
  for(const opts of [{issuer:'https://evil.example'},{audience:'other'},{claims:{nonce:'wrong'}},{signKey:other.privateKey},{expiry:-20},{subject:'subject-B'},{scope:'openid profile'}]){
    const f=await fixture(t,opts),old={hostId:'host-old',client_id:'oaiapp_test',subject:'subject-A',access_token:'old-token',refresh_token:'old-refresh'};await f.oauth.save(old);
    await assert.rejects(()=>f.oauth.login(f.notify));assert.deepEqual(await f.oauth.load(),old);assert.equal((await fs.readdir(f.dir)).includes('session.lock'),false);
  }
});
test('错误 state、重复参数和重放不交换 code；拒绝授权保留已有账号',async t=>{
  const controller=new AbortController(),callback=await openCallback('valid',controller.signal,2000);t.after(()=>callback.close());
  const bad=new URL(callback.redirect);bad.searchParams.set('state','wrong');assert.equal((await fetch(bad)).status,400);
  bad.searchParams.set('state','valid');bad.searchParams.append('state','valid');assert.equal((await fetch(bad)).status,400);
  const good=new URL(callback.redirect);good.searchParams.set('state','valid');good.searchParams.set('error','access_denied');assert.equal((await fetch(good)).status,200);assert.equal((await callback.result).get('error'),'access_denied');assert.equal((await fetch(good)).status,400);
  const f=await fixture(t);await assert.rejects(()=>f.oauth.login(async({authorizeUrl})=>{const u=new URL(authorizeUrl),cb=new URL(u.searchParams.get('redirect_uri'));cb.searchParams.set('state',u.searchParams.get('state'));cb.searchParams.set('error','access_denied');await fetch(cb);}),/未获授权/);assert.equal(f.exchanges(),0);
});
test('取消、超时和打开授权页失败释放 listener 与文件锁',async t=>{
  for(const mode of ['abort','timeout','notify']){
    const c=new AbortController(),f=await fixture(t,{signal:c.signal,callbackTimeout:50});let url;
    await assert.rejects(()=>f.oauth.login(async({authorizeUrl})=>{url=new URL(authorizeUrl).searchParams.get('redirect_uri');if(mode==='abort')c.abort();if(mode==='notify')throw new Error('open failed');}),mode==='abort'?/取消/:mode==='timeout'?/超时/:/open failed/);
    assert.equal((await fs.readdir(f.dir)).includes('session.lock'),false);await assert.rejects(()=>fetch(url));assert.equal((await f.oauth.status()).signedIn,false);
  }
});
test('新注册交换失败保留 issued client，不激活身份；下一次不重新注册',async t=>{
  const f=await fixture(t,{fetch:async()=>new Response(JSON.stringify({error:'invalid_grant'}),{status:400})});
  await assert.rejects(()=>f.oauth.login(f.notify),/授权交换失败/);const saved=await f.oauth.load();assert.equal(saved.pendingClient,'oaiapp_test');assert.equal(saved.access_token,undefined);
  await assert.rejects(()=>f.oauth.login(f.notify));assert.equal(f.url().searchParams.get('client_id'),'oaiapp_test');
});
test('续期 invalid_grant 清除失效令牌并保留注册；网络错误保留可重试会话',async t=>{
  for(const status of [400,503]){
    const f=await fixture(t,{fetch:async()=>new Response(JSON.stringify({error:status===400?'invalid_grant':'unavailable'}),{status})});
    await f.oauth.save({client_id:'oaiapp_test',subject:'subject-A',access_token:'old',refresh_token:'refresh',expiresAt:0,scope:'chatgpt.tokens.use.direct'});
    await assert.rejects(()=>f.oauth.access(),/授权交换失败/);const saved=await f.oauth.load();assert.equal(saved.client_id,'oaiapp_test');assert.equal(!!saved.access_token,status===503);assert.equal((await f.oauth.status()).signedIn,status===503);
  }
});
test('跨实例退出取消在途请求，撤销失败仍清除本机令牌并报告未确认',async t=>{
  const f=await fixture(t);await f.oauth.login(f.notify);let started=false,cancelled=false;
  f.oauth.fetch=async(_url,{signal})=>{started=true;return new Promise((_,reject)=>signal.addEventListener('abort',()=>{cancelled=true;reject(signal.reason);},{once:true}));};
  const request=f.oauth.models();const rejected=assert.rejects(request,/退出|改变/);
  while(!started)await pause(5);
  const second=new OAuth(f.dir,{protect:async v=>v,unprotect:async v=>v,fetch:async()=>{throw new Error('offline');}});
  const result=await second.logout();assert.equal(result.revoked,false);await rejected;assert.equal(cancelled,true);
  assert.equal((await second.load()).access_token,undefined);assert.equal((await second.status()).signedIn,false);
});
test('会话锁不允许两个实例同时轮换 token',async t=>{
  const f=await fixture(t);let release;const held=f.oauth.lock(()=>new Promise(r=>release=r));while(!release)await pause(5);
  const second=new OAuth(f.dir);await assert.rejects(()=>second.lock(()=>assert.fail('must not enter')),/其他窗口/);release();await held;
});
test('授权凭据写入期间取消会回滚，不留下已激活的迟到账号',async t=>{
  const controller=new AbortController();
  const f=await fixture(t,{signal:controller.signal,protect:async value=>{if(JSON.parse(value).access_token==='fixture-access')controller.abort();return value;}});
  await assert.rejects(()=>f.oauth.login(f.notify));assert.equal((await f.oauth.load()).access_token,undefined);assert.equal((await f.oauth.status()).signedIn,false);
  assert.equal((await fs.readdir(f.dir)).some(name=>name.endsWith('.tmp') || name==='session.lock'),false);
});
test('续期响应撤回订阅 scope 后不再保留可使用的本机令牌',async t=>{
  const f=await fixture(t,{fetch:async()=>new Response(JSON.stringify({token_type:'Bearer',access_token:'new',refresh_token:'rotated',expires_in:3600,scope:'openid profile'}))});
  await f.oauth.save({client_id:'oaiapp_test',subject:'subject-A',access_token:'old',refresh_token:'refresh',expiresAt:0,scope:'chatgpt.tokens.use.direct'});
  await assert.rejects(()=>f.oauth.access(),/授权已撤回/);assert.equal((await f.oauth.load()).access_token,undefined);assert.equal((await f.oauth.status()).signedIn,false);
});


test('订阅翻译使用可配置分钟数，响应流超时可重试，会话取消不重试',async()=>{
  for(const mode of ['timeout','cancel','success']){
    const oauth=new OAuth('unused-fixture-directory'),controller=new AbortController(),durations=[];
    oauth.grant=async()=>({access_token:'synthetic',sessionEpoch:'fixture'});oauth.session=async()=>({epoch:'fixture',signedOut:false});
    oauth.signalFor=ms=>{durations.push(ms);return controller.signal;};
    oauth.fetch=async()=>({ok:true,body:(async function*(){
      yield Buffer.from('data: {"type":"response.output_text.delta","delta":"[]"}\n\n');
      if(mode==='timeout')throw new DOMException('The operation was aborted due to timeout','TimeoutError');
      if(mode==='cancel'){controller.abort(new Error('fixture cancel'));throw controller.signal.reason;}
      yield Buffer.from('data: {"type":"response.completed","response":{"status":"completed"}}\n\n');
    })()});
    const promise=oauth.translate('fixture',{targetLanguage:'zh-Hans',inputs:[],glossary:[]},undefined,'auto',15);
    if(mode==='success')assert.equal(await promise,'[]');
    else await assert.rejects(promise,error=>error.kind===(mode==='timeout'?'retry':'cancel') && (mode!=='timeout' || /15 分钟/.test(error.message)));
    assert.deepEqual(durations,[900000]);
    await assert.rejects(()=>oauth.translate('fixture',{inputs:[]},undefined,'auto',61),/1–60/);
  }
});


test('订阅接受自定义输入预算并在请求前拒绝超预算数据',async()=>{
  const oauth=new OAuth('unused-fixture');let calls=0;oauth.withSession=async()=>{calls++;return '[]';};
  const inputs=Array.from({length:10},(_,i)=>({id:'t'+i,sourceText:'Description '.repeat(200),context:'main/p/text',path:'/'})),payload={targetLanguage:'zh-Hans',inputs,glossary:[]};
  await assert.rejects(()=>oauth.translate('fixture',payload,undefined,'auto',3,5),/5K/);assert.equal(calls,0);
  assert.equal(await oauth.translate('fixture',payload,undefined,'auto',3,50),'[]');assert.equal(calls,1);
});
