'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),E=require('../extension/dictionary-errors'),R=require('../extension/dictionary-repository');
test('403 权限和限流分开，等待 Retry-After，错误不回显服务器敏感正文',async()=>{
 const permission=await E.fromResponse(new Response(JSON.stringify({message:'private fixture-token'}),{status:403,headers:{'x-ratelimit-remaining':'4990'}}));assert.equal(permission.kind,'authorization');assert.match(permission.message,/权限不足/);assert.ok(!permission.message.includes('fixture-token'));
 const limited=await E.fromResponse(new Response('{}',{status:403,headers:{'x-ratelimit-remaining':'0','x-ratelimit-reset':'200'}}),{now:100000});assert.equal(limited.kind,'rate-limit');assert.equal(limited.retryAt,200000);
 const secondary=await E.fromResponse(new Response(JSON.stringify({message:'secondary rate limit'}),{status:403,headers:{'retry-after':'120'}}),{now:100000});assert.equal(secondary.retryAt,220000);
});
test('一个限流/授权错误后不按每个网站继续请求，冷却后可恢复',async()=>{
 let calls=0,now=100000;const client=R.create({repository:{owner:'fixture',repo:'dictionary',branch:'main'},token:'fixture',getDomain:h=>h,policy:{},now:()=>now,fetch:async()=>{calls++;return new Response('{}',{status:429,headers:{'retry-after':'60'}});}});
 await assert.rejects(()=>client.readIndex());await assert.rejects(()=>client.readIndex());assert.equal(calls,1);now=161000;await assert.rejects(()=>client.readIndex());assert.equal(calls,2);
 let offlineCalls=0;const offline=R.create({repository:{owner:'fixture',repo:'dictionary',branch:'main'},policy:{},getDomain:h=>h,now:()=>now,fetch:async()=>{offlineCalls++;throw new TypeError('offline');}});await assert.rejects(()=>offline.readIndex(),e=>e.kind==='network');await assert.rejects(()=>offline.readIndex());assert.equal(offlineCalls,1);
});
