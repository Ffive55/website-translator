'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const http = require('node:http');
const { randomBytes, randomUUID, createHash } = require('node:crypto');
const C = require('../extension/managed-core');
const B = require('../extension/managed-batching');
const AUTH = 'https://auth.openai.com', RESOURCE = 'https://api.openai.com/v1';
const random = () => randomBytes(32).toString('base64url');
function dpapi(mode, value) {
  return new Promise((resolve,reject)=>{
    const shell=process.platform==='win32'?path.join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'):'pwsh';
    const child=spawn(shell,['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'secure-store.ps1'),'-Mode',mode],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    const timeout=setTimeout(()=>child.kill(),15000);
    let out='';child.stdout.setEncoding('utf8');child.stdout.on('data',b=>out+=b);child.stderr.resume();child.on('error',()=>{clearTimeout(timeout);reject(new Error('无法启动 Windows 凭据保护程序'));});child.on('close',code=>{clearTimeout(timeout);code===0?resolve(out):reject(new Error('Windows 本机凭据加密/解密失败'));});child.stdin.on('error',()=>{});child.stdin.end(value);
  });
}
class OAuth {
  constructor(directory, options = {}) {
    this.directory=directory;this.file=path.join(directory,'chatgpt.dat');
    this.sessionFile=path.join(directory,'session-state.json');
    this.fetch=options.fetch || ((...args)=>fetch(...args));
    this.protect=options.protect || (value=>dpapi('Protect',value));
    this.unprotect=options.unprotect || (value=>dpapi('Unprotect',value));
    this.jwks=options.jwks;this.signal=options.signal;
    this.callbackTimeout=options.callbackTimeout || 180000;
  }
  signalFor(ms) { return this.signal ? AbortSignal.any([this.signal,AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms); }
  async load() { try { return JSON.parse(await this.unprotect(await fs.readFile(this.file,'utf8'))); } catch(e) { if(e.code==='ENOENT')return {}; throw e; } }
  async atomic(file, value) {
    const temp=path.join(this.directory,`${randomUUID()}.tmp`);
    try { const handle=await fs.open(temp,'wx',0o600);try{await handle.writeFile(value);await handle.sync();}finally{await handle.close();}await fs.rename(temp,file); }
    finally { await fs.unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;}); }
  }
  async save(record) {
    await this.atomic(this.file,await this.protect(JSON.stringify(record)));
  }
  async session() { try{return JSON.parse(await fs.readFile(this.sessionFile,'utf8'));}catch(e){if(e.code==='ENOENT')return {};throw e;} }
  async markSession(epoch,signedOut) { await this.atomic(this.sessionFile,JSON.stringify({epoch,signedOut})); }
  async lock(fn,waitMs=0) {
    const file=path.join(this.directory,'session.lock');let handle;
    const deadline=Date.now()+waitMs;
    while(!handle){try { handle=await fs.open(file,'wx',0o600); } catch(e) { if(e.code!=='EEXIST')throw new Error('无法写入本机订阅会话目录');if(Date.now()>=deadline)throw B.error('订阅会话正在其他窗口使用；若异常退出，请关闭连接程序后移除本机 session.lock','retry',{retryAfterMs:1000});this.signal?.throwIfAborted();await new Promise(resolve=>setTimeout(resolve,100));}}
    try { this.signal?.throwIfAborted();return await fn(); } finally { await handle.close();await fs.unlink(file); }
  }
  async token(form) {
    const r=await this.fetch(`${AUTH}/api/accounts/oauth/token`,{method:'POST',redirect:'error',signal:this.signalFor(30000),headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({...form,resource:RESOURCE})});
    if(!r.ok){const error=new Error(`授权交换失败（HTTP ${r.status}），请重新登录`);const body=await r.json().catch(()=>({}));error.invalidGrant=body.error==='invalid_grant';throw error;}
    const t=await r.json();
    C.assert(typeof t.access_token==='string' && t.access_token.length>0 && Number.isFinite(t.expires_in) && t.expires_in>0 && t.token_type?.toLowerCase()==='bearer','授权响应无效');
    C.assert(t.refresh_token===undefined || (typeof t.refresh_token==='string' && t.refresh_token.length>0),'续期令牌无效');return t;
  }
  async login(notify) {
    return this.lock(async()=>{
      const old=await this.load();
      const host=old.hostId || `urn:uuid:${randomUUID()}`;
      // Persist stable host and registration separately from pending identity.
      await this.save({...old,hostId:host});
      const state=random(),nonce=random(),verifier=random();
      const callback=await openCallback(state,this.signal,this.callbackTimeout);
      const redirect=callback.redirect;
      const url=new URL(`${AUTH}/api/accounts/authorize`);
      const selectedClient=old.client_id || old.pendingClient;
      const args={client_id:selectedClient || 'dynamic_agent_client',ext_agent_host_id:host,response_type:'code',redirect_uri:redirect,scope:'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',resource:RESOURCE,state,nonce,code_challenge_method:'S256',code_challenge:createHash('sha256').update(verifier).digest('base64url')};
      if(!selectedClient)args.agent_name_hint='website-translator';
      // Retained ID-token hints stay local; omit optional hints from the browser-extension transport.
      Object.entries(args).forEach(([k,v])=>url.searchParams.set(k,v));
      try {
        await notify({authorizeUrl:url.href});
        const params=await callback.result;C.assert(!params.get('error'),'登录未获授权');
        const client=params.get('client_id') || selectedClient;
        C.assert(typeof client==='string' && client.length>0 && client.length<=512 && client!=='dynamic_agent_client' && (!selectedClient || selectedClient===client),'注册 client_id 无效');
        C.assert(params.get('code'),'授权缺少 code');
        // Keep an issued registration after a failed code exchange, without activating unverified identity.
        if(!old.client_id)await this.save({...old,hostId:host,pendingClient:client});
        const tokens=await this.token({grant_type:'authorization_code',client_id:client,code:params.get('code'),code_verifier:verifier,redirect_uri:redirect});
        const {createRemoteJWKSet,jwtVerify}=await import('jose');
        const {payload}=await jwtVerify(tokens.id_token,this.jwks || createRemoteJWKSet(new URL(`${AUTH}/.well-known/jwks.json`)),{issuer:AUTH,audience:client,requiredClaims:['sub','exp','iat'],clockTolerance:5});
        C.assert(payload.nonce===nonce && typeof payload.sub==='string' && payload.sub.length>0 && (!old.subject || old.subject===payload.sub),'登录身份或 nonce 不匹配');
        C.assert(tokens.scope?.split(' ').includes('chatgpt.tokens.use.direct'),'此账号未授权 ChatGPT 订阅用量');
        C.assert(tokens.refresh_token,'授权未返回续期令牌，请重新授权 offline_access');
        this.signal?.throwIfAborted();
        const sessionEpoch=randomUUID();
        const oldSession=await this.session();
        try {
          await this.save({...tokens,client_id:client,hostId:host,subject:payload.sub,email:payload.email || null,expiresAt:Date.now()+tokens.expires_in*1000,sessionEpoch});
          this.signal?.throwIfAborted();await this.markSession(sessionEpoch,false);this.signal?.throwIfAborted();
        } catch(e) {
          await this.save({...old,hostId:host,...(!old.client_id?{pendingClient:client}:{})});
          await this.atomic(this.sessionFile,JSON.stringify(oldSession));throw e;
        }
        return {signedIn:true,email:payload.email || null};
      } finally {callback.close();}
    });
  }
  async access() { return (await this.grant()).access_token; }
  async grant() {
    return this.lock(async()=>{
      let record=await this.load(); C.assert(record.access_token,'请先 Continue with ChatGPT');
      const session=await this.session();
      C.assert(!session.signedOut,'订阅已退出，请重新登录');
      C.assert(Number.isFinite(record.expiresAt) && record.scope?.split(' ').includes('chatgpt.tokens.use.direct'),'订阅授权记录无效，请重新登录');
      if(!record.sessionEpoch){record.sessionEpoch=randomUUID();await this.save(record);await this.markSession(record.sessionEpoch,false);}
      else C.assert(session.epoch===record.sessionEpoch,'订阅会话状态不完整，请重新登录');
      if(record.expiresAt<Date.now()+60000){
        C.assert(record.refresh_token,'订阅会话已过期，请重新登录');
        let tokens;
        try{tokens=await this.token({grant_type:'refresh_token',client_id:record.client_id,refresh_token:record.refresh_token});}
        catch(e){if(e.invalidGrant){await this.markSession(randomUUID(),true);await this.save(identityOnly(record));}throw e;}
        record={...record,...tokens,expiresAt:Date.now()+tokens.expires_in*1000};
        if(!record.scope?.split(' ').includes('chatgpt.tokens.use.direct')){
          await this.markSession(randomUUID(),true);await this.save(identityOnly(record));throw new Error('订阅授权已撤回，请重新登录');
        }
        await this.save(record);
      }
      return record;
    },35000);
  }
  async status(){const r=await this.load(),s=await this.session();return {signedIn:!!r.access_token && !s.signedOut && (!r.sessionEpoch || r.sessionEpoch===s.epoch),needsRefresh:!!r.access_token && r.expiresAt<Date.now()+60000,email:r.email || null};}
  async logout(){return this.lock(async()=>{
    const r=await this.load();let revoked=false;
    await this.markSession(randomUUID(),true);
    if(r.refresh_token)try{
      const discovery=await this.fetch(`${AUTH}/.well-known/openid-configuration`,{redirect:'error',signal:this.signalFor(15000)}).then(r=>r.json());
      const endpoint=new URL(discovery.revocation_endpoint);C.assert(endpoint.origin===AUTH,'撤销地址无效');
      for(let attempt=0;attempt<2;attempt++){
        try { const response=await this.fetch(endpoint,{method:'POST',redirect:'error',signal:this.signalFor(15000),body:new URLSearchParams({token:r.refresh_token,token_type_hint:'refresh_token',client_id:r.client_id})});revoked=response.status===200;if(revoked || response.status<500)break; } catch(e){if(this.signal?.aborted)break;}
        if(!attempt)await new Promise(resolve=>setTimeout(resolve,250));
      }
    }catch{}
    await this.save(identityOnly(r));return {signedIn:false,revoked};
  });}
  async withSession(run,timeoutMs=B.limits.timeoutMs) {
    const grant=await this.grant(),cancel=new AbortController();
    const check=async()=>{const s=await this.session();C.assert(!s.signedOut && s.epoch===grant.sessionEpoch,'订阅会话已退出或改变，请重新请求');};
    const timer=setInterval(()=>check().catch(()=>cancel.abort(new Error('订阅会话已退出或改变'))),250);
    try{await check();const result=await run(grant.access_token,AbortSignal.any([cancel.signal,this.signalFor(timeoutMs)]));await check();return result;}
    finally{clearInterval(timer);}
  }
  async models(){return this.withSession(async(token,signal)=>{const r=await this.fetch(`${RESOURCE}/models`,{redirect:'error',signal,headers:{Authorization:`Bearer ${token}`}});C.assert(r.ok,`模型列表失败（HTTP ${r.status}）`);const data=await r.json();C.assert(Array.isArray(data.models),'模型列表格式无效');return data.models.filter(m=>m.visibility==='list' && typeof m.slug==='string' && typeof m.display_name==='string').map(({slug,display_name})=>({slug,display_name}));});}
  async translate(model,payload,prompt,reasoningEffort='auto',timeoutMinutes=3,inputContextK=200){
    const timeoutMs=B.timeoutMinutes(timeoutMinutes)*60000,contextTokens=B.inputContextK(inputContextK)*1000;
    C.assert(['auto','none','minimal','low','medium','high','xhigh','max'].includes(reasoningEffort),'思考强度无效');
    C.assert(typeof model==='string' && model.length<=200 && Array.isArray(payload?.inputs) && payload.inputs.length<=3000 && B.bytes(payload)+B.bytes(C.buildPrompt(prompt))<=B.limits.maxInputBytes,'翻译请求无效');
    C.assert(B.estimate(payload.inputs,{...payload,prompt:C.buildPrompt(prompt)})<=contextTokens,`翻译请求超过 ${inputContextK}K 估算上下文预算`);
    return this.withSession(async(token,signal)=>{
      let r;try{r=await this.fetch(`${RESOURCE}/responses`,{method:'POST',redirect:'error',signal,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({model,...(reasoningEffort==='auto'?{}:{reasoning:{effort:reasoningEffort}}),instructions:C.buildPrompt(prompt),input:[{role:'user',content:JSON.stringify(payload)}],store:false,stream:true})});}
      catch(error){if(signal.aborted && signal.reason?.name!=='TimeoutError')throw error;throw B.error('订阅网络请求失败或超时','retry');}
      if(!r.ok){let kind=r.status===413?'split':[408,429,500,502,503,504].includes(r.status)?'retry':'fatal';if([400,422].includes(r.status)){const data=await r.json().catch(()=>({}));if(/context|token.*limit|too.long|length|maximum.*(input|output)/i.test(JSON.stringify(data.error || {}).slice(0,2000)))kind='split';}const after=r.headers?.get('retry-after');throw B.error(`订阅请求失败（HTTP ${r.status}）`,kind,{status:r.status,retryAfterMs:Math.min(60000,Number(after)*1000 || Math.max(0,Date.parse(after)-Date.now()) || 0)});}
      try{return await readSSE(r.body);}
      catch(error){
        if(signal.aborted && signal.reason?.name!=='TimeoutError')throw B.error('订阅请求已取消或会话已改变','cancel');
        if(signal.reason?.name==='TimeoutError' || error.name==='TimeoutError')throw B.error(`订阅响应读取超时（单次上限 ${timeoutMinutes} 分钟）`,'retry');
        if(error.kind)throw error;
        if(error instanceof SyntaxError)throw B.error('订阅响应 JSON 不完整','split');
        throw B.error('订阅响应流中断，未保存该批次','retry');
      }
    },timeoutMs);
  }
}
function identityOnly(r){return {hostId:r.hostId,client_id:r.client_id,pendingClient:r.pendingClient,subject:r.subject,email:r.email};}
async function openCallback(state,signal,timeoutMs){
  const server=http.createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const redirect=`http://127.0.0.1:${server.address().port}/auth/callback`;
  let consumed=false,settleReject,timer;
  const result=new Promise((resolve,reject)=>{
    settleReject=reject;timer=setTimeout(()=>reject(new Error('登录超时，请重试')),timeoutMs);
    server.on('request',(req,res)=>{
      let url;try{url=new URL(req.url,redirect);}catch{res.writeHead(400).end();return;}
      const p=url.searchParams;
      if(consumed || req.method!=='GET' || req.headers.host!==new URL(redirect).host || url.pathname!=='/auth/callback' || p.getAll('state').length!==1 || p.get('state')!==state || ['code','client_id','error'].some(k=>p.getAll(k).length>1)){res.writeHead(400).end('Invalid callback');return;}
      consumed=true;res.setHeader('Content-Type','text/plain; charset=utf-8');res.setHeader('Cache-Control','no-store');res.end('已收到授权回调，请返回插件查看最终登录结果。');resolve(p);
    });
  });
  result.catch(()=>{});
  const abort=()=>settleReject(new Error('登录已取消，未保存本次授权'));
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  return {redirect,result,close(){clearTimeout(timer);signal?.removeEventListener('abort',abort);server.close();server.closeAllConnections();}};
}
async function readSSE(body){
  const decoder=new TextDecoder();let buffer='',output='',outputBytes=0,completed=false,total=0;
  for await(const chunk of body){
    total+=chunk.length;if(total>8000000)throw B.error('订阅响应超过大小限制','split');buffer+=decoder.decode(chunk,{stream:true});buffer=buffer.replace(/\r\n/g,'\n');
    let end;
    while((end=buffer.indexOf('\n\n'))!==-1){
      const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);
      const data=frame.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');
      if(!data || data==='[DONE]')continue;const event=JSON.parse(data);
      if(event.type==='response.output_text.delta'){C.assert(!completed && typeof event.delta==='string','订阅响应事件顺序或文本无效');output+=event.delta;outputBytes+=B.bytes(event.delta);if(outputBytes>B.limits.maxReplyBytes)throw B.error('订阅输出超过单次传输限制','split');}
      if(['response.failed','response.incomplete','error'].includes(event.type)){const code=event.response?.error?.code || event.error?.code || event.response?.incomplete_details?.reason || '';throw B.error('订阅响应失败或未完成，请检查账号用量和模型权限',event.type==='response.incomplete' || /context|token.*limit/.test(code)?'split':/rate_limit|server_error/.test(code)?'retry':'fatal');}
      if(event.type==='response.completed'){C.assert(!completed && event.response?.status==='completed','订阅响应未完成或终结事件重复');completed=true;}
    }
  }
  if(!completed || buffer.trim())throw B.error('订阅响应流中断，未保存该批次','retry');return output;
}
module.exports={OAuth,readSSE,openCallback};
