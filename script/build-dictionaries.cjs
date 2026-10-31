'use strict';
// Migration preparation only. Does not change extension distribution or publish.
const fs = require('node:fs'), path = require('node:path');
const { getDomain } = require('tldts');
const C = require('../extension/managed-core.js'), D = require('../extension/dictionary-core.js');
const { loadSites, ROOT } = require('./site-config');
const { parseDictionary, digest } = require('./parse-github-dictionary.cjs');
const serialize = data => JSON.stringify(data, null, 2) + '\n';

function encodeGraph(data, regexps, policyRevision) {
  const nodes = [], objects = new Map(), patterns = new Map(regexps.map(r => [r.id, r]));
  function encode(value) {
    if (value === null || typeof value !== 'object') return value;
    if (Object.hasOwn(value, '$regexp')) {
      C.assert(patterns.has(value.$regexp), '转换器缺少正则定义'); return { regexp: patterns.get(value.$regexp) };
    }
    if (Object.hasOwn(value, '$handler')) return { handler: value.$handler };
    if (objects.has(value)) return { ref: objects.get(value) };
    const id = nodes.length; objects.set(value, id); nodes.push(null);
    nodes[id] = Array.isArray(value) ? { type: 'array', values: value.map(encode) }
      : { type: 'object', values: Object.entries(value).map(([key, item]) => [key, encode(item)]) };
    return { ref: id };
  }
  const root = encode(data);
  return { root, nodes, policyRevision };
}
function inventory(root = ROOT, policyRevision = '0'.repeat(64)) {
  const source = fs.readFileSync(path.join(root, 'chrome/locals.js'), 'utf8');
  const parsed = parseDictionary(source), packs = [], sources = [];
  const sites = loadSites(root).filter(s => s.enabled !== false);
  for (const site of sites) {
    sources.push({ path: `sites/${site.id}/site.json`, sha256: digest(fs.readFileSync(path.join(root, 'sites', site.id, 'site.json'))) });
    const addresses = site.matches.map(match => { C.assert(!match.includes('*.'), '通配域名必须先清点为明确网址，不能自动扩大词库范围'); return new URL(match.slice(0, -1)).origin; }).sort();
    const common = { schemaVersion: D.VERSION, minReaderVersion: D.VERSION, targetLanguage: 'zh-Hans', records: [] };
    if (site.engine === 'github') {
      const special = { 'gist.github.com': 'gist', 'skills.github.com': 'skills', 'education.github.com': 'education', 'www.githubstatus.com': 'status' };
      for (const address of addresses) {
        const hostname = new URL(address).hostname, page = special[hostname];
        const locale = Object.fromEntries(Object.entries(parsed.data['zh-CN']).filter(([key]) => page ? ['public', 'title', page].includes(key) : !Object.values(special).includes(key)));
        C.assert(!page || Object.hasOwn(locale, page), '缺少专用子网站页面分类');
        const data = { conf: parsed.data.conf, 'zh-CN': locale };
        packs.push({ id: D.originId(address), ...common, group: D.groupFor(address, getDomain), origins: [address], kind: 'github', adapter: encodeGraph(data, parsed.regexps, policyRevision) });
      }
    } else {
      const group = D.groupFor(addresses[0], getDomain);
      C.assert(addresses.every(o => D.groupFor(o, getDomain) === group), '单个网站配置跨主域名，需要人工拆分');
      packs.push({ id: addresses.length > 1 ? 'shared-' + site.id : D.originId(addresses[0]), ...common, group, origins: addresses, kind: 'site', adapter: encodeGraph(site, [], policyRevision) });
    }
  }
  return { parsed, packs, sources };
}
function counts(data) {
  const visited = new Set(); let staticEntries = 0, regexpRules = 0, selectorRules = 0;
  function walk(o) {
    if (!o || typeof o !== 'object' || visited.has(o)) return; visited.add(o);
    if (o.static) staticEntries += Object.keys(o.static).length;
    if (o.dictionary) staticEntries += Object.keys(o.dictionary).length;
    if (o.regexp) regexpRules += o.regexp.length;
    if (o['time-regexp']) regexpRules += o['time-regexp'].length;
    if (o.selector) selectorRules += o.selector.length;
    Object.values(o).forEach(walk);
  }
  walk(data); return { staticEntries, regexpRules, selectorRules };
}
async function generate(root = ROOT) {
  const policy = JSON.parse(fs.readFileSync(path.join(root, 'extension/dictionary-policy.json'), 'utf8'));
  const { revision, ...policyBody } = policy;
  C.assert(revision === await D.digest(policyBody), '本地规则白名单修订不匹配');
  const { parsed, packs, sources } = inventory(root, revision), outputs = new Map(), groups = new Map();
  const unknown = [...parsed.handlers.filter(h => !policy.handlers.includes(h.id)).map(({ id, line }) => ({ type: 'handler', id, line })), ...parsed.regexps.filter(r => !Object.hasOwn(policy.regexps, r.id)).map(({ id, source, flags }) => ({ type: 'regexp', id, source, flags }))];
  C.assert(unknown.length === 0, '发现未经本地审阅的规则，转换未写入任何文件：' + JSON.stringify(unknown));
  for (const { id, ...pack } of packs) {
    try { D.validatePackage(pack, { getDomain, policy }); }
    catch (e) { throw new Error(`${pack.group}/${id}: ${e.message}`); }
    const filename = `dictionaries/${pack.group}/${pack.targetLanguage}/${id}.json`, raw = serialize(pack);
    C.assert(!outputs.has(filename), '转换后的词库文件身份冲突'); outputs.set(filename, raw);
    const file = { id, path: filename, sha256: digest(raw), bytes: Buffer.byteLength(raw), kind: pack.kind, origins: pack.origins, requires: [] };
    C.assert(file.bytes <= D.limits.packageBytes, '转换包超过单文件容量');
    if (!groups.has(pack.group)) groups.set(pack.group, []); groups.get(pack.group).push(file);
  }
  const index = { schemaVersion: D.VERSION, minReaderVersion: D.VERSION, groups: [] };
  for (const [group, files] of [...groups].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
    const content = { origins: [...new Set(files.flatMap(f => f.origins))].sort(), files };
    const revision = await D.digest(content);
    const manifest = { schemaVersion: D.VERSION, minReaderVersion: D.VERSION, group, languages: { 'zh-Hans': { revision, ...content } } };
    await D.validateManifest(manifest, getDomain);
    const filename = `dictionaries/${group}/manifest.json`, raw = serialize(manifest); outputs.set(filename, raw);
    index.groups.push({ group, manifest: { path: filename, sha256: digest(raw), bytes: Buffer.byteLength(raw) }, languages: { 'zh-Hans': revision } });
  }
  // Preserve published supplemental entries, other languages and user-added groups.
  // A normal source build must never erase dictionaries uploaded by an extension.
  const previousIndexPath=path.join(root,'dictionaries/index.json');
  if(fs.existsSync(previousIndexPath)) {
    const previous=D.validateIndex(JSON.parse(fs.readFileSync(previousIndexPath,'utf8')));
    for(const item of previous.groups){
      const oldRaw=fs.readFileSync(path.join(root,item.manifest.path),'utf8');
      C.assert(Buffer.byteLength(oldRaw)===item.manifest.bytes && digest(oldRaw)===item.manifest.sha256,'现有词库清单损坏，构建未覆盖');
      const old=await D.validateManifest(JSON.parse(oldRaw),getDomain);
      const freshRaw=outputs.get(item.manifest.path),fresh=freshRaw?JSON.parse(freshRaw):{schemaVersion:1,minReaderVersion:1,group:item.group,languages:{}};
      for(const [lang,data] of Object.entries(old.languages)){
        const preserve=data.files.filter(f=>!fresh.languages[lang] || f.kind==='entries');
        if(!preserve.length)continue;
        for(const file of preserve){const raw=fs.readFileSync(path.join(root,file.path),'utf8');await D.verifyFile(raw,file,{getDomain,policy});outputs.set(file.path,raw);}
        const files=[...(fresh.languages[lang]?.files || []).filter(f=>!preserve.some(p=>p.id===f.id)),...preserve];
        const content={origins:[...new Set(files.flatMap(f=>f.origins))].sort(),files};fresh.languages[lang]={...data,...content,revision:await D.digest(content)};
      }
      await D.validateManifest(fresh,getDomain);const raw=serialize(fresh);outputs.set(item.manifest.path,raw);
      const replacement={...item,group:item.group,manifest:{...item.manifest,path:item.manifest.path,sha256:digest(raw),bytes:Buffer.byteLength(raw)},languages:Object.fromEntries(Object.entries(fresh.languages).map(([lang,data])=>[lang,data.revision]))};
      index.groups=[...index.groups.filter(g=>g.group!==item.group),replacement].sort((a,b)=>a.group.localeCompare(b.group,'en'));
      groups.set(item.group,Object.values(fresh.languages).flatMap(data=>data.files));
    }
  }
  D.validateIndex(index); outputs.set('dictionaries/index.json', serialize(index));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'upstream/github-chinese/lock.json'), 'utf8'));
  const report = { schemaVersion: 1, status: 'prepared-not-published', runtimeSwitched: false,
    source: { path: 'chrome/locals.js', sha256: parsed.sourceSha256, upstream: { repository: lock.repository, branch: lock.branch, commit: lock.commit, sha256: lock.sha256 } },
    sources, targetLanguage: 'zh-Hans', ...counts(parsed.data), pages: Object.keys(parsed.data['zh-CN']).length,
    uniqueRegexps: parsed.regexps.length, uniqueHandlers: parsed.handlers.length, assignments: parsed.assignments.length,
    pageInventory: Object.entries(parsed.data['zh-CN']).map(([page, data]) => ({ page, ...counts(data) })),
    handlerInventory: parsed.handlers.map(({ id, line }) => ({ id, line })),
    groups: index.groups.map(g => ({ group: g.group, files: groups.get(g.group), revision: g.languages['zh-Hans'] })),
    unhandled: [], notes: ['静态解释赋值、对象/数组展开与引用；未执行 locals.js。', '统计按唯一对象计数，页面清单保留展开和别名后的各页面效果。', '正则、处理器和可执行范围必须符合扩展本地受审白名单。', '相同 site.json 的明确网址共用受限 shared.json；GitHub 子网站分别限定网址和页面。', '转换工具不发布数据或迁移浏览器；运行时从已下载缓存读取，首次发布仍单独执行。'] };
  outputs.set('docs/github-dictionary-conversion.json', serialize(report));
  return { outputs, report, index, policy };
}
async function build({ root = ROOT, check = false } = {}) {
  const result = await generate(root); // Validate all data before writing any output.
  const changed = [];
  for (const [relative, raw] of result.outputs) {
    const target = path.join(root, relative);
    if (fs.existsSync(target) && fs.readFileSync(target, 'utf8') === raw) continue;
    changed.push(relative);
    if (!check) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, raw); }
  }
  if (check && changed.length) throw new Error('词库转换产物需更新：' + changed.join('、'));
  console.log(`[dictionaries] ${check ? '校验' : '生成'} ${result.index.groups.length} 组、${result.report.groups.reduce((n, g) => n + g.files.length, 0)} 文件；${result.report.pages} 页面，未处理 0 项；仅构建数据，不发布或操作个人浏览器`);
  return result;
}
if (require.main === module) {
  if (process.argv.slice(2).some(a => !['--check', '--export'].includes(a)) || process.argv.includes('--check') && process.argv.includes('--export')) { console.error('仅支持 --check 或 --export'); process.exitCode = 1; }
  else (process.argv.includes('--export') ? generate().then(r => process.stdout.write(JSON.stringify([...r.outputs]))) : build({ check: process.argv.includes('--check') })).catch(e => { console.error('[dictionaries] ' + e.message); process.exitCode = 1; });
}
module.exports = { inventory, encodeGraph, generate, build };
