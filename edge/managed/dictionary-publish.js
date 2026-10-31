/* GPL-3.0-or-later. Publish validated data in one non-forced Git commit. */
(() => {
  'use strict';
  const C = typeof module !== 'undefined' ? require('./managed-core.js') : WTCore;
  const D = typeof module !== 'undefined' ? require('./dictionary-core.js') : C.dictionary;
  const R = typeof module !== 'undefined' ? require('./dictionary-repository.js') : C.dictionaryRepository;
  const E=typeof module!=='undefined'?require('./dictionary-errors.js'):C.dictionaryErrors;
  const json = value => JSON.stringify(value, null, 2) + '\n';
  async function prepare(client, repository, state, origins, language, getDomain, policy) {
    const pin = await client.readIndex(true), group = D.groupFor(origins[0], getDomain);
    const existing = await client.manifest(pin, group);
    const manifest = existing ? structuredClone(existing) : { schemaVersion: 1, minReaderVersion: 1, group, languages: {} };
    const old = manifest.languages[language];
    const remote = old ? await client.downloadGroup(pin, group, language, old.origins) : null;
    const records = D.recordsMap((remote?.files || []).flatMap(f => f.pack.records));
    for(const [id,row] of Object.entries(state?.synthetic || {}))if(!Object.hasOwn(records,id))records[id]=D.staticEntry(remote?.files,row);
    const comparison = D.mergeRecords(state?.baseline || {}, state?.local || {}, records);
    C.assert(comparison.canInstall, '远端已有不同修改，请先检查更新并解决冲突');
    const changes = Object.entries(comparison.pending).map(([key, value]) => ({ key, before: records[key] ?? null, after: value }));
    if (!changes.length) return { empty: true, pin };
    const rows = Object.entries(comparison.merged).map(([key, value]) => {
      if(value)return value;const [site,path,context,sourceText,targetLanguage]=JSON.parse(key);
      return {site,deleted:true,entry:{sourceText,path,context,targetLanguage,sourceLanguage:null,origin:'manual',category:'uncertain',action:'skip',translation:null}};
    });
    const allOrigins = [...new Set([...(old?.origins || []), ...origins])].sort();
    const pack = { schemaVersion: 1, minReaderVersion: 1, group, targetLanguage: language, origins: allOrigins, kind: 'entries', records: rows, adapter: null };
    D.validatePackage(pack, { getDomain, policy });
    const raw = json(pack), path = `dictionaries/${group}/${language}/managed-entries.json`;
    const description = { id: 'managed-entries', path, sha256: await D.digest(raw), bytes: D.bytes(raw), kind: 'entries', origins: allOrigins, requires: [] };
    const files = [...(old?.files || []).filter(f => f.kind !== 'entries'), description];
    const content = { origins: allOrigins, files };
    manifest.languages[language] = { revision: await D.digest(content), ...content };
    await D.validateManifest(manifest, getDomain);
    const manifestRaw = json(manifest), manifestPath = `dictionaries/${group}/manifest.json`, index = structuredClone(pin.index);
    const item = { group, manifest: { path: manifestPath, bytes: D.bytes(manifestRaw), sha256: await D.digest(manifestRaw) }, languages: Object.fromEntries(Object.entries(manifest.languages).map(([k, v]) => [k, v.revision])) };
    index.groups = [...index.groups.filter(g => g.group !== group), item].sort((a,b) => a.group.localeCompare(b.group)); D.validateIndex(index);
    return { empty: false, parent: pin.commit, group, language, origins, expectedRevision: state?.revision || 0, changes,
      files: { [path]: raw, [manifestPath]: manifestRaw, 'dictionaries/index.json': json(index) } };
  }
  function create({ repository, token, fetch: transport = globalThis.fetch, journal = async () => {}, beforeCommit=async()=>{} }) {
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
      C.assert(draft && /^[a-f0-9]{40}$/.test(draft.parent) && Object.keys(draft.files).length === 3, '上传预览无效');
      for (const [path, raw] of Object.entries(draft.files)) { C.assert(path === 'dictionaries/index.json' || D.path(path, draft.group, path.endsWith('/manifest.json') ? null : draft.language), '上传越界'); C.assert(typeof raw === 'string' && D.bytes(raw) <= D.limits.packageBytes, '上传内容过大'); }
      const head = await api(refPath); C.assert(head.object.sha === draft.parent, '远端已更新，请重新预览合并');
      const parent = await api('/git/commits/' + draft.parent);
      const tree = await api('/git/trees', 'POST', { base_tree: parent.tree.sha, tree: Object.entries(draft.files).map(([path, content]) => ({ path, mode: '100644', type: 'blob', content })) });
      const commit = await api('/git/commits', 'POST', { message: `Update dictionary ${draft.group} ${draft.language}`, tree: tree.sha, parents: [draft.parent] });
      const saved = { repository: config, parent: draft.parent, commit: commit.sha, group: draft.group, language: draft.language };
      await journal(saved); // Persist identity before the only branch mutation; retry confirms rather than re-publishes.
      await beforeCommit();
      const latest=await api(refPath);C.assert(latest.object.sha===draft.parent,'发布准备期间远端已变化，请重新预览合并');
      try { await api(refPath, 'PATCH', { sha: commit.sha, force: false }); }
      catch (error) { if (!await confirm(saved).catch(() => false)) throw error; }
      C.assert(await confirm(saved), '发布结果尚未确认，本地修改保留，请核查上次上传'); return saved;
    }
    return { publish, confirm };
  }
  const api = { prepare, create }; if (typeof module !== 'undefined') module.exports = api; else C.dictionaryPublish = api;
})();
