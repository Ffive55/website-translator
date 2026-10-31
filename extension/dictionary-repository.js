/* GPL-3.0-or-later. Read-only GitHub transport used by the background runtime. Publishing is separate. */
(() => {
  'use strict';
  const C = typeof module !== 'undefined' ? require('./managed-core.js') : globalThis.WTCore;
  const D = typeof module !== 'undefined' ? require('./dictionary-core.js') : C.dictionary;
  const E=typeof module!=='undefined'?require('./dictionary-errors.js'):C.dictionaryErrors;
  const commitId = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
  const platform = value => { C.assert(['github','gitee'].includes(value), '不支持的词库平台'); return value; };
  const provider = value => platform(value?.provider || 'github');
  const host = value => platform(value) === 'gitee' ? 'https://gitee.com/api/v5' : 'https://api.github.com';
  const permission = value => platform(value) === 'gitee' ? 'https://gitee.com/*' : 'https://api.github.com/*';
  const configuration=value=>D.repositoryConfiguration(value);
  function transport({ provider: selected='github', token='', fetch: send=globalThis.fetch, now=Date.now, blockNotFound=false }) {
    platform(selected);
    C.assert(typeof token==='string' && token.length<=1000 && !/[\r\n]/.test(token), '本机仓库凭据无效');
    const label=selected==='gitee'?'Gitee':'GitHub';let blocked,until=0;
    async function request(route,{maximum=2*1024*1024,raw=false,method='GET',body}={}) {
      C.assert(typeof route==='string' && route.startsWith('/') && !route.startsWith('//'), '仓库请求路径无效');
      if(blocked && now()<until)throw blocked;
      let received=false;const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);
      try {
        const response=await send(host(selected)+route,{method,credentials:'omit',redirect:'error',cache:'no-store',signal:controller.signal,
          headers:{Accept:selected==='github'?(raw?'application/vnd.github.raw+json':'application/vnd.github+json'):(raw?'application/octet-stream':'application/json'),
            ...(selected==='github'?{'X-GitHub-Api-Version':'2022-11-28'}:{}),...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
        received=true;
        if(!response.ok)throw await E.fromResponse(response,{authenticated:!!token,write:method!=='GET',now:now(),provider:selected});
        C.assert(Number(response.headers.get('content-length')||0)<=maximum && response.body, label+' 响应过大或为空');
        const reader=response.body.getReader(),chunks=[];let size=0;
        try{while(true){const r=await reader.read();if(r.done)break;size+=r.value.byteLength;C.assert(size<=maximum,label+' 响应超过大小限制');chunks.push(r.value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
        const data=new Uint8Array(size);let offset=0;for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.length;}
        const text=new TextDecoder('utf-8',{fatal:true}).decode(data);if(raw)return text;try{return JSON.parse(text);}catch{throw new Error(label+' 返回的 JSON 无效');}
      }catch(error){
        if(controller.signal.aborted || !received)error=Object.assign(new Error(label+(controller.signal.aborted?' 请求超时':' 网络暂不可用')+'；本机词库保留，稍后重试'),{kind:'network',retryAt:now()+60000});
        if(['network','rate-limit','authorization'].includes(error.kind)||blockNotFound&&error.kind==='not-found'){blocked=error;until=['authorization','not-found'].includes(error.kind)?Infinity:error.retryAt||now()+30000;}
        throw error;
      }finally{clearTimeout(timer);}
    }
    return {request,resetAuthorization(){if(['authorization','not-found'].includes(blocked?.kind)){blocked=null;until=0;}}};
  }
  function create({ repository, policy, getDomain, fetch: send = globalThis.fetch, token = '', now = Date.now }) {
    const config=configuration(repository),selected=provider(config),prefix='/repos/'+config.owner+'/'+config.repo;
    const http=transport({provider:selected,token,fetch:send,now,blockNotFound:true});
    let cached,flight;const manifests=new Map();
    const request=(suffix,maximum,raw=false)=>http.request(prefix+suffix,{maximum,raw});
    const file = (path, commit, maximum) => {
      C.assert(commitId(commit), '必须固定完整的远端提交');
      C.assert(path === 'dictionaries/index.json' || /^dictionaries\/[a-z0-9][a-z0-9.-]*\/(?:manifest\.json|[a-zA-Z0-9-]+\/[a-z0-9][a-z0-9.-]*\.json)$/.test(path) && !path.includes('..'), '只允许下载 dictionaries 内的协议文件');
      return request((selected==='gitee'?'/raw/':'/contents/') + path.split('/').map(encodeURIComponent).join('/') + '?ref=' + commit, maximum, true);
    };
    async function readIndex(force = false) {
      if(force)http.resetAuthorization();
      if (force) cached = null;
      if (cached && now() - cached.checkedAt < 60000) return cached;
      if (!flight) flight = (async () => {
        let commit;
        if(selected==='gitee'){
          const ref=await request('/branches/'+encodeURIComponent(config.branch),20000);commit=ref.commit?.sha;
          C.assert(ref.name===config.branch && commitId(commit),'Gitee 分支没有返回有效的固定提交');
        }else{
          const ref=await request('/git/ref/heads/'+config.branch.split('/').map(encodeURIComponent).join('/'),20000);
          C.assert(ref.ref==='refs/heads/'+config.branch && ref.object?.type==='commit' && commitId(ref.object.sha),'GitHub 分支没有返回有效的固定提交');commit=ref.object.sha;
        }
        const index=D.validateIndex(JSON.parse(await file('dictionaries/index.json',commit,D.limits.indexBytes)));
        cached = { repository: config, commit, index, checkedAt: now() }; manifests.clear(); return cached;
      })().finally(() => { flight = null; });
      return flight;
    }
    async function manifest(pin, group) {
      C.assert(C.canonical(pin.repository) === C.canonical(config) && commitId(pin.commit), '仓库配置或固定提交已改变');
      const description = pin.index.groups.find(g => g.group === group);
      if (!description) return null;
      const cacheKey = pin.commit + ':' + group;
      if (manifests.has(cacheKey)) return manifests.get(cacheKey);
      const raw = await file(description.manifest.path, pin.commit, D.limits.manifestBytes);
      C.assert(D.bytes(raw) === description.manifest.bytes && await D.digest(raw) === description.manifest.sha256, '分组清单完整性校验失败');
      const result = await D.validateManifest(JSON.parse(raw), getDomain);
      C.assert(result.group === group && C.canonical(Object.fromEntries(Object.entries(result.languages).map(([lang, data]) => [lang, data.revision]))) === C.canonical(description.languages), '分组清单与总索引不一致');
      manifests.set(cacheKey, result); if (manifests.size > 100) manifests.delete(manifests.keys().next().value); return result;
    }
    async function selection(pin, group, language, installedOrigins) {
      D.groupId(group); C.assert(C.language(language) === language && Array.isArray(installedOrigins) && installedOrigins.length <= D.limits.origins, '安装范围无效');
      for (const o of installedOrigins) C.assert(D.groupFor(o, getDomain) === group, '安装网址越出主域名');
      const data = await manifest(pin, group);
      if (!data) return { status: 'no-dictionary', files: [], missing: installedOrigins };
      if (!data.languages[language]) return { status: 'no-language', files: [], missing: installedOrigins };
      const files = D.selectFiles(data, language, installedOrigins);
      const missing = installedOrigins.filter(o => !files.some(f => f.origins.includes(o)));
      const revision = await D.digest({ group, language, origins: [...installedOrigins].sort(), files });
      return { status: 'available', files, missing, revision };
    }
    async function check(installedGroups, language) {
      const pin = await readIndex(true), groups = [];
      C.assert(Array.isArray(installedGroups) && installedGroups.length <= 1000, '安装分组数量无效');
      for (const installed of installedGroups) {
        try { const result = await selection(pin, installed.group, language, installed.origins); groups.push({ group: installed.group, ...result, hasUpdate: result.files.length > 0 && result.revision !== installed.revision }); }
        catch (e) { groups.push({ group: installed.group, status: 'failed', error: e.message, hasUpdate: false }); }
      }
      return { pin, groups };
    }
    async function downloadGroup(pin, group, language, installedOrigins) {
      const selected = await selection(pin, group, language, installedOrigins);
      C.assert(selected.files.length > 0, selected.status === 'no-language' ? '暂无此语言词库' : '暂无适用词库');
      const files = [];
      // Sequential bounded downloads avoid a large GitHub dictionary multiplying in memory.
      for (const description of selected.files) {
        const raw = await file(description.path, pin.commit, D.limits.packageBytes);
        const pack = await D.verifyFile(raw, description, { getDomain, policy });
        files.push({ description, pack, raw });
      }
      return { schemaVersion: D.VERSION, repository: config, commit: pin.commit, group, targetLanguage: language,
        installedOrigins: [...installedOrigins], revision: selected.revision, missing: selected.missing, files };
    }
    async function catalog(language, query = '') {
      C.assert(C.language(language) === language && typeof query === 'string' && query.length <= 200, '词库搜索条件无效');
      const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean), pin = await readIndex(true), rows = [];
      // Search metadata only. Package bodies are fetched only after the user downloads one.
      for (const description of pin.index.groups) {
        if (!description.languages[language]) continue;
        const data = (await manifest(pin, description.group)).languages[language];
        const text = `${description.group} ${data.origins.join(' ')} ${language}`.toLowerCase();
        if (words.every(word => text.includes(word))) rows.push({ group: description.group, origins: [...data.origins] });
      }
      return { repository: config, targetLanguage: language, rows };
    }
    return Object.freeze({ readIndex, check, downloadGroup, manifest, catalog });
  }
  const api = Object.freeze({ configuration, create, provider, platform, host, permission, transport });
  if (typeof module !== 'undefined') module.exports = api;
  else C.dictionaryRepository = api;
})();
