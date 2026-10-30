/* GPL-3.0-or-later. Provider configuration and data-only adapters. */
(() => {
  'use strict';
  const catalog={
    deepseek:{label:'DeepSeek',endpoint:'https://api.deepseek.com/chat/completions',kind:'chat'},
    deepl:{label:'DeepL',endpoint:'https://api-free.deepl.com/v2/translate',kind:'mt'},
    google:{label:'Google Cloud Translation',endpoint:'https://translation.googleapis.com/language/translate/v2',kind:'mt'},
    azure:{label:'Microsoft Translator（Azure）',endpoint:'https://api.cognitive.microsofttranslator.com/translate',kind:'mt'},
    qwen_mt:{label:'Qwen-MT（机器翻译）',endpoint:'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',kind:'mt',model:true},
    openai:{label:'OpenAI 官方接口',endpoint:'https://api.openai.com/v1/chat/completions',kind:'chat'},
    qwen:{label:'Qwen 对话模型',endpoint:'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',kind:'chat'},
    minimax:{label:'MiniMax',endpoint:'https://api.minimaxi.com/v1/chat/completions',kind:'chat'},
    kimi:{label:'Kimi',endpoint:'https://api.moonshot.ai/v1/chat/completions',kind:'chat'},
    zhipu:{label:'智谱 GLM',endpoint:'https://open.bigmodel.cn/api/paas/v4/chat/completions',kind:'chat'},
    volcengine:{label:'火山方舟',endpoint:'https://ark.cn-beijing.volces.com/api/v3/chat/completions',kind:'chat'},
    api:{label:'自定义 OpenAI 兼容接口',endpoint:'',kind:'chat'},
    chatgpt:{label:'ChatGPT 订阅',endpoint:'',kind:'subscription'}
  };
  function normalizeEndpoint(provider,value) {
    const u=new URL(value);if((catalog[provider]?.kind==='chat' || provider==='qwen_mt') && !/\/chat\/completions\/?$/.test(u.pathname)) {
      let base=u.pathname.replace(/\/$/,'');
      if(!base){const preset=catalog[provider]?.endpoint;base=preset?new URL(preset).pathname.replace(/\/chat\/completions$/,''):'/v1';}
      u.pathname=base+'/chat/completions';
    }
    return u.href;
  }
  function target(provider,language) {
    if(provider==='deepl')return ({'zh-Hans':'ZH-HANS','zh-Hant':'ZH-HANT','en':'EN','pt':'PT'})[language] || language.toUpperCase();
    if(provider==='google')return ({'zh-Hans':'zh-CN','zh-Hant':'zh-TW'})[language] || language;
    if(provider==='qwen_mt')return ({'zh-Hans':'Chinese','zh-Hant':'Traditional Chinese'})[language] || new Intl.DisplayNames(['en'],{type:'language'}).of(language);
    return language;
  }
  // Machine translation has no semantic classifier: send only clearly identified UI controls.
  const isUI=item=>/^(nav|header|footer|aside)\//.test(item.context) || /\/(button|label|input|textarea|select|option)\//.test(item.context) || /\/@(placeholder|aria-label|title)$/.test(item.context) || /\/(button|tab|menuitem)$/.test(item.context);
  function machineRequest(config,inputs,language) {
    const url=new URL(config.endpoint),headers={'Content-Type':'application/json'},texts=inputs.map(i=>i.sourceText),to=target(config.provider,language);let body;
    if(config.provider==='deepl'){headers.Authorization=`DeepL-Auth-Key ${config.apiKey}`;body={text:texts,target_lang:to};}
    if(config.provider==='google'){headers['X-goog-api-key']=config.apiKey;body={q:texts,target:to,format:'text'};}
    if(config.provider==='azure'){url.searchParams.set('api-version','3.0');url.searchParams.set('to',to);headers['Ocp-Apim-Subscription-Key']=config.apiKey;if(config.region)headers['Ocp-Apim-Subscription-Region']=config.region;body=texts.map(Text=>({Text}));}
    if(config.provider==='qwen_mt'){headers.Authorization=`Bearer ${config.apiKey}`;body={model:config.model,messages:[{role:'user',content:texts[0]}],translation_options:{source_lang:'auto',target_lang:to}};}
    return {url:url.href,headers,body};
  }
  const decodeEntities=s=>String(s).replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi,(_,v)=>{if(v[0]==='#'){const n=v[1].toLowerCase()==='x'?parseInt(v.slice(2),16):Number(v.slice(1));return n>=0 && n<=0x10ffff?String.fromCodePoint(n):_};return {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"}[v.toLowerCase()] || _;});
  function machineResult(provider,data){
    if(provider==='deepl')return data.translations?.map(t=>t.text);
    if(provider==='google')return data.data?.translations?.map(t=>decodeEntities(t.translatedText));
    if(provider==='azure')return Array.isArray(data)?data.map(t=>t.translations?.[0]?.text):null;
    return [data.choices?.[0]?.message?.content];
  }
  const api={catalog,normalizeEndpoint,target,isUI,machineRequest,machineResult};
  if(typeof module==='object' && module.exports)module.exports=api;
  globalThis.WTProviders=api;
})();
