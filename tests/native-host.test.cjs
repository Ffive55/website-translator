'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {spawn}=require('node:child_process'),{once}=require('node:events'),{randomUUID}=require('node:crypto');
const {encode}=require('../native/host.cjs');
test('Native Messaging 真实子进程处理分片帧；浏览器断开取消登录并释放锁', {skip:process.platform!=='win32',timeout:20000},async t=>{
  const root=path.resolve(__dirname,'../.cache/native-host-tests',randomUUID());await fs.mkdir(root,{recursive:true});
  const child=spawn(process.execPath,[path.resolve(__dirname,'../native/host.cjs')],{windowsHide:true,env:{...process.env,LOCALAPPDATA:root},stdio:['pipe','pipe','pipe']});
  t.after(async()=>{if(child.exitCode===null)child.kill();await fs.rm(root,{recursive:true,force:true});});
  let buffer=Buffer.alloc(0),stderr='';const frames=[],waiting=[];
  child.stderr.on('data',b=>stderr+=b);
  child.stdout.on('data',b=>{
    buffer=Buffer.concat([buffer,b]);
    while(buffer.length>=4 && buffer.length>=4+buffer.readUInt32LE()){
      const size=buffer.readUInt32LE(),value=JSON.parse(buffer.subarray(4,size+4));buffer=buffer.subarray(size+4);
      if(waiting.length)waiting.shift()(value);else frames.push(value);
    }
  });
  const next=()=>frames.length?Promise.resolve(frames.shift()):new Promise(r=>waiting.push(r));
  const status=encode({action:'status'});child.stdin.write(status.subarray(0,2));child.stdin.write(status.subarray(2,7));child.stdin.write(status.subarray(7));
  assert.deepEqual(await next(),{ok:true,result:{signedIn:false,needsRefresh:false,email:null}});
  child.stdin.write(encode({action:'login'}));const started=await next();assert.equal(started.ok,true);assert.equal(new URL(started.result.authorizeUrl).origin,'https://auth.openai.com');
  // Do not open the URL or perform any real authorization/network request.
  const exited=once(child,'exit');child.stdin.end();const [code]=await exited;assert.equal(code,0);assert.equal(stderr,'');
  assert.equal((await fs.readdir(path.join(root,'WebsiteTranslator'))).includes('session.lock'),false);
});
