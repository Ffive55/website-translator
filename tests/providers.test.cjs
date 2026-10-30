'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const P=require('../extension/managed-providers'),C=require('../extension/managed-core');
test('旧服务全部保留，机器翻译使用各自协议、语言映射和认证字段',()=>{
  assert.equal(Object.keys(P.catalog).length,13);
  const inputs=[{id:'a',sourceText:'First name',context:'form/input/@placeholder',path:'/'}];
  for(const provider of ['deepl','google','azure','qwen_mt']) {
    const r=P.machineRequest({provider,endpoint:P.catalog[provider].endpoint,apiKey:'fixture-key',region:'eastasia',model:'fixture-model'},inputs,'zh-Hans');
    assert.ok(!r.url.includes('fixture-key'));assert.ok(!JSON.stringify(r.body).includes('fixture-key'));
    if(provider==='deepl'){assert.equal(r.headers.Authorization,'DeepL-Auth-Key fixture-key');assert.deepEqual(r.body.text,['First name']);assert.equal(r.body.target_lang,'ZH-HANS');}
    if(provider==='google'){assert.equal(r.headers['X-goog-api-key'],'fixture-key');assert.equal(r.body.target,'zh-CN');assert.deepEqual(P.machineResult(provider,{data:{translations:[{translatedText:'A &amp; B &#39;C&#39;'}]}}),["A & B 'C'"]);}
    if(provider==='azure'){assert.equal(new URL(r.url).searchParams.get('to'),'zh-Hans');assert.equal(r.headers['Ocp-Apim-Subscription-Region'],'eastasia');assert.deepEqual(r.body,[{Text:'First name'}]);}
    if(provider==='qwen_mt'){assert.deepEqual(r.body.translation_options,{source_lang:'auto',target_lang:'Chinese'});assert.equal(r.body.messages.length,1);assert.equal(r.body.messages[0].content,'First name');}
  }
  assert.equal(P.isUI(inputs[0]),true);assert.equal(P.isUI({context:'main/p/text'}),false);
  assert.equal(P.normalizeEndpoint('api','https://example.com/v1'),'https://example.com/v1/chat/completions');
});
test('跨页公共界面复用保持语言、上下文及人工冲突边界',()=>{
  const base={sourceText:'Settings',context:'nav/span/text',path:'/logs',targetLanguage:'zh-Hans',category:'ui',action:'translate',origin:'ai',translation:'设置'};
  const entries={a:base};
  assert.equal(C.reusableEntry(entries,{...base,path:'/keys'}).translation,'设置');
  assert.equal(C.reusableEntry(entries,{...base,targetLanguage:'ja'}),null);
  assert.equal(C.reusableEntry(entries,{...base,context:'main/h1/text'}),null);
  entries.b={...base,path:'/routing',origin:'manual',translation:'配置'};
  assert.equal(C.reusableEntry(entries,base).translation,'配置');
  entries.c={...base,path:'/files',origin:'manual',translation:'选项'};
  assert.equal(C.reusableEntry(entries,base),null);
});
