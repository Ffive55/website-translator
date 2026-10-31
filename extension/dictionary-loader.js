/* GPL-3.0-or-later. Hydrate data from the isolated extension background only. */
(() => {
  'use strict';
  let policy;
  globalThis.WTLoadDictionary = async () => {
    const response = await chrome.runtime.sendMessage({type:'wt:dictionary'});
    if(!response?.ok || !response.result)return null;
    policy ||= await(await fetch(chrome.runtime.getURL('managed/dictionary-policy.json'))).json();
    return WTCore.dictionaryAdapters.hydrate(response.result,{getDomain:globalThis.tldts?.getDomain || ((host)=>response.result.group),policy},globalThis.WTDictionaryHandlers.bind);
  };
  let revision;
  chrome.runtime.onMessage.addListener(message=>{
    if(message.type==='wt:dictionary-refresh' && revision!==message.revision){revision=message.revision;location.reload();}
  });
})();
