/* GPL-3.0-or-later. Read-only GitHub transport used by the background runtime. Publishing is separate. */
(() => {
  'use strict';
  const C = typeof module !== 'undefined' ? require('./managed-core.js') : globalThis.WTCore;
  const D = typeof module !== 'undefined' ? require('./dictionary-core.js') : C.dictionary;
  const E=typeof module!=='undefined'?require('./dictionary-errors.js'):C.dictionaryErrors;
  const commitId = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
  function configuration(value) {
    C.assert(value && Object.keys(value).every(k => ['owner', 'repo', 'branch'].includes(k)), '词库仓库配置无效');
    C.assert(typeof value.owner === 'string' && typeof value.repo === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9-]{0,99}$/.test(value.owner) && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(value.repo), '词库仓库名称无效');
    C.assert(typeof value.branch === 'string' && value.branch.length <= 200 && /^[a-zA-Z0-9][a-zA-Z0-9_./-]*$/.test(value.branch) && !/\.\.|\/\/|\/$|\.lock(?:\/|$)/.test(value.branch), '词库分支无效');
    return Object.freeze({ ...value });
  }
  function create({ repository, policy, getDomain, fetch: transport = globalThis.fetch, token = '', now = Date.now }) {
    const config = configuration(repository), prefix = `https://api.github.com/repos/${config.owner}/${config.repo}`;
    C.assert(typeof token === 'string' && token.length <= 1000 && !/[\r\n]/.test(token), '本机仓库凭据无效');
    let cached, flight, blockedUntil=0, blockedError;
    const manifests = new Map();
    async function request(suffix, maximum, raw = false) {
      if(blockedError&&now()<blockedUntil)throw blockedError;
      let received=false;const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 30000);
      try {
        const response = await transport(prefix + suffix, { method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal,
          headers: { Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(token ? { Authorization: 'Bearer ' + token } : {}) } });
        received=true;
        if (!response.ok) {
          const error=await E.fromResponse(response,{authenticated:!!token,now:now()});
          blockedError=error;blockedUntil=error.kind==='authorization'||error.kind==='not-found'?Infinity:error.retryAt||now()+30000;throw error;
        }
        C.assert(Number(response.headers.get('content-length') || 0) <= maximum && response.body, 'GitHub 响应过大或为空');
        const reader = response.body.getReader(), chunks = []; let size = 0;
        try {
          while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; C.assert(size <= maximum, 'GitHub 响应超过大小限制'); chunks.push(value); }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        const data = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
        const result = new TextDecoder('utf-8', { fatal: true }).decode(data);
        return raw ? result : JSON.parse(result);
      } catch(e){if(controller.signal.aborted||!received){const error=new Error(controller.signal.aborted?'GitHub 请求超时；本机词库保留，稍后自动重试':'GitHub 网络暂不可用；本机词库保留，稍后自动重试');Object.assign(error,{kind:'network',retryAt:now()+60000});blockedError=error;blockedUntil=error.retryAt;throw error;}throw e;}
      finally { clearTimeout(timeout); }
    }
    const file = (path, commit, maximum) => {
      C.assert(commitId(commit), '必须固定完整的远端提交');
      C.assert(path === 'dictionaries/index.json' || /^dictionaries\/[a-z0-9][a-z0-9.-]*\/(?:manifest\.json|[a-zA-Z0-9-]+\/[a-z0-9][a-z0-9.-]*\.json)$/.test(path) && !path.includes('..'), '只允许下载 dictionaries 内的协议文件');
      return request('/contents/' + path.split('/').map(encodeURIComponent).join('/') + '?ref=' + commit, maximum, true);
    };
    async function readIndex(force = false) {
      if(force&&blockedError&&['authorization','not-found'].includes(blockedError.kind)){blockedUntil=0;blockedError=null;}
      if (force) cached = null;
      if (cached && now() - cached.checkedAt < 60000) return cached;
      if (!flight) flight = (async () => {
        const ref = await request('/git/ref/heads/' + config.branch.split('/').map(encodeURIComponent).join('/'), 20000);
        C.assert(ref.ref === 'refs/heads/' + config.branch && ref.object?.type === 'commit' && commitId(ref.object.sha), 'GitHub 分支没有返回有效的固定提交');
        const commit = ref.object.sha, index = D.validateIndex(JSON.parse(await file('dictionaries/index.json', commit, D.limits.indexBytes)));
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
  const api = Object.freeze({ configuration, create });
  if (typeof module !== 'undefined') module.exports = api;
  else C.dictionaryRepository = api;
})();
