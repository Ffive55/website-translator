/* GPL-3.0-or-later. Explicit, create-only, resumable empty-repository initialization. */
(() => {
  'use strict';
  const C=typeof module!=='undefined'?require('./managed-core.js'):WTCore;
  const D=typeof module!=='undefined'?require('./dictionary-core.js'):C.dictionary;
  const R=typeof module!=='undefined'?require('./dictionary-repository.js'):C.dictionaryRepository;
  const markerPath='dictionary-initialization.json',indexPath='dictionaries/index.json';
  const paths=['README.md','LICENSE','THIRD_PARTY_NOTICES.md','source.json','dictionaries/github.com/zh-Hans/github.com.json','dictionaries/github.com/manifest.json',indexPath];
  const same=(a,b)=>C.canonical(a)===C.canonical(b),sha=v=>typeof v==='string'&&/^[a-f0-9]{40}$/.test(v);
  function apiFor(repository,token,send){const r=R.configuration(repository),http=R.transport({provider:R.provider(r),token,fetch:send});return (route,options)=>http.request('/repos/'+r.owner+'/'+r.repo+route,options);}
  async function empty(repository,token,send=globalThis.fetch){
    const api=apiFor(repository,token,send),meta=await api('');
    C.assert(meta.full_name?.toLowerCase()===(repository.owner+'/'+repository.repo).toLowerCase(),'仓库身份无法确认');
    const branches=await api('/branches?per_page=1&page=1'),tags=await api('/tags?per_page=1&page=1');
    C.assert(Array.isArray(branches)&&Array.isArray(tags),'无法确认空仓库');
    return branches.length===0&&tags.length===0;
  }
  async function prepare(seed,{getDomain,policy}){
    C.assert(seed?.schemaVersion===1&&same(Object.keys(seed.files||{}).sort(),[...paths].sort()),'初始化包文件范围无效');
    for(const raw of Object.values(seed.files))C.assert(typeof raw==='string'&&D.bytes(raw)<=D.limits.packageBytes,'初始化包文件过大');
    const files=seed.files,index=D.validateIndex(JSON.parse(files[indexPath]));
    C.assert(index.groups.length===1&&index.groups[0].group==='github.com','初始化包只能包含 GitHub 主站');
    const item=index.groups[0],raw=files[item.manifest.path];
    C.assert(D.bytes(raw)===item.manifest.bytes&&await D.digest(raw)===item.manifest.sha256,'初始化清单完整性失败');
    const manifest=await D.validateManifest(JSON.parse(raw),getDomain),data=manifest.languages['zh-Hans'];
    C.assert(manifest.group==='github.com'&&Object.keys(manifest.languages).length===1&&data&&same(data.origins,['https://github.com'])&&data.files.length===1&&data.files[0].path===paths[4]&&same(item.languages,{'zh-Hans':data.revision}),'初始化词库范围无效');
    await D.verifyFile(files[paths[4]],data.files[0],{getDomain,policy});
    return {files:structuredClone(files),digest:await D.digest(files)};
  }
  async function blobHash(raw){
    const bytes=new TextEncoder().encode(raw),prefix=new TextEncoder().encode('blob '+bytes.length+'\0'),all=new Uint8Array(prefix.length+bytes.length);
    all.set(prefix);all.set(bytes,prefix.length);
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-1',all)),v=>v.toString(16).padStart(2,'0')).join('');
  }
  function base64(raw){const bytes=new TextEncoder().encode(raw);let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(binary);}
  function create({repository,token,fetch:send=globalThis.fetch,journal=async()=>{},beforeWrite=async()=>{}}){
    const config=R.configuration(repository),selected=R.provider(config),api=apiFor(config,token,send);
    async function state(){
      const meta=await api('');
      C.assert(meta.full_name?.toLowerCase()===(config.owner+'/'+config.repo).toLowerCase(),'仓库身份无法确认');
      C.assert(!meta.archived&&(meta.permissions||meta.permission)?.push!==false,'空仓库初始化需要写入权限');
      const branches=await api('/branches?per_page=2&page=1'),tags=await api('/tags?per_page=1&page=1');
      C.assert(Array.isArray(branches)&&Array.isArray(tags),'无法确认仓库分支');
      C.assert(tags.length===0&&branches.length<=1,'仓库已有其他分支或标签，停止初始化');
      if(!branches.length)return {commit:null,tree:[]};
      C.assert(branches[0].name===config.branch&&sha(branches[0].commit?.sha),'仓库分支已改变，停止初始化');
      const commit=branches[0].commit.sha;
      const treeSha=selected==='github'?(await api('/git/commits/'+commit)).tree?.sha:commit;
      C.assert(sha(treeSha),'无法确认仓库文件树');
      const tree=await api('/git/trees/'+treeSha+'?recursive=1');
      C.assert(tree.truncated!==true&&Array.isArray(tree.tree)&&tree.tree.length<=30,'仓库文件树不完整或不是初始化内容');
      return {commit,tree:tree.tree};
    }
    async function step(seed,previous){
      // Only prepared bundled data enters here; the UI cannot supply files or paths.
      let saved=previous;
      if(saved){C.assert(same(saved.repository,config)&&saved.seedDigest===seed.digest&&typeof saved.id==='string','初始化来源已变化，请使用原版本完成初始化');}
      else {
        C.assert((await state()).commit===null,'仓库已不是空仓库，请重新测试；已有内容未修改');
        saved={schemaVersion:1,id:crypto.randomUUID(),repository:config,seedDigest:seed.digest,done:false};
        await journal(saved);
      }
      const marker=JSON.stringify({schemaVersion:1,id:saved.id,repository:config,seedDigest:seed.digest},null,2)+'\n';
      // Index is the last file: incomplete uploads are never advertised as a usable dictionary.
      const files={[markerPath]:marker,...seed.files},ordered=[markerPath,...paths];
      const expected=Object.fromEntries(await Promise.all(ordered.map(async p=>[p,await blobHash(files[p])])));
      const remote=await state(),present=new Set();
      for(const row of remote.tree){
        if(row.type==='tree'){C.assert(ordered.some(p=>p.startsWith(row.path+'/')),'仓库出现其他目录，停止初始化');continue;}
        C.assert(row.type==='blob'&&row.mode==='100644'&&expected[row.path]===row.sha&&!present.has(row.path),'仓库内容已变化，停止初始化；已有文件未覆盖');present.add(row.path);
      }
      C.assert(!remote.commit||present.has(markerPath),'仓库已存在其他内容，停止初始化');
      if(present.has(indexPath))C.assert(ordered.every(p=>present.has(p)),'初始化索引已存在但文件不完整');
      const missing=ordered.find(p=>!present.has(p));
      if(!missing){saved={...saved,done:true,commit:remote.commit,pendingPath:null};await journal(saved);return {...saved,completed:ordered.length,total:ordered.length};}
      await beforeWrite();
      saved={...saved,pendingPath:missing};await journal(saved);
      try {
        await api('/contents/'+missing.split('/').map(encodeURIComponent).join('/'),{method:selected==='gitee'?'POST':'PUT',body:{branch:config.branch,message:'Initialize dictionary [WT-INIT:'+saved.id+'] '+missing,content:base64(files[missing])}});
      } catch(error){
        // Keep the journal even on a lost response. The next explicit attempt reads
        // the branch tree first. Create-only requests never replace an existing file.
        throw Object.assign(new Error('初始化未完成：'+error.message+'。重新测试并选择此仓库可核查后继续。'),{kind:error.kind,status:error.status});
      }
      return {...saved,done:false,completed:present.size+1,total:ordered.length};
    }
    return {step};
  }
  const api={empty,prepare,create};if(typeof module!=='undefined')module.exports=api;else C.dictionaryInitialize=api;
})();
