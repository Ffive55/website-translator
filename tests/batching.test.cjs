'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),B=require('../extension/managed-batching'),C=require('../extension/managed-core');
const item=(i,text='Save')=>({id:'t'+i,sourceText:text+' '+i,context:'nav/button/text',path:'/settings'});
test('500 个短标签一次合并；长文本只按输入和 200K 预算拆分',()=>{
  const options={prompt:C.buildPrompt(''),glossary:[],targetLanguage:'zh-Hans'};
  const short=Array.from({length:500},(_,i)=>item(i));assert.equal(B.plan(short,options).length,1);
  const english=Array.from({length:60},(_,i)=>item(i,'Long interface description '.repeat(120)));
  assert.equal(B.plan(english,options).length,1,'输入未达到200K时，不能因为预估输出而提前拆分');
  const long=Array.from({length:120},(_,i)=>item(i,'长界面说明'.repeat(600)));
  const batches=B.plan(long,options);assert.ok(batches.length>1);assert.equal(batches.flat().length,long.length);
  for(const batch of batches){assert.ok(B.estimate(batch,options)<=200000);assert.ok(B.bytes({inputs:batch})<B.limits.maxInputBytes);}
  const biggerPrompt={...options,prompt:'提示'.repeat(6000)};assert.ok(B.plan(long,biggerPrompt).length>=batches.length);
});
test('机器翻译遵守独立协议限制，通用对话模型没有固定 20 条限制',()=>{
  const rows=Array.from({length:150},(_,i)=>item(i));
  assert.deepEqual(B.plan(rows,{provider:'deepl'}).map(b=>b.length),[50,50,50]);
  assert.deepEqual(B.plan(rows,{provider:'google'}).map(b=>b.length),[128,22]);
  assert.equal(B.plan(rows,{provider:'qwen_mt'}).length,150);assert.equal(B.plan(rows,{provider:'chatgpt'}).length,1);
});
test('共享请求槽在交错成功和异常时始终最多并发两个',async()=>{
  const slot=B.limiter();let active=0,peak=0;
  await Promise.allSettled(Array.from({length:10},(_,i)=>slot(async()=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,10));active--;if(i%3===0)throw new Error('fixture');})));
  assert.equal(peak,2);assert.equal(active,0);
});


test('输入预算可降低或提高，不预扣输出且仍遵守传输限制',()=>{
  const rows=Array.from({length:50},(_,i)=>item(i,'Label text '.repeat(80)));const options={prompt:C.buildPrompt(''),targetLanguage:'zh-Hans'};
  const low=B.plan(rows,{...options,contextTokens:10000}),high=B.plan(rows,{...options,contextTokens:200000});assert.ok(low.length>high.length);for(const batch of low)assert.ok(B.estimate(batch,options)<=10000);
  assert.throws(()=>B.inputContextK(0));assert.equal(B.inputContextK(),200);assert.equal(B.inputContextK(1000),1000);
});
