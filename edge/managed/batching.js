/* GPL-3.0-or-later. Shared translation sizing and bounded request concurrency. */
(() => {
  'use strict';
  const limits=Object.freeze({contextTokens:200000,concurrency:2,retries:2,maxSplits:16,maxInputBytes:700000,maxReplyBytes:450000,maxEnvelopeBytes:950000,timeoutMs:180000});
  function timeoutMinutes(value=3){if(!Number.isInteger(value) || value<1 || value>60)throw new Error('单次请求超时必须为 1–60 的整数分钟');return value;}
  function inputContextK(value=200){if(!Number.isInteger(value) || value<1 || value>1000)throw new Error('输入上下文上限必须为 1–1000 的整数 K tokens');return value;}
  const bytes=value=>new TextEncoder().encode(typeof value==='string'?value:JSON.stringify(value)).length;
  // Provider-neutral input estimate, not an exact model tokenizer: ASCII / 2
  // and UTF-8 bytes for other characters. Never reserve predicted output here.
  function tokens(value){const text=typeof value==='string'?value:JSON.stringify(value);let ascii=0,other=0;for(const c of text){if(c.codePointAt(0)<128)ascii++;else other+=bytes(c);}return Math.ceil(ascii/2)+other;}
  function itemSize(item){return {input:bytes(item)+1,tokens:tokens(item)+1,chars:item.sourceText.length};}
  function plan(inputs,{prompt='',glossary=[],targetLanguage='zh-Hans',provider='api',contextTokens=limits.contextTokens}={}){
    const fixed={targetLanguage,inputs:[],glossary},baseTokens=tokens(prompt)+tokens(fixed)+256,baseBytes=bytes(prompt)+bytes(fixed);
    const caps=provider==='deepl'?{count:50,chars:100000,bytes:120000}:provider==='google'?{count:128,chars:5000,bytes:120000}:provider==='azure'?{count:1000,chars:45000,bytes:500000}:provider==='qwen_mt'?{count:1,chars:50000,bytes:120000}:{count:3000,chars:Infinity,bytes:limits.maxInputBytes};
    const result=[];let rows=[],size;
    const reset=()=>{rows=[];size={input:baseBytes,tokens:baseTokens,chars:0};};reset();
    for(const item of inputs){
      const n=itemSize(item),fits=()=>rows.length<caps.count && size.input+n.input<=caps.bytes && size.chars+n.chars<=caps.chars && size.tokens+n.tokens<=inputContextK(contextTokens/1000)*1000;
      if(!fits() && rows.length){result.push(rows);reset();}
      if(!fits())throw new Error('单条文本与提示词超过翻译预算，请缩短提示词或文本');
      rows.push(item);for(const key of Object.keys(size))size[key]+=n[key] || 0;
    }
    if(rows.length)result.push(rows);return result;
  }
  function estimate(inputs,options={}){return tokens(options.prompt || '')+tokens({targetLanguage:options.targetLanguage || 'zh-Hans',glossary:options.glossary || [],inputs})+256;}
  function split(inputs){const weights=inputs.map(i=>itemSize(i).input),half=weights.reduce((a,b)=>a+b,0)/2;let total=0,index=1;for(let i=0;i<inputs.length-1;i++){total+=weights[i];index=i+1;if(total>=half)break;}return [inputs.slice(0,index),inputs.slice(index)];}
  function limiter(max=limits.concurrency){let active=0;const waiting=[];return async fn=>{await new Promise(resolve=>{waiting.push(resolve);if(active<max){active++;waiting.shift()();}});try{return await fn();}finally{if(waiting.length)waiting.shift()();else active--;}};}
  function error(message,kind='fatal',details={}){return Object.assign(new Error(message),{kind,...details});}
  const api={limits,timeoutMinutes,inputContextK,bytes,tokens,plan,estimate,split,limiter,error};
  if(typeof module!=='undefined')module.exports=api;else globalThis.WTBatch=api;
})();
