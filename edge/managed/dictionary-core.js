/* 网站翻译插件 - GPL-3.0-or-later. Data protocol; no network or code evaluation. */
(() => {
  'use strict';
  const C = typeof module !== 'undefined' ? require('./managed-core.js') : globalThis.WTCore;
  const VERSION = 1;
  const limits = Object.freeze({ indexBytes: 512 * 1024, manifestBytes: 512 * 1024, packageBytes: 12 * 1024 * 1024,
    groupBytes: 32 * 1024 * 1024, entries: 50000, graphNodes: 50000, graphEdges: 200000, origins: 200,
    syncBytes: 90000, syncItemBytes: 7000, syncRecords: 1000 });
  const own = (o, key) => Object.hasOwn(o, key);
  const dict = () => Object.create(null);
  const bytes = value => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)).length;
  const isString = (s, max = 4096) => typeof s === 'string' && s.length > 0 && s.length <= max;
  const sha = s => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
  function object(o, allowed, required = allowed) {
    C.assert(o && typeof o === 'object' && !Array.isArray(o) && [Object.prototype, null].includes(Object.getPrototypeOf(o)), '数据对象无效');
    C.assert(Object.keys(o).every(k => allowed.includes(k)) && required.every(k => own(o, k)), '数据包含未知字段或缺少字段');
  }
  function header(o) {
    C.assert(o.schemaVersion === VERSION && Number.isInteger(o.minReaderVersion) && o.minReaderVersion > 0 && o.minReaderVersion <= VERSION, '词库协议不兼容，请升级插件');
  }
  function origin(value) {
    C.assert(isString(value, 300), '词库网址无效');
    const u = new URL(value);
    C.assert(['https:', 'http:'].includes(u.protocol) && u.origin === value && !u.username && !u.password, '词库网址必须为规范 origin');
    return value;
  }
  function groupFor(value, getDomain) {
    const u = new URL(origin(value));
    C.assert(typeof getDomain === 'function', '主域名解析器不可用');
    const domain = getDomain(u.hostname, { allowPrivateDomains: true }) || u.hostname;
    return /^[a-z0-9][a-z0-9.-]{0,252}$/.test(domain) ? domain : stableId(domain);
  }
  function stableId(value) { return 'o-' + [...new TextEncoder().encode(value)].map(n => n.toString(16).padStart(2, '0')).join(''); }
  function originId(value) {
    const u = new URL(origin(value));
    return u.protocol === 'https:' && !u.port && /^[a-z0-9][a-z0-9.-]{0,252}$/.test(u.hostname) ? u.hostname : stableId(value);
  }
  function groupId(value) { C.assert(isString(value, 700) && /^[a-z0-9][a-z0-9.-]*$/.test(value) && !value.includes('..'), '主域名目录无效'); return value; }
  function path(value, group, language) {
    C.assert(isString(value, 1000) && /^[a-zA-Z0-9./-]+$/.test(value) && !value.includes('..') && !value.includes('//'), '词库文件路径无效');
    const parts = value.split('/');
    C.assert(parts[0] === 'dictionaries' && parts[1] === groupId(group), '词库文件越出分组');
    C.assert(language ? parts.length === 4 && parts[2] === C.language(language) && /^[a-z0-9][a-z0-9.-]*\.json$/.test(parts[3]) : parts.length === 3 && parts[2] === 'manifest.json', '词库文件范围无效');
    return value;
  }
  const same = (a, b) => C.canonical(a) === C.canonical(b);
  async function digest(value) {
    const data = new TextEncoder().encode(typeof value === 'string' ? value : C.canonical(value));
    return [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', data))].map(n => n.toString(16).padStart(2, '0')).join('');
  }
  function origins(values, group, getDomain) {
    C.assert(Array.isArray(values) && values.length > 0 && values.length <= limits.origins && new Set(values).size === values.length, '词库网址列表无效');
    for (const value of values) C.assert(groupFor(value, getDomain) === group, '词库网址不属于该主域名');
  }
  function descriptor(d, group, language, getDomain) {
    object(d, ['id', 'path', 'sha256', 'bytes', 'kind', 'origins', 'requires']);
    C.assert(isString(d.id, 700) && /^[a-z0-9][a-z0-9.-]*$/.test(d.id) && sha(d.sha256), '词库文件标识或哈希无效');
    path(d.path, group, language);
    C.assert(d.path.endsWith('/' + d.id + '.json') && Number.isInteger(d.bytes) && d.bytes > 0 && d.bytes <= limits.packageBytes, '词库文件大小无效');
    C.assert(['entries', 'site', 'github'].includes(d.kind), '词库类型无效');
    origins(d.origins, group, getDomain);
    C.assert(Array.isArray(d.requires) && d.requires.length <= 100 && new Set(d.requires).size === d.requires.length && d.requires.every(id => isString(id, 700) && id !== d.id), '词库依赖无效');
  }
  function validateIndex(index) {
    object(index, ['schemaVersion', 'minReaderVersion', 'groups']); header(index);
    C.assert(bytes(index) <= limits.indexBytes && Array.isArray(index.groups) && index.groups.length <= 1000, '总索引过大');
    const seen = new Set();
    for (const g of index.groups) {
      object(g, ['group', 'manifest', 'languages']); groupId(g.group);
      C.assert(!seen.has(g.group), '总索引重复分组'); seen.add(g.group);
      object(g.manifest, ['path', 'sha256', 'bytes']); path(g.manifest.path, g.group);
      C.assert(sha(g.manifest.sha256) && Number.isInteger(g.manifest.bytes) && g.manifest.bytes > 0 && g.manifest.bytes <= limits.manifestBytes, '分组清单描述无效');
      C.assert(g.languages && typeof g.languages === 'object' && !Array.isArray(g.languages) && Object.keys(g.languages).length > 0 && Object.keys(g.languages).length <= 100, '语言索引无效');
      for (const [lang, revision] of Object.entries(g.languages)) C.assert(C.language(lang) === lang && sha(revision), '语言修订无效');
    }
    return index;
  }
  async function validateManifest(manifest, getDomain) {
    object(manifest, ['schemaVersion', 'minReaderVersion', 'group', 'languages']); header(manifest); groupId(manifest.group);
    C.assert(bytes(manifest) <= limits.manifestBytes && manifest.languages && typeof manifest.languages === 'object' && !Array.isArray(manifest.languages), '分组清单过大或无效');
    C.assert(Object.keys(manifest.languages).length > 0 && Object.keys(manifest.languages).length <= 100, '分组语言无效');
    for (const [lang, data] of Object.entries(manifest.languages)) {
      C.assert(C.language(lang) === lang, '语言必须为规范 BCP 47'); object(data, ['revision', 'origins', 'files']);
      C.assert(sha(data.revision) && data.revision === await digest({ origins: data.origins, files: data.files }), '语言内容修订不匹配');
      origins(data.origins, manifest.group, getDomain);
      C.assert(Array.isArray(data.files) && data.files.length > 0 && data.files.length <= 400, '词库文件列表无效');
      const files = new Map(); let size = 0;
      for (const file of data.files) {
        descriptor(file, manifest.group, lang, getDomain); size += file.bytes;
        C.assert(!files.has(file.id) && file.origins.every(o => data.origins.includes(o)), '重复文件或越界网址'); files.set(file.id, file);
      }
      C.assert(size <= limits.groupBytes && data.origins.every(o => data.files.some(f => f.origins.includes(o))), '分组容量或网址覆盖无效');
      const visited = new Set();
      const visit = (id, stack = new Set()) => {
        C.assert(files.has(id) && !stack.has(id), '缺少词库依赖或依赖成环');
        if (visited.has(id)) return;
        const next = new Set(stack).add(id);
        for (const dependency of files.get(id).requires) {
          C.assert(files.has(dependency) && files.get(id).origins.every(o => files.get(dependency).origins.includes(o)), '共享依赖扩大网址范围');
          visit(dependency, next);
        }
        visited.add(id);
      };
      for (const id of files.keys()) visit(id);
    }
    return manifest;
  }
  function selectFiles(manifest, targetLanguage, installedOrigins) {
    const data = manifest.languages[C.language(targetLanguage)];
    if (!data) return [];
    const byId = new Map(data.files.map(f => [f.id, f])), chosen = new Set();
    const add = id => { if (chosen.has(id)) return; C.assert(byId.has(id), '缺少依赖'); chosen.add(id); byId.get(id).requires.forEach(add); };
    for (const file of data.files) if (file.origins.some(o => installedOrigins.includes(o))) add(file.id);
    return data.files.filter(f => chosen.has(f.id));
  }
  const entryFields = ['sourceText', 'context', 'path', 'sourceLanguage', 'targetLanguage', 'category', 'action', 'translation', 'origin', 'userSelected'];
  function validateRecord(row, allowedOrigins, language) {
    object(row, ['site', 'entry', 'deleted'], ['site', 'entry']);
    C.assert(allowedOrigins.includes(origin(row.site)) && (!own(row, 'deleted') || row.deleted === true), '词条网址或删除标记无效');
    object(row.entry, entryFields, entryFields.filter(k => k !== 'userSelected'));
    C.validEntry(row.entry); C.assert(row.entry.targetLanguage === language, '词条目标语言越界');
    return row;
  }
  const entryIdentity = row => C.canonical([origin(row.site), row.entry.path, row.entry.context, row.entry.sourceText, row.entry.targetLanguage]);
  function validateGraph(graph, policy) {
    object(graph, ['root', 'nodes', 'policyRevision']);
    C.assert(policy && sha(policy.revision) && graph.policyRevision === policy.revision, '适配规则需要兼容的本地白名单');
    C.assert(Array.isArray(graph.nodes) && graph.nodes.length > 0 && graph.nodes.length <= limits.graphNodes, '规则对象数量无效');
    let edges = 0; const visiting = new Set(), visited = new Set();
    function token(v, depth) {
      C.assert(depth <= 40 && ++edges <= limits.graphEdges, '规则嵌套或数量超限');
      if (v === null || typeof v === 'boolean') return;
      if (typeof v === 'number') { C.assert(Number.isFinite(v), '规则数字无效'); return; }
      if (typeof v === 'string') { C.assert(v.length <= 20000, '规则文本过长'); return; }
      C.assert(v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1, '规则值无效');
      if (own(v, 'ref')) {
        C.assert(Number.isInteger(v.ref) && v.ref >= 0 && v.ref < graph.nodes.length && !visiting.has(v.ref), '规则引用无效或成环');
        if (visited.has(v.ref)) return;
        visiting.add(v.ref); const n = graph.nodes[v.ref];
        object(n, ['type', 'values']); C.assert(['object', 'array'].includes(n.type) && Array.isArray(n.values), '规则节点无效');
        if (n.type === 'object') {
          const seen = new Set();
          for (const pair of n.values) {
            C.assert(Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string' && pair[0].length <= 20000 && !['__proto__', 'prototype', 'constructor'].includes(pair[0]) && !seen.has(pair[0]), '规则对象字段无效');
            seen.add(pair[0]); token(pair[1], depth + 1);
          }
        } else for (const item of n.values) token(item, depth + 1);
        visiting.delete(v.ref); visited.add(v.ref); return;
      }
      if (own(v, 'regexp')) {
        object(v.regexp, ['id', 'source', 'flags']);
        C.assert(own(policy.regexps, v.regexp.id) && same(policy.regexps[v.regexp.id], v.regexp), '正则不在本地受审白名单'); return;
      }
      C.assert(own(v, 'handler') && typeof v.handler === 'string' && policy.handlers.includes(v.handler), '处理器不在本地白名单');
    }
    token(graph.root, 0);
    C.assert(visited.size === graph.nodes.length, '规则包含不可达对象');
    return graph;
  }
  // Freeze executable scope/configuration while allowing translation maps to grow.
  // A changed selector, page matcher, attribute, handler or rule order needs local review.
  function adapterShape(graph, kind) {
    let visits = 0;
    const node = token => token && typeof token === 'object' && own(token, 'ref') ? graph.nodes[token.ref] : null;
    function project(token, field = '', depth = 0) {
      C.assert(++visits <= 500000 && depth <= 40, '适配范围过于复杂');
      const n = node(token);
      if (['static', 'dictionary', 'reactGlobalNavLabels'].includes(field)) {
        C.assert(n?.type === 'object' && n.values.every(p => typeof p[0] === 'string' && p[0].length > 0 && typeof p[1] === 'string' && p[1].length <= 20000), '静态词库必须为文本映射');
        return { translations: true };
      }
      if (!n) return token;
      if (n.type === 'object') return { object: n.values.map(([key, v]) => [key, project(v, key, depth + 1)]) };
      if (kind === 'github' && ['regexp', 'time-regexp', 'selector'].includes(field)) {
        return { rules: n.values.map(v => {
          const pair = node(v); C.assert(pair?.type === 'array' && pair.values.length === 2, '翻译规则必须为有序二元组');
          const [pattern, replacement] = pair.values;
          C.assert(typeof pattern === 'string' || pattern && own(pattern, 'regexp'), '规则匹配器无效');
          C.assert(typeof replacement === 'string' || replacement && own(replacement, 'handler'), '规则替换值无效');
          return [pattern, typeof replacement === 'string' ? { translation: true } : replacement];
        }) };
      }
      if (kind === 'site' && field === 'regexp') {
        return { rules: n.values.map(v => {
          const rule = node(v); C.assert(rule?.type === 'object', '网站正则规则无效');
          return rule.values.map(([key, item]) => [key, key === 'replacement' && typeof item === 'string' ? { translation: true } : project(item, key, depth + 1)]);
        }) };
      }
      return { array: n.values.map(v => project(v, '', depth + 1)) };
    }
    return project(graph.root);
  }
  function validatePackage(pack, { getDomain, policy } = {}) {
    object(pack, ['schemaVersion', 'minReaderVersion', 'group', 'targetLanguage', 'origins', 'kind', 'records', 'adapter']); header(pack);
    groupId(pack.group); C.assert(C.language(pack.targetLanguage) === pack.targetLanguage, '词库目标语言无效');
    C.assert(bytes(pack) <= limits.packageBytes, '词库超过容量限制'); origins(pack.origins, pack.group, getDomain);
    C.assert(['entries', 'site', 'github'].includes(pack.kind) && Array.isArray(pack.records) && pack.records.length <= limits.entries, '词条数据无效');
    const seen = new Set();
    for (const row of pack.records) { validateRecord(row, pack.origins, pack.targetLanguage); const key = entryIdentity(row); C.assert(!seen.has(key), '词条身份重复'); seen.add(key); }
    C.assert(pack.kind === 'entries' ? pack.adapter === null : pack.targetLanguage === 'zh-Hans' && pack.adapter !== null, '适配器语言或字段无效');
    if (pack.adapter) {
      validateGraph(pack.adapter, policy);
      const scope = pack.kind + ':' + C.canonical(pack.origins);
      C.assert(policy.scopes && own(policy.scopes, scope) && same(adapterShape(pack.adapter, pack.kind), policy.scopes[scope]), '词库改变了未经本地审阅的页面或规则范围');
    }
    return pack;
  }
  async function verifyFile(raw, description, options) {
    C.assert(description && typeof description.path === 'string', '词库文件描述无效');
    const segments = description.path.split('/');
    descriptor(description, segments[1], segments[2], options?.getDomain);
    C.assert(typeof raw === 'string' && bytes(raw) <= limits.packageBytes && bytes(raw) === description.bytes && await digest(raw) === description.sha256, '词库文件大小或 SHA-256 不匹配');
    const pack = validatePackage(JSON.parse(raw), options);
    C.assert(pack.group === segments[1] && pack.targetLanguage === segments[2] && pack.kind === description.kind && same(pack.origins, description.origins), '词库与分组清单不匹配'); return pack;
  }
  function recordsMap(records) { const result = dict(); for (const row of records) { const key = entryIdentity(row); C.assert(!own(result, key), '词条重复'); result[key] = row.deleted ? null : structuredClone(row); } return result; }
  // Associate an exact local source with an unambiguous legacy static translation.
  // Ambiguous page-specific meanings stay local and require explicit review.
  function staticEntry(files, row) {
    const values = new Set();
    for(const {pack} of files || []) {
      if(!pack.adapter || !pack.origins.includes(row.site))continue;
      const graph=pack.adapter;
      for(const node of graph.nodes)if(node.type==='object')for(const [field,token] of node.values){
        if(!['static','dictionary','reactGlobalNavLabels'].includes(field) || !token || typeof token.ref!=='number')continue;
        const map=graph.nodes[token.ref];if(map?.type!=='object')continue;
        for(const [source,target] of map.values)if(source===row.entry.sourceText && typeof target==='string')values.add(target);
      }
    }
    if(values.size!==1)return null;
    const entry={...row.entry,translation:[...values][0],origin:'ai',category:'ui',action:'translate'};delete entry.userSelected;
    try{C.validEntry(entry);}catch{return null;}return {site:row.site,entry};
  }
  // Missing records mean no new statement. Only explicit null is a deletion.
  function mergeRecords(base, local, remote) {
    const merged = dict(), pending = dict(), conflicts = [];
    for (const key of new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])) {
      const b = base[key], l = own(local, key) ? local[key] : b, r = own(remote, key) ? remote[key] : b;
      let result;
      if (same(l, r)) result = l;
      else if (same(l, b)) result = r;
      else if (same(r, b)) result = l;
      else { result = l; conflicts.push({ key, base: b ?? null, local: l ?? null, remote: r ?? null, type: l === null || r === null ? 'delete-modify' : 'modify-modify' }); }
      if (result !== undefined) merged[key] = structuredClone(result);
      if (!same(result, r) && result !== undefined) pending[key] = structuredClone(result);
    }
    return { merged, pending, conflicts, canInstall: conflicts.length === 0 };
  }
  function resolveConflict(comparison, key, choice, edited) {
    const conflict = comparison.conflicts.find(c => c.key === key); C.assert(conflict, '冲突不存在');
    C.assert(['local', 'remote', 'edited'].includes(choice), '冲突选择无效');
    const result = structuredClone(comparison), value = choice === 'edited' ? edited : conflict[choice];
    C.assert(value === null || value && entryIdentity(value) === key, '解决后的词条身份不能改变');
    if (value) { object(value, ['site', 'entry'], ['site', 'entry']); object(value.entry, entryFields, entryFields.filter(k => k !== 'userSelected')); C.validEntry(value.entry); }
    result.merged[key] = structuredClone(value); result.conflicts = result.conflicts.filter(c => c.key !== key);
    if (same(value, conflict.remote)) delete result.pending[key]; else result.pending[key] = structuredClone(value);
    result.canInstall = result.conflicts.length === 0; return result;
  }
  function comparisonReason(state, remote, commit, hasRemote=Object.keys(remote).length>0) {
    const hasLocal=Object.keys(state?.local || {}).length>0;
    if(state?.commit!==commit && state?.seenCommits?.includes(commit))return '仓库当前提交曾被本机较新内容替换，无法可靠判断修改关系';
    if((state?.contentRevision || hasLocal && hasRemote) &&
      (!/^[a-f0-9]{40}$/.test(state?.commit || '') || !/^[a-f0-9]{64}$/.test(state?.contentRevision || '') || !state?.baseline))return '本机缺少完整的共同基线，无法可靠判断修改关系';
    return null;
  }
  function preferConflicts(comparison, choice) {
    let result=comparison;
    for(const conflict of comparison.conflicts)result=resolveConflict(result,conflict.key,choice);
    return result;
  }
  const currentGeneration = (expected, actual) => same(expected, actual);

  const preferenceKeys = ['targetLanguage', 'requestTimeoutMinutes', 'inputContextK', 'autoExpandSeconds', ...Object.keys(C.captureDefaults)];
  function syncPreferences(input) {
    const out = Object.fromEntries(preferenceKeys.filter(k => own(input, k)).map(k => [k, input[k]]));
    if (own(out, 'targetLanguage')) C.assert(C.language(out.targetLanguage) === out.targetLanguage, '同步语言无效');
    for (const [key, min, max] of [['requestTimeoutMinutes', 1, 60], ['inputContextK', 1, 1000]]) if (own(out, key)) C.assert(Number.isInteger(out[key]) && out[key] >= min && out[key] <= max, '同步常规设置无效');
    if (own(out, 'autoExpandSeconds')) C.autoExpandSeconds(out.autoExpandSeconds);
    C.captureLimits(out); return out;
  }
  function repositoryConfiguration(value) {
    C.assert(value && Object.keys(value).every(k => ['provider','owner', 'repo', 'branch'].includes(k)), '词库仓库配置无效');
    const selected=value.provider||'github';C.assert(['github','gitee'].includes(selected),'不支持的词库平台');
    C.assert(typeof value.owner === 'string' && typeof value.repo === 'string' && (selected==='gitee'?/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/:/^[a-zA-Z0-9][a-zA-Z0-9-]{0,99}$/).test(value.owner) && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(value.repo), '词库仓库名称无效');
    C.assert(typeof value.branch === 'string' && value.branch.length <= 200 && /^[a-zA-Z0-9][a-zA-Z0-9_./-]*$/.test(value.branch) && !/\.\.|\/\/|\/$|\.lock(?:\/|$)/.test(value.branch), '词库分支无效');
    // Keep the existing GitHub identity byte-for-byte: IndexedDB keys, mirrors,
    // conflicts and download tickets must survive an upgrade without re-keying.
    return Object.freeze({ ...(selected==='gitee'?{provider:selected}:{}), owner:value.owner, repo:value.repo, branch:value.branch });
  }
  function validateSyncRecord(row) {
    object(row, ['kind', 'id', 'field', 'counter', 'deviceId', 'value']);
    C.assert(['site', 'preference'].includes(row.kind) && Number.isSafeInteger(row.counter) && row.counter > 0 && C.uuid(row.deviceId), '同步记录身份无效');
    if (row.kind === 'site') {
      origin(row.id); C.assert(['installed', 'enabled', 'excludedPaths', 'name'].includes(row.field), '同步网站字段不在白名单');
      if (['installed', 'enabled'].includes(row.field)) C.assert(typeof row.value === 'boolean', '同步开关无效');
      if (row.field === 'name') C.assert(isString(row.value, 300), '同步网站名称无效');
      if (row.field === 'excludedPaths') C.assert(Array.isArray(row.value) && row.value.length <= 100 && row.value.every(p => isString(p, 2048) && p.startsWith('/') && !/[?#]/.test(p)), '同步排除路径无效');
    } else {
      C.assert(row.id === 'settings', '同步设置身份无效');
      if (preferenceKeys.includes(row.field)) syncPreferences({ [row.field]: row.value });
      else if (row.field === 'enable_extension') C.assert(typeof row.value === 'boolean', '同步总开关无效');
      else if (row.field === 'aiSettings' || /^aiProfile:[a-z0-9_-]+$/.test(row.field)) {
        object(row.value,['provider','model','endpoint','region','reasoningEffort','apiKey'],['provider','model','endpoint','region','reasoningEffort']);
        for(const [key,value] of Object.entries(row.value))C.assert(typeof value==='string'&&value.length<=(key==='apiKey'?6000:2000)&&!(key==='apiKey'&&/[\r\n]/.test(value)),'同步 AI 参数无效');
        C.assert(row.value.provider!=='chatgpt'||!row.value.apiKey,'订阅登录凭据不属于同步设置');
        C.assert(/^[a-z0-9_-]+$/.test(row.value.provider),'同步服务无效');
        if(row.field.startsWith('aiProfile:'))C.assert(row.field.slice(10)===row.value.provider,'同步服务配置身份无效');
        if(row.value.endpoint){const u=new URL(row.value.endpoint);C.assert(['https:','http:'].includes(u.protocol)&&!u.username&&!u.password&&!u.search&&!u.hash,'同步 API 地址不能含凭据');}
      }
      else if (row.field === 'dictionaryRepository') repositoryConfiguration(row.value);
      else if (/^dictionaryToken:(github|gitee)$/.test(row.field)) C.assert(typeof row.value==='string'&&row.value.length<=1000&&!/[\r\n]/.test(row.value),'同步词库令牌无效');
      else if (row.field === 'prompt') C.assert(typeof row.value === 'string' && bytes(row.value) <= 5000, '提示词超过浏览器同步单项容量；请保留在本机');
      else C.assert(false, '同步字段不在白名单');
    }
    C.assert(bytes(row) <= limits.syncItemBytes - 100, '同步记录超过单项容量'); return row;
  }
  const syncIdentity = r => C.canonical([r.kind, r.id, r.field]);
  function mergeSync(...sets) {
    const records = new Map();
    for (const rows of sets) {
      C.assert(Array.isArray(rows) && rows.length <= limits.syncRecords, '同步记录数量超限');
      for (const row of rows) {
        validateSyncRecord(row); const key = syncIdentity(row), old = records.get(key);
        if (old && old.counter === row.counter && old.deviceId === row.deviceId) C.assert(same(old, row), '同步记录身份内容冲突');
        const wins = !old || row.counter > old.counter || row.counter === old.counter && (row.field === 'installed' && old.value !== row.value ? row.value === false : row.deviceId > old.deviceId);
        if (wins) records.set(key, structuredClone(row));
      }
    }
    C.assert(records.size <= limits.syncRecords, '同步记录数量超限，删除标记不得静默清理');
    return [...records.values()].sort((a, b) => syncIdentity(a).localeCompare(syncIdentity(b), 'en'));
  }
  async function packSync(rows) {
    const records = mergeSync(rows), shards = []; let part = [];
    for (const row of records) { if (bytes([...part, row]) > 6500 && part.length) { shards.push(part); part = []; } part.push(row); }
    if (part.length) shards.push(part);
    const revision = await digest(records), values = {};
    for (const [i, shard] of shards.entries()) values['wt_install_' + i] = { schemaVersion: VERSION, revision, records: shard };
    values.wt_install_head = { schemaVersion: VERSION, revision, count: shards.length };
    C.assert(Object.entries(values).every(([key, v]) => bytes(key) + bytes(v) <= limits.syncItemBytes) && Object.entries(values).reduce((n, [key, v]) => n + bytes(key) + bytes(v), 0) <= limits.syncBytes, '浏览器同步清单超过配额，请减少设置或保留在本机');
    return values;
  }
  async function unpackSync(values) {
    const head = values.wt_install_head;
    if (!head) return null; // No arrival yet, never a request to delete local sites.
    object(head, ['schemaVersion', 'revision', 'count']);
    C.assert(head.schemaVersion === VERSION && sha(head.revision) && Number.isInteger(head.count) && head.count >= 0 && head.count <= 100, '同步清单头无效');
    const rows = [];
    for (let i = 0; i < head.count; i++) {
      const part = values['wt_install_' + i]; object(part, ['schemaVersion', 'revision', 'records']);
      C.assert(part.schemaVersion === VERSION && part.revision === head.revision && Array.isArray(part.records), '同步分片尚未到齐，请重试'); rows.push(...part.records);
    }
    const merged = mergeSync(rows); C.assert(merged.length === rows.length && await digest(merged) === head.revision, '同步清单校验失败');
    await packSync(merged); return merged;
  }
  const api = { VERSION, limits, bytes, digest, origin, originId, groupFor, groupId, path, validateIndex, validateManifest, selectFiles, validateGraph, adapterShape,
    validatePackage, verifyFile, validateRecord, entryIdentity, recordsMap, staticEntry, mergeRecords, resolveConflict, comparisonReason, preferConflicts, currentGeneration,
    repositoryConfiguration, syncPreferences, validateSyncRecord, mergeSync, packSync, unpackSync, syncIdentity };
  C.dictionary = Object.freeze(api);
  if (typeof module !== 'undefined') module.exports = C.dictionary;
})();
