/* GPL-3.0-or-later. IndexedDB cache, one baseline and one candidate per group/language. */
(() => {
  'use strict';
  const C = typeof module !== 'undefined' ? require('./managed-core.js') : globalThis.WTCore;
  const D = typeof module !== 'undefined' ? require('./dictionary-core.js') : C.dictionary;
  const R = typeof module !== 'undefined' ? require('./dictionary-repository.js') : C.dictionaryRepository;
  const request = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  async function open({ name = 'wt-dictionaries-v1', indexedDB = globalThis.indexedDB, getDomain, policy } = {}) {
    C.assert(indexedDB && typeof getDomain === 'function' && policy, '本机词库存储依赖不可用');
    const opening = indexedDB.open(name, 1);
    opening.onupgradeneeded = () => { for (const id of ['groups', 'staging', 'meta']) if (!opening.result.objectStoreNames.contains(id)) opening.result.createObjectStore(id); };
    const db = await new Promise((resolve,reject)=>{let expired=false;const timer=setTimeout(()=>{expired=true;reject(new Error('本机词库数据库打开超时；旧数据保留，请关闭旧设置页后重试'));},8000);opening.onsuccess=()=>{clearTimeout(timer);if(expired)opening.result.close();else resolve(opening.result);};opening.onerror=()=>{clearTimeout(timer);reject(opening.error);};opening.onblocked=()=>{clearTimeout(timer);expired=true;reject(new Error('本机词库数据库被旧连接占用，请关闭旧设置页后重试'));};}); db.onversionchange = () => db.close();
    async function transaction(stores, mode, fn) {
      const tx = db.transaction(stores, mode), done = new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error || new Error('本机词库事务已回滚')); tx.onerror = () => {}; });
      try { const result = await fn(id => tx.objectStore(id)); await done; return result; }
      catch (error) { try { tx.abort(); } catch {} await done.catch(() => {}); throw error; }
    }
    const keyFor = (repository, group, language) => C.canonical([R.configuration(repository), D.groupId(group), C.language(language)]);
    async function setContext(value) {
      C.assert(value && Object.keys(value).length === 3 && value.repository && value.targetLanguage && Array.isArray(value.installations) && value.installations.length <= D.limits.origins, '安装上下文无效');
      const repository = R.configuration(value.repository), targetLanguage = C.language(value.targetLanguage);
      const installations = value.installations.map(s => { C.assert(s && Object.keys(s).length === 2 && Number.isSafeInteger(s.generation) && s.generation > 0, '安装代次无效'); return { origin: D.origin(s.origin), generation: s.generation }; }).sort((a, b) => a.origin.localeCompare(b.origin, 'en'));
      C.assert(new Set(installations.map(s => s.origin)).size === installations.length, '安装网址重复');
      const identity = C.canonical({ repository, targetLanguage, installations });
      return transaction(['meta'], 'readwrite', async store => {
        const previous = await request(store('meta').get('context'));
        const context = previous?.identity === identity ? previous : { repository, targetLanguage, installations, identity, revision: (previous?.revision || 0) + 1 };
        await request(store('meta').put(context, 'context')); return context;
      });
    }
    async function contextIn(store, expected) {
      const context = await request(store('meta').get('context'));
      C.assert(context && context.revision === expected, '网站、语言或仓库状态已改变，迟到结果未提交'); return context;
    }
    function applicable(context, candidate) {
      C.assert(C.canonical(context.repository) === C.canonical(candidate.repository) && context.targetLanguage === candidate.targetLanguage, '候选词库上下文已改变');
      const wanted = context.installations.filter(s => D.groupFor(s.origin, getDomain) === candidate.group).map(s => s.origin).sort();
      C.assert(C.canonical(wanted) === C.canonical([...candidate.installedOrigins].sort()), '分组安装清单已改变');
    }
    async function read(repository, group, language) { return transaction(['groups'], 'readonly', store => request(store('groups').get(keyFor(repository, group, language)))); }
    async function validateCandidate(candidate) {
      C.assert(candidate && Object.keys(candidate).every(k => ['schemaVersion', 'repository', 'commit', 'group', 'targetLanguage', 'installedOrigins', 'revision', 'missing', 'files'].includes(k)) && candidate.schemaVersion === D.VERSION && /^[a-f0-9]{40}$/.test(candidate.commit) && /^[a-f0-9]{64}$/.test(candidate.revision) && Array.isArray(candidate.files) && candidate.files.length > 0 && candidate.files.length <= 400 && Array.isArray(candidate.installedOrigins) && candidate.installedOrigins.length > 0 && candidate.installedOrigins.length <= D.limits.origins, '词库候选包无效');
      C.assert(Array.isArray(candidate.missing) && candidate.missing.every(o => candidate.installedOrigins.includes(o)), '候选包缺失网址声明无效');
      const rows = []; let size = 0; const seen = new Set();
      const cleanFiles = [];
      for (const { description, pack, raw } of candidate.files) {
        const verified = await D.verifyFile(raw, description, { getDomain, policy }); D.path(description.path, candidate.group, candidate.targetLanguage);
        C.assert(C.canonical(pack) === C.canonical(verified), '候选词库在校验后被改变'); cleanFiles.push({ description, pack: verified });
        C.assert(pack.group === candidate.group && pack.targetLanguage === candidate.targetLanguage && description.kind === pack.kind && C.canonical(description.origins) === C.canonical(pack.origins), '候选词库范围无效');
        C.assert(!seen.has(description.path) && pack.origins.some(o => candidate.installedOrigins.includes(o)), '候选文件重复或不属于已安装网址'); seen.add(description.path);
        size += D.bytes(pack); rows.push(...pack.records.filter(r => candidate.installedOrigins.includes(r.site)));
      }
      C.assert(size <= D.limits.groupBytes && rows.length <= D.limits.entries, '候选分组超过存储容量');
      const selectionRevision = await D.digest({ group: candidate.group, language: candidate.targetLanguage, origins: [...candidate.installedOrigins].sort(), files: cleanFiles.map(f => f.description) });
      C.assert(candidate.revision === selectionRevision, '候选分组修订不匹配');
      return { incoming: D.recordsMap(rows), candidate: { ...candidate, files: cleanFiles } };
    }
    async function commit(store, stage, previous) {
      const next = { repository: stage.candidate.repository, group: stage.candidate.group, targetLanguage: stage.candidate.targetLanguage,
        commit: stage.candidate.commit, contentRevision: stage.candidate.revision, revision: (previous?.revision || 0) + 1,
        seenCommits: [...new Set([...(previous?.seenCommits || []), ...(previous?.commit ? [previous.commit] : []), stage.candidate.commit])].slice(-100),
        missing: stage.candidate.missing, synthetic: previous?.synthetic || {}, baseline: stage.remoteBase, local: stage.comparison.pending, files: stage.candidate.files, installedOrigins: stage.candidate.installedOrigins };
      await request(store('groups').put(next, stage.key)); await request(store('staging').delete(stage.key)); return { installed: true, revision: next.revision, conflicts: [] };
    }
    async function beginDownload(repository, group, language, expectedContext) {
      const key = keyFor(repository, group, language);
      return transaction(['meta'], 'readwrite', async store => {
        await contextIn(store, expectedContext);
        const ticket = crypto.randomUUID(); await request(store('meta').put(ticket, 'download:' + key)); return ticket;
      });
    }
    async function pending(repository, group, language) {
      return transaction(['staging'], 'readonly', store => request(store('staging').get(keyFor(repository, group, language))));
    }
    async function install(candidate, expectedContext, ticket) {
      const validated = await validateCandidate(candidate), incoming = validated.incoming;
      candidate = validated.candidate;
      const key = keyFor(candidate.repository, candidate.group, candidate.targetLanguage);
      return transaction(['meta', 'groups', 'staging'], 'readwrite', async store => {
        const context = await contextIn(store, expectedContext); applicable(context, candidate);
        if (ticket) C.assert(await request(store('meta').get('download:' + key)) === ticket, '此下载已被较新的任务取代');
        const previous = await request(store('groups').get(key));
        C.assert(!previous || previous.commit === candidate.commit || !(previous.seenCommits || []).includes(candidate.commit), '旧版本下载迟到，未覆盖已安装新版');
        const remoteBase = { ...(previous?.baseline || {}), ...incoming };
        for(const [id,row] of Object.entries(previous?.synthetic || {}))if(!Object.hasOwn(incoming,id))remoteBase[id]=D.staticEntry(candidate.files,row);
        const comparison = D.mergeRecords(previous?.baseline || {}, previous?.local || {}, remoteBase);
        const stage = { key, candidate, ticket, expectedContext, expectedRevision: previous?.revision || 0, remoteBase, comparison };
        if (comparison.canInstall) return commit(store, stage, previous);
        await request(store('staging').put(stage, key)); return { installed: false, conflicts: comparison.conflicts };
      });
    }
    async function edit(repository,group,language,row,expectedContext){return editBatch(repository,group,language,[row],expectedContext);}
    async function editBatch(repository, group, language, rows, expectedContext) {
      C.assert(Array.isArray(rows)&&rows.length<=D.limits.entries,'本机词条批次无效');
      const key = keyFor(repository, group, language);
      return transaction(['meta', 'groups'], 'readwrite', async store => {
        const context = await contextIn(store, expectedContext);
        C.assert(context.targetLanguage === language && C.canonical(context.repository) === C.canonical(R.configuration(repository)), '编辑上下文已改变');
        const origins=context.installations.map(s=>s.origin).filter(o=>D.groupFor(o,getDomain)===group);for(const row of rows)D.validateRecord(row,origins,language);
        const state = await request(store('groups').get(key)) || { repository, group, targetLanguage: language, baseline: {}, local: {}, revision: 0, files: [], installedOrigins: [] };
        for(const row of rows){
        if(!Object.hasOwn(state.baseline,D.entryIdentity(row))){const base=D.staticEntry(state.files,row);if(base){state.baseline[D.entryIdentity(row)]=base;state.synthetic||={};state.synthetic[D.entryIdentity(row)]=base;}}
        const identity=D.entryIdentity(row),value=row.deleted?null:structuredClone(row);
        if(Object.hasOwn(state.baseline,identity)&&C.canonical(state.baseline[identity])===C.canonical(value))delete state.local[identity];
        else state.local[identity]=value;
        }state.revision++;
        C.assert(Object.keys(state.local).length <= D.limits.entries && D.bytes(state.local) <= D.limits.groupBytes, '本地修改层超过容量');
        await request(store('groups').put(state, key)); return state.revision;
      });
    }
    async function resolve(repository, group, language, id, choice, edited, expectedContext) {
      const key = keyFor(repository, group, language);
      return transaction(['meta', 'groups', 'staging'], 'readwrite', async store => {
        const context = await contextIn(store, expectedContext), stage = await request(store('staging').get(key)), previous = await request(store('groups').get(key));
        if (stage?.ticket) C.assert(await request(store('meta').get('download:' + key)) === stage.ticket, '冲突候选已被较新的任务取代');
        C.assert(stage && stage.expectedContext === expectedContext && stage.expectedRevision === (previous?.revision || 0), '冲突期间出现新修改，请重新合并'); applicable(context, stage.candidate);
        if (choice === 'edited' && edited !== null) D.validateRecord(edited, stage.candidate.installedOrigins, language);
        stage.comparison = D.resolveConflict(stage.comparison, id, choice, edited);
        if (stage.comparison.canInstall) return commit(store, stage, previous);
        await request(store('staging').put(stage, key)); return { installed: false, conflicts: stage.comparison.conflicts };
      });
    }

    async function resetLocal(origin,repository,archiveId='removed') {
      D.origin(origin);
      return transaction(['groups','staging','meta'], 'readwrite', async store=>{
        const keys=await request(store('groups').getAllKeys());
        for(const key of keys){const state=await request(store('groups').get(key));if(repository&&C.canonical(state.repository)!==C.canonical(R.configuration(repository)))continue;let changed=false;const archived={};
          for(const id of Object.keys(state.local || {}))if(JSON.parse(id)[0]===origin){archived[id]=state.local[id];delete state.local[id];changed=true;}
          if(changed){const archiveKey='archive:'+C.canonical([state.repository,origin,state.targetLanguage,archiveId]),old=await request(store('meta').get(archiveKey));await request(store('meta').put({repository:state.repository,origin,language:state.targetLanguage,local:{...archived,...old?.local}},archiveKey));state.revision++;await request(store('groups').put(state,key));await request(store('staging').delete(key));}
        }
      });
    }

    return Object.freeze({ setContext, read, edit, editBatch, install, beginDownload, pending, resolve, resetLocal, close: () => db.close() });
  }
  const api = Object.freeze({ open });
  if (typeof module !== 'undefined') module.exports = api;
  else C.dictionaryStore = api;
})();
