'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{spawnSync,spawn}=require('node:child_process'),{once}=require('node:events'),{randomUUID}=require('node:crypto');
const {encode}=require('../native/host.cjs');
test('Edge 随附运行时独立加载 jose 和订阅连接，旧目录写入入口退出，无需系统 Node 或注册安装', {skip:process.platform!=='win32',timeout:15000},async t=>{
  const root=path.resolve(__dirname,'../edge/local-helper'),node=path.join(root,'runtime/node.exe');
  assert.ok(fs.existsSync(node));assert.ok(fs.existsSync(path.join(root,'runtime/LICENSE.txt')));assert.ok(fs.existsSync(path.join(root,'node_modules/jose/LICENSE.md')));
  const importResult=spawnSync(node,['-e',"import('jose').then(()=>console.log('ok'))"],{cwd:root,env:{...process.env,PATH:''},windowsHide:true,encoding:'utf8'});assert.equal(importResult.status,0,importResult.stderr);assert.match(importResult.stdout,/ok/);
  const isolated=path.resolve(__dirname,'../.cache/bundled-native-tests',randomUUID());fs.mkdirSync(isolated,{recursive:true});
  const child=spawn(node,[path.join(root,'native/host.cjs')],{env:{...process.env,LOCALAPPDATA:isolated,PATH:''},windowsHide:true,stdio:['pipe','pipe','pipe']});
  t.after(async()=>{if(child.exitCode===null)child.kill();assert.ok(isolated.startsWith(path.resolve(__dirname,'../.cache/bundled-native-tests')+path.sep));fs.rmSync(isolated,{recursive:true,force:true});});
  let buffer=Buffer.alloc(0);const pending=[];child.stdout.on('data',b=>{buffer=Buffer.concat([buffer,b]);while(buffer.length>=4 && buffer.length>=buffer.readUInt32LE()+4){const n=buffer.readUInt32LE(),m=JSON.parse(buffer.subarray(4,n+4));buffer=buffer.subarray(n+4);pending.shift()(m);}});
  const request=m=>new Promise(resolve=>{pending.push(resolve);child.stdin.write(encode(m));});
  const ping=await request({action:'ping'});assert.equal(ping.ok,true);assert.equal(ping.result.connected,true);assert.equal(ping.result.version,require('../package.json').version);
  assert.equal(fs.existsSync(path.join(root,'native/sync.cjs')),false);
  const folder=path.join(isolated,'onedrive-fixture');
  for(const action of ['confirm-directory','sync','ack']){const result=await request({action,directory:folder});assert.equal(result.ok,false);assert.match(result.error,/未知本地操作/);}
  assert.equal(fs.existsSync(folder),false);assert.equal(fs.existsSync(path.join(isolated,'WebsiteTranslator/chatgpt.dat')),false,'连接检查不得读取或生成订阅令牌');
  const exited=once(child,'exit');child.stdin.end();await exited;
});
