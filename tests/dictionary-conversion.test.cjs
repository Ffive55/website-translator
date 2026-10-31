'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { getDomain } = require('tldts');
const C = require('../extension/managed-core.js'), D = require('../extension/dictionary-core.js');
const { hydrate } = require('../extension/dictionary-adapters.js'), handlers = require('../extension/github-dictionary-handlers.js');
const { parseDictionary, digest } = require('../script/parse-github-dictionary.cjs');
const { generate } = require('../script/build-dictionaries.cjs');
const { loadSites, ROOT } = require('../script/site-config');
let result;
const prepared = () => result ||= generate();
const outputPack = (r, filename) => JSON.parse(r.outputs.get(filename));
test('重新构建保留已上传增量词库与其他目标语言，不覆盖发布内容',async t=>{
  const os=require('node:os'),root=fs.mkdtempSync(path.join(os.tmpdir(),'wt-dictionary-preserve-'));
  t.after(()=>{assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('wt-dictionary-preserve-'));fs.rmSync(root,{recursive:true,force:true});});
  for(const name of ['sites','dictionaries'])fs.cpSync(path.join(ROOT,name),path.join(root,name),{recursive:true});
  for(const name of ['chrome/locals.js','extension/dictionary-policy.json','upstream/github-chinese/lock.json']){fs.mkdirSync(path.dirname(path.join(root,name)),{recursive:true});fs.copyFileSync(path.join(ROOT,name),path.join(root,name));}
  const filename='dictionaries/docker.com/manifest.json',manifest=JSON.parse(fs.readFileSync(path.join(root,filename),'utf8'));
  const pack={schemaVersion:1,minReaderVersion:1,group:'docker.com',targetLanguage:'ja',origins:['https://docker.com'],kind:'entries',records:[{site:'https://docker.com',entry:{sourceText:'Save',context:'main/button/text',path:'/',sourceLanguage:null,targetLanguage:'ja',category:'ui',action:'translate',translation:'保存する',origin:'manual'}}],adapter:null};
  const raw=JSON.stringify(pack),file={id:'managed-entries',path:'dictionaries/docker.com/ja/managed-entries.json',sha256:await D.digest(raw),bytes:D.bytes(raw),kind:'entries',origins:pack.origins,requires:[]},data={origins:pack.origins,files:[file]};
  manifest.languages.ja={...data,revision:await D.digest(data)};const manifestRaw=JSON.stringify(manifest);
  const indexPath=path.join(root,'dictionaries/index.json'),index=JSON.parse(fs.readFileSync(indexPath,'utf8')),item=index.groups.find(g=>g.group==='docker.com');item.manifest.sha256=await D.digest(manifestRaw);item.manifest.bytes=D.bytes(manifestRaw);item.languages.ja=manifest.languages.ja.revision;
  fs.mkdirSync(path.dirname(path.join(root,file.path)),{recursive:true});fs.writeFileSync(path.join(root,file.path),raw);fs.writeFileSync(path.join(root,filename),manifestRaw);fs.writeFileSync(indexPath,JSON.stringify(index));
  const generated=await generate(root);assert.equal(generated.outputs.get(file.path),raw);assert.deepEqual(JSON.parse(generated.outputs.get(filename)).languages.ja,manifest.languages.ja);
});
function comparable(value) {
  if (typeof value === 'function') return { handler: digest(value.toString().replace(/\r\n/g, '\n')) };
  if (Object.prototype.toString.call(value) === '[object RegExp]') return { source: value.source, flags: value.flags };
  if (Array.isArray(value)) return Array.from(value, comparable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, comparable(v)]));
  return value;
}
test('旧 JS 只静态解析，调用、全局赋值、getter、原型污染及未知处理器均无法执行', async () => {
  globalThis.__dictionaryMustNotRun = false;
  for (const source of [
    'var I18N={}; globalThis.__dictionaryMustNotRun=true;',
    'var I18N={}; I18N.conf=process.exit();',
    'var I18N={}; I18N.conf={get x(){globalThis.__dictionaryMustNotRun=true;}};',
    'var I18N={}; I18N.conf={__proto__: {bad:true}};',
  ]) assert.throws(() => parseDictionary(source));
  const parsed = parseDictionary('var I18N={}; I18N.conf={}; I18N["zh-CN"]={x:{regexp:[[/x/,()=>{globalThis.__dictionaryMustNotRun=true;return "x";}]]}};');
  assert.equal(globalThis.__dictionaryMustNotRun, false); assert.equal(parsed.handlers.length, 1);
  const r = await prepared(); assert.equal(r.policy.handlers.includes(parsed.handlers[0].id), false);
  delete globalThis.__dictionaryMustNotRun;
});
test('转换覆盖全部页面、53 处理器和 1247 正则；清单、哈希、大小及已生成报告一致', async () => {
  const r = await prepared(); assert.equal(r.report.pages, 277); assert.equal(r.report.uniqueHandlers, 53); assert.equal(r.report.uniqueRegexps, 1247); assert.deepEqual(r.report.unhandled, []);
  for(const id of ['docker.com','github.com','githubstatus.com','tailscale.com'])assert.ok(r.index.groups.some(g=>g.group===id),'基础分组缺失：'+id);
  for (const [filename, raw] of r.outputs) assert.equal(fs.readFileSync(path.join(ROOT, filename), 'utf8'), raw, filename);
  for (const group of r.index.groups) {
    const manifestRaw = r.outputs.get(group.manifest.path), manifest = JSON.parse(manifestRaw);
    assert.equal(await D.digest(manifestRaw), group.manifest.sha256); await D.validateManifest(manifest, getDomain);
    for (const data of Object.values(manifest.languages))for(const file of data.files) await D.verifyFile(r.outputs.get(file.path), file, { getDomain, policy: r.policy });
  }
  assert.ok(r.outputs.get('dictionaries/github.com/zh-Hans/github.com.json').length > 1000000, '必须验证真实大词库，不能只用小样本');
});
test('转换后所有静态、正则、选择器、页面配置和函数内容与旧本地源码等价，别名保留', async () => {
  const r = await prepared(), sandbox = vm.createContext({});
  // Only the current repository source, after the static converter and policy checks passed.
  const source = fs.readFileSync(path.join(ROOT, 'chrome/locals.js'), 'utf8');
  vm.runInContext(source.replace(/\r\n/g, '\n'), sandbox, { timeout: 3000 });
  const legacy = sandbox.I18N, seen = new Set();
  const special = { 'gist.github.com': 'gist', 'skills.github.com': 'skills', 'education.github.com': 'education', 'www.githubstatus.com': 'status' };
  for (const [filename, raw] of r.outputs) {
    if (!/\/zh-Hans\//.test(filename)) continue;
    const pack = JSON.parse(raw);if(pack.kind==='entries')continue;const data = hydrate(pack, { getDomain, policy: r.policy }, handlers.bind);
    if (pack.kind === 'site') {
      assert.deepEqual(comparable(data), loadSites().find(s => s.id === data.id), filename); continue;
    }
    const page = special[new URL(pack.origins[0]).hostname];
    const expected = { conf: legacy.conf, 'zh-CN': Object.fromEntries(Object.entries(legacy['zh-CN']).filter(([key]) => page ? ['public', 'title', page].includes(key) : !Object.values(special).includes(key))) };
    for (const key of Object.keys(data['zh-CN'])) seen.add(key);
    assert.deepEqual(comparable(data), comparable(expected), filename);
    if (!page) assert.equal(data['zh-CN'].dashboard, data['zh-CN']['page-dashboard']);
  }
  assert.deepEqual([...seen].sort(), Object.keys(legacy['zh-CN']).sort(), '没有静默丢弃页面');
});
test('本地固定处理器保留日期、相对时间、月份/分钟和连续替换效果', async () => {
  const r = await prepared(), pack = outputPack(r, 'dictionaries/github.com/zh-Hans/github.com.json');
  const locale = hydrate(pack, { getDomain, policy: r.policy }, handlers.bind)['zh-CN'];
  const translate = (rules, text) => { for (const [pattern, replacement] of rules) { const translated = text.replace(pattern, replacement); if (translated !== text) return translated; } return text; };
  for (const rules of [locale.public.regexp, locale.public['time-regexp']]) {
    assert.equal(translate(rules, '1m'), '1 分钟之前'); assert.equal(translate(rules, '1mo'), '1 个月之前'); assert.equal(translate(rules, '2h'), '2 小时之前');
  }
  assert.equal(translate(locale.public['time-regexp'], 'Jan 31, 2026'), '2026年1月31日');
  assert.equal(translate(locale.public['time-regexp'], 'just now'), '刚刚');
  assert.match(translate(locale['orgs-public'].regexp, 'This organization was marked as archived by an administrator on Jan 31, 2026. It is no longer maintained.'), /2026年1月31日/);
});
test('远端数据可增加静态译文，不能扩展页面、选择器、正则执行范围或替换固定函数', async () => {
  const r = await prepared(), original = outputPack(r, 'dictionaries/docker.com/zh-Hans/shared-docker.json');
  const edited = structuredClone(original), dictionary = edited.adapter.nodes.find(n => n.type === 'object' && n.values.some(([k]) => k === 'dictionary')).values.find(([k]) => k === 'dictionary')[1];
  edited.adapter.nodes[dictionary.ref].values.push(['Brand new menu label', '新增菜单']);
  assert.doesNotThrow(() => D.validatePackage(edited, { getDomain, policy: r.policy }));
  const wider = structuredClone(original), selectors = wider.adapter.nodes.find(n => n.type === 'object' && n.values.some(([k]) => k === 'selectors')).values.find(([k]) => k === 'selectors')[1];
  wider.adapter.nodes[selectors.ref].values.push('input'); assert.throws(() => D.validatePackage(wider, { getDomain, policy: r.policy }), /未经本地审阅/);
  const github = outputPack(r, 'dictionaries/github.com/zh-Hans/github.com.json');
  const regexNode = github.adapter.nodes.find(n => n.type === 'array' && n.values.some(v => v && v.regexp));
  regexNode.values.find(v => v && v.regexp).regexp.source = '((x+)+)+$'; assert.throws(() => D.validatePackage(github, { getDomain, policy: r.policy }), /正则/);
  const unknown = structuredClone(original); unknown.adapter.nodes.push({ type: 'array', values: [{ handler: 'downloaded-function' }] });
  assert.throws(() => D.validatePackage(unknown, { getDomain, policy: r.policy }));
});
test('词库修订独立于插件版本、README、报告和源码提交；固定处理器源码哈希与白名单相符', async () => {
  const r = await prepared(), parsed = parseDictionary(fs.readFileSync(path.join(ROOT, 'chrome/locals.js'), 'utf8'));
  for (const handler of parsed.handlers) assert.equal(digest(handlers.bind({})[handler.id].toString()), handler.id.slice(2));
  const file = r.index.groups.find(g => g.group === 'github.com');
  const manifest = JSON.parse(r.outputs.get(file.manifest.path));
  const data = manifest.languages['zh-Hans']; assert.equal(data.revision, await D.digest({ origins: data.origins, files: data.files }));
  assert.equal(Object.hasOwn(manifest, 'pluginVersion'), false); assert.equal(Object.hasOwn(r.index, 'commit'), false);
});
