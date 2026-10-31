/* GPL-3.0-or-later. Publish validated data in one non-forced Git commit. */
(() => {
  'use strict';
  const C = typeof module !== 'undefined' ? require('./managed-core.js') : WTCore;
  const D = typeof module !== 'undefined' ? require('./dictionary-core.js') : C.dictionary;
  const R = typeof module !== 'undefined' ? require('./dictionary-repository.js') : C.dictionaryRepository;
  const E=typeof module!=='undefined'?require('./dictionary-errors.js'):C.dictionaryErrors;
  const json = value => JSON.stringify(value, null, 2) + '\n';
  function validateDraft(draft) {
    C.assert(draft && /^[a-f0-9]{40}$/.test(draft.parent) && Object.keys(draft.files).length>=3 && Object.keys(draft.files).length<=402,'上传准备数据无效');
    for(const [path,raw] of Object.entries(draft.files)){
      C.assert(path==='dictionaries/index.json'||D.path(path,draft.group,path.endsWith('/manifest.json')?null:draft.language),'上传越界');
      C.assert(typeof raw==='string'&&D.bytes(raw)<=D.limits.packageBytes,'上传内容过大');
    }
    C.assert(Object.hasOwn(draft.files,'dictionaries/index.json')&&Object.hasOwn(draft.files,`dictionaries/${draft.group}/manifest.json`),'上传缺少索引或清单');
    C.assert(Object.values(draft.files).reduce((n,raw)=>n+D.bytes(raw),0)<=D.limits.groupBytes+2*1024*1024,'上传分组内容过大');
  }
  function createGitee({repository,token,fetch:send,journal,beforeCommit}) {
    const config=R.configuration(repository),prefix='/repos/'+config.owner+'/'+config.repo;
    const http=R.transport({provider:'gitee',token,fetch:send});
    const api=(route,options)=>http.request(prefix+route,options);
    const branchRoute='/branches/'+encodeURIComponent(config.branch);
    async function confirm(saved) {
      // One fresh read-only reconciliation is allowed after a lost POST reply;
      // the failed writer's network cooldown must not block this confirmation.
      const reader=R.transport({provider:'gitee',token,fetch:send});
      const read=(route,options)=>reader.request(prefix+route,options);
      C.assert(C.canonical(R.configuration(saved.repository))===C.canonical(config),'待确认发布属于其他仓库');
      const rows=await read('/commits?sha='+encodeURIComponent(config.branch)+'&per_page=100');
      C.assert(Array.isArray(rows),'提交查询返回无效');
      const found=rows.find(row=>saved.commit?row.sha===saved.commit:row.commit?.message?.includes('[WT:'+saved.transactionId+']'));
      C.assert(found && /^[a-f0-9]{40}$/.test(found.sha),'上次上传结果尚未确认，本地修改保留；请稍后重试核查，未重复上传');
      for(const [path,digest] of Object.entries(saved.expectedFiles)){
        const raw=await read('/raw/'+path.split('/').map(encodeURIComponent).join('/')+'?ref='+found.sha,{raw:true,maximum:D.limits.packageBytes});
        C.assert(await D.digest(raw)===digest,'上次上传提交内容不一致，未重复上传');
      }
      saved.commit=found.sha;return true;
    }
    async function publish(draft) {
      validateDraft(draft);
      let head=await api(branchRoute);C.assert(head.commit?.sha===draft.parent,'远端已更新，请重新点击上传合并');
      const actions=[];
      for(const [path,content] of Object.entries(draft.files)){
        let exists=true;
        try{
          const metadata=await api('/contents/'+path.split('/').map(encodeURIComponent).join('/')+'?ref='+draft.parent,{maximum:Math.ceil(D.limits.packageBytes*1.5)});
          // Gitee returns HTTP 200 + [] for a missing path, not always 404.
          // Non-empty directory listings and malformed objects are never files.
          if(Array.isArray(metadata)&&metadata.length===0)exists=false;
          else C.assert(metadata?.type==='file' && metadata.path===path && /^[a-f0-9]{40}$/.test(metadata.sha),'仓库目标路径不是有效文件，未上传：'+path);
        }
        catch(error){if(error.status===404)exists=false;else throw error;}
        const action={action:exists?'update':'create',path,content,encoding:'text'};
        if(exists){
          const history=await api('/commits?sha='+draft.parent+'&path='+encodeURIComponent(path)+'&per_page=1');
          C.assert(Array.isArray(history)&&/^[a-f0-9]{40}$/.test(history[0]?.sha),'无法确定文件版本，未上传');action.last_commit_id=history[0].sha;
        }
        actions.push(action);
      }
      const saved={repository:config,parent:draft.parent,transactionId:crypto.randomUUID(),group:draft.group,language:draft.language,
        expectedFiles:Object.fromEntries(await Promise.all(Object.entries(draft.files).map(async([path,raw])=>[path,await D.digest(raw)])))};
      // Persist the transaction identity BEFORE the one multi-file write. Unknown
      // outcomes are reconciled using this identity and all three file digests.
      await journal(saved);
      let sent=false;
      try{
        await beforeCommit();head=await api(branchRoute);C.assert(head.commit?.sha===draft.parent,'发布准备期间远端已变化，请重新点击上传合并');
        sent=true;
        const result=await api('/commits',{method:'POST',body:{branch:config.branch,message:`Update dictionary ${draft.group} ${draft.language} [WT:${saved.transactionId}]`,actions}});
        C.assert(/^[a-f0-9]{40}$/.test(result.sha),'发布结果未返回有效提交');saved.commit=result.sha;await journal(saved);
      }catch(error){
        if(!sent || error.status>=400&&error.status<500&&error.status!==408){await journal({...saved,rejected:true});if([409,422].includes(error.status))error.kind='dictionary-conflict';throw error;}
        // A network failure may happen after the server committed. Never issue
        // a second POST until read-only reconciliation has established the result.
        if(!await confirm(saved).catch(()=>false))throw new Error('Gitee 上传结果尚未确认，本地修改保留；下次上传将先核查上次提交');
      }
      await confirm(saved);return saved;
    }
    return {publish,confirm};
  }
  async function prepare(client, repository, state, origins, language, getDomain, policy, options={}) {
    const pin = await client.readIndex(true), group = D.groupFor(origins[0], getDomain);
    const existing = await client.manifest(pin, group);
    const manifest = existing ? structuredClone(existing) : { schemaVersion: 1, minReaderVersion: 1, group, languages: {} };
    const old = manifest.languages[language];
    const remote = old ? await client.downloadGroup(pin, group, language, old.origins) : null;
    const records = D.recordsMap((remote?.files || []).flatMap(f => f.pack.records));
    for(const [id,row] of Object.entries(state?.synthetic || {}))if(!Object.hasOwn(records,id))records[id]=D.staticEntry(remote?.files,row);
    let comparison = D.mergeRecords(state?.baseline || {}, state?.local || {}, records);
    const reason=D.comparisonReason(state,records,pin.commit,!!remote),needsConfirmation=!!reason || !comparison.canInstall;
    if (needsConfirmation && !options.interactive) throw Object.assign(new Error(reason || '远端已有不同修改，请先检查更新并解决冲突'), { kind: 'dictionary-conflict' });
    const confirmation=needsConfirmation?{full:!!reason,reason:reason || '本地与仓库修改了相同词条',conflicts:comparison.conflicts.length}:null;
    const extraFiles={},localSnapshot=D.recordsMap((state?.files || []).flatMap(f=>f.pack.records));
    let preservedFiles=(old?.files || []).filter(f=>f.kind!=='entries');
    if(reason){
      Object.assign(localSnapshot,state?.baseline || {},state?.local || {});
      for(const id of Object.keys(records))if(!Object.hasOwn(localSnapshot,id))localSnapshot[id]=null;
      comparison={merged:localSnapshot,pending:Object.fromEntries(Object.entries(localSnapshot).filter(([key,value])=>C.canonical(value)!==C.canonical(records[key]??null))),conflicts:[],canInstall:true};
      preservedFiles=[];
      for(const file of state?.files || [])if(file.pack.kind!=='entries'){
        D.validatePackage(file.pack,{getDomain,policy});const raw=json(file.pack);
        const description={...file.description,sha256:await D.digest(raw),bytes:D.bytes(raw)};
        extraFiles[description.path]=raw;preservedFiles.push(description);
      }
    }else if(needsConfirmation)comparison=D.preferConflicts(comparison,'local');
    const changes = Object.entries(comparison.pending).map(([key, value]) => ({ key, before: records[key] ?? null, after: value }));
    if (!changes.length && !needsConfirmation) return { empty: true, pin };
    const rows = Object.entries(comparison.merged).map(([key, value]) => {
      if(value)return value;const [site,path,context,sourceText,targetLanguage]=JSON.parse(key);
      return {site,deleted:true,entry:{sourceText,path,context,targetLanguage,sourceLanguage:null,origin:'manual',category:'uncertain',action:'skip',translation:null}};
    });
    const allOrigins = [...new Set([...(reason?(state?.files || []).flatMap(f=>f.pack.origins):old?.origins || []), ...origins,...rows.map(r=>r.site)])].sort();
    const pack = { schemaVersion: 1, minReaderVersion: 1, group, targetLanguage: language, origins: allOrigins, kind: 'entries', records: rows, adapter: null };
    D.validatePackage(pack, { getDomain, policy });
    const raw = json(pack), path = `dictionaries/${group}/${language}/managed-entries.json`;
    const description = { id: 'managed-entries', path, sha256: await D.digest(raw), bytes: D.bytes(raw), kind: 'entries', origins: allOrigins, requires: [] };
    const files = [...preservedFiles, description];
    const content = { origins: allOrigins, files };
    manifest.languages[language] = { revision: await D.digest(content), ...content };
    await D.validateManifest(manifest, getDomain);
    const manifestRaw = json(manifest), manifestPath = `dictionaries/${group}/manifest.json`, index = structuredClone(pin.index);
    const item = { group, manifest: { path: manifestPath, bytes: D.bytes(manifestRaw), sha256: await D.digest(manifestRaw) }, languages: Object.fromEntries(Object.entries(manifest.languages).map(([k, v]) => [k, v.revision])) };
    index.groups = [...index.groups.filter(g => g.group !== group), item].sort((a,b) => a.group.localeCompare(b.group)); D.validateIndex(index);
    return { empty: false, parent: pin.commit, group, language, origins, expectedRevision: state?.revision || 0, changes, confirmation,
      files: { ...extraFiles,[path]: raw, [manifestPath]: manifestRaw, 'dictionaries/index.json': json(index) } };
  }
  function create({ repository, token, fetch: transport = globalThis.fetch, journal = async () => {}, beforeCommit=async()=>{} }) {
    if(R.provider(repository)==='gitee'){
      C.assert(typeof token==='string'&&token.length>0,'请在本设备配置 Gitee 写入凭据');
      return createGitee({repository,token,fetch:transport,journal,beforeCommit});
    }
    const config = R.configuration(repository), prefix = `https://api.github.com/repos/${config.owner}/${config.repo}`;
    C.assert(typeof token === 'string' && token.length > 0 && token.length <= 1000 && !/[\r\n]/.test(token), '请在本设备配置 GitHub 写入凭据');
    async function api(path, method = 'GET', body) {
      const r = await transport(prefix + path, { method, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(30000), headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      if(!r.ok)throw await E.fromResponse(r,{authenticated:true,write:true});
      const text = await r.text(); C.assert(D.bytes(text) < 2 * 1024 * 1024, 'GitHub 响应过大'); return JSON.parse(text);
    }
    const refPath = '/git/refs/heads/' + config.branch.split('/').map(encodeURIComponent).join('/');
    async function confirm(saved) {
      const head = await api(refPath);
      if (head.object.sha === saved.commit) return true;
      const comparison = await api('/compare/' + saved.commit + '...' + head.object.sha);
      return ['ahead', 'identical'].includes(comparison.status);
    }
    async function publish(draft) {
      validateDraft(draft);
      const head = await api(refPath); C.assert(head.object.sha === draft.parent, '远端已更新，请重新点击上传合并');
      const parent = await api('/git/commits/' + draft.parent);
      const tree = await api('/git/trees', 'POST', { base_tree: parent.tree.sha, tree: Object.entries(draft.files).map(([path, content]) => ({ path, mode: '100644', type: 'blob', content })) });
      const commit = await api('/git/commits', 'POST', { message: `Update dictionary ${draft.group} ${draft.language}`, tree: tree.sha, parents: [draft.parent] });
      const saved = { repository: config, parent: draft.parent, commit: commit.sha, group: draft.group, language: draft.language };
      await journal(saved); // Persist identity before the only branch mutation; retry confirms rather than re-publishes.
      try{
        await beforeCommit();
        const latest=await api(refPath);C.assert(latest.object.sha===draft.parent,'发布准备期间远端已变化，请重新点击上传合并');
      }catch(error){await journal({...saved,rejected:true});throw error;}
      try { await api(refPath, 'PATCH', { sha: commit.sha, force: false }); }
      catch (error) { if (!await confirm(saved).catch(() => false)){if(error.status>=400&&error.status<500&&error.status!==408)await journal({...saved,rejected:true});throw error;} }
      C.assert(await confirm(saved), '发布结果尚未确认，本地修改保留，请核查上次上传'); return saved;
    }
    return { publish, confirm };
  }
  const api = { prepare, create }; if (typeof module !== 'undefined') module.exports = api; else C.dictionaryPublish = api;
})();
