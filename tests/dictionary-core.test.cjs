'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { getDomain } = require('tldts');
const C = require('../extension/managed-core.js'), D = require('../extension/dictionary-core.js');
const R = require('../extension/dictionary-repository.js'), M = require('../extension/dictionary-migration.js');
const repository = { owner: 'Ffive55', repo: 'website-translator', branch: 'main' };
const address = 'https://example.com', device = '11111111-1111-4111-8111-111111111111', otherDevice = '22222222-2222-4222-8222-222222222222';
const entry = (translation = '保存', language = 'zh-Hans', sourceText = 'Save') => ({ sourceText, context: 'main/button/text', path: '/settings', sourceLanguage: null, targetLanguage: language, category: 'ui', action: 'translate', translation, origin: 'manual', userSelected: true });
const row = (...args) => ({ site: address, entry: entry(...args) });
const pack = (records = [row()], language = 'zh-Hans') => ({ schemaVersion: 1, minReaderVersion: 1, group: 'example.com', targetLanguage: language, origins: [address], kind: 'entries', records, adapter: null });
const description = async (data, id = 'example.com') => { const raw = JSON.stringify(data); return { id, path: `dictionaries/${data.group}/${data.targetLanguage}/${id}.json`, sha256: await D.digest(raw), bytes: D.bytes(raw), kind: data.kind, origins: data.origins, requires: [] }; };
async function fixture() {
  const data = pack(), raw = JSON.stringify(data), file = await description(data);
  const content = { origins: [address], files: [file] }, revision = await D.digest(content);
  const manifest = { schemaVersion: 1, minReaderVersion: 1, group: 'example.com', languages: { 'zh-Hans': { revision, ...content } } }, manifestRaw = JSON.stringify(manifest);
  const index = { schemaVersion: 1, minReaderVersion: 1, groups: [{ group: 'example.com', manifest: { path: 'dictionaries/example.com/manifest.json', bytes: D.bytes(manifestRaw), sha256: await D.digest(manifestRaw) }, languages: { 'zh-Hans': revision } }] };
  return { data, raw, file, manifest, manifestRaw, index };
}

test('协议区分 BCP 47 语言、完整 origin、公共托管租户及特殊网址文件身份', () => {
  assert.equal(D.groupFor('https://console.example.co.uk', getDomain), 'example.co.uk');
  assert.equal(D.groupFor('https://tenant.github.io', getDomain), 'tenant.github.io');
  assert.equal(D.originId('https://xn--fiqs8s.example'), 'xn--fiqs8s.example');
  assert.notEqual(D.originId('http://example.com'), D.originId(address));
  assert.notEqual(D.originId('https://example.com:444'), D.originId(address));
  assert.match(D.originId('http://[::1]:3000'), /^[a-z0-9-]+$/);
  for (const value of [address + '/', 'https://u:p@example.com', 'file:///example.com']) assert.throws(() => D.origin(value));
  assert.notEqual(D.entryIdentity(row()), D.entryIdentity(row('保存する', 'ja')));
  assert.notEqual(D.entryIdentity(row()), D.entryIdentity({ ...row(), site: 'https://www.example.com' }));
});
test('统一包拒绝凭据、脚本、HTML、错误语言、越界网址和重复身份', () => {
  assert.equal(D.validatePackage(pack(), { getDomain }).records[0].entry.userSelected, true);
  for (const mutate of [
    p => { p.apiKey = 'fixture'; }, p => { p.records[0].entry.script = 'x'; }, p => { p.records[0].entry.translation = '<img src=x>'; },
    p => { p.records[0].entry.targetLanguage = 'ja'; }, p => { p.origins = ['https://elsewhere.test']; },
    p => { p.records.push(p.records[0]); }, p => { p.minReaderVersion = 2; }, p => { p.records[0].site = 'https://other.example.com'; },
    p => { p.targetLanguage = 'zh-hans'; }, p => { p.records[0].deleted = false; },
  ]) { const data = pack(); mutate(data); assert.throws(() => D.validatePackage(data, { getDomain })); }
});
test('路径白名单只允许当前组和语言，文件校验固定字节、哈希与声明范围', async () => {
  for (const path of ['dictionaries/../src.js', 'dictionaries/example.com/zh-Hans/../../a.json', 'dictionaries/elsewhere/zh-Hans/a.json', '.github/workflows/a.yml', 'dictionaries/example.com/zh-Hans/a.json?x=1']) assert.throws(() => D.path(path, 'example.com', 'zh-Hans'));
  const f = await fixture(); assert.deepEqual(await D.verifyFile(f.raw, f.file, { getDomain }), f.data);
  await assert.rejects(() => D.verifyFile(f.raw + ' ', f.file, { getDomain }), /SHA-256/);
  const wrong = { ...f.file, path: f.file.path.replace('zh-Hans', 'ja') };
  await assert.rejects(() => D.verifyFile(f.raw, wrong, { getDomain }), /清单不匹配/);
});
test('清单依赖、按语言修订与主域名已安装范围受验证', async () => {
  const f = await fixture(); await D.validateManifest(f.manifest, getDomain); D.validateIndex(f.index);
  assert.deepEqual(D.selectFiles(f.manifest, 'ja', [address]), []);
  assert.deepEqual(D.selectFiles(f.manifest, 'zh-Hans', ['https://unused.example.com']), []);
  for (const mutate of [
    m => { m.languages['zh-Hans'].revision = '0'.repeat(64); },
    m => { m.languages['zh-Hans'].files[0].requires = ['missing']; },
    m => { m.languages['zh-Hans'].files.push(m.languages['zh-Hans'].files[0]); },
  ]) { const data = structuredClone(f.manifest); mutate(data); if (data.languages['zh-Hans'].revision !== '0'.repeat(64)) data.languages['zh-Hans'].revision = await D.digest({ origins: data.languages['zh-Hans'].origins, files: data.languages['zh-Hans'].files }); await assert.rejects(() => D.validateManifest(data, getDomain)); }
  const shared = { ...f.file, id: 'shared', path: f.file.path.replace('example.com.json', 'shared.json'), origins: [address, 'https://app.example.com'] };
  const child = { ...f.file, requires: ['shared'] }, content = { origins: shared.origins, files: [shared, child] };
  const manifest = { ...f.manifest, languages: { 'zh-Hans': { ...content, revision: await D.digest(content) } } };
  await D.validateManifest(manifest, getDomain); assert.deepEqual(D.selectFiles(manifest, 'zh-Hans', [address]).map(f => f.id), ['shared', 'example.com']);
  // The list of installed origins stays external; downloading shared data never adds the other origin.
  const broader = structuredClone(manifest); broader.languages['zh-Hans'].files[0].origins = ['https://app.example.com'];
  broader.languages['zh-Hans'].revision = await D.digest({ origins: content.origins, files: broader.languages['zh-Hans'].files });
  await assert.rejects(() => D.validateManifest(broader, getDomain), /扩大网址/);
});
test('三方比较自动合并独立修改，保留同键冲突和删除修改冲突，不用缺项推断删除', () => {
  const b = D.recordsMap([row()]), k = D.entryIdentity(row());
  const local = D.recordsMap([row('本机'), row('取消', 'zh-Hans', 'Cancel')]), remote = D.recordsMap([row('远端')]);
  let result = D.mergeRecords(b, local, remote); assert.equal(result.canInstall, false); assert.equal(result.merged[k].entry.translation, '本机'); assert.equal(result.conflicts[0].base.entry.translation, '保存');
  result = D.resolveConflict(result, k, 'remote'); assert.equal(result.canInstall, true); assert.equal(result.merged[k].entry.translation, '远端'); assert.equal(Object.keys(result.pending).length, 1);
  assert.equal(D.mergeRecords(b, {}, {}).merged[k].entry.translation, '保存');
  assert.equal(D.mergeRecords(b, { [k]: null }, remote).conflicts[0].type, 'delete-modify');
  assert.equal(D.mergeRecords(b, remote, remote).canInstall, true); assert.equal(Object.keys(D.mergeRecords(b, remote, remote).pending).length, 0);
  const noBase = D.mergeRecords({}, local, remote); assert.equal(noBase.conflicts.length, 1);
  assert.equal(D.mergeRecords(b, {}, { [k]: null }).merged[k], null);
  assert.throws(() => D.resolveConflict(D.mergeRecords(b, local, remote), k, 'edited', row('不同身份', 'ja')));
});
test('三方编辑保留 userSelected、skip 与语言，显式删除可序列化往返', () => {
  const skip = row(); skip.entry = { ...skip.entry, category: 'uncertain', action: 'skip', translation: null };
  D.validatePackage(pack([skip]), { getDomain });
  const k = D.entryIdentity(row()), data = D.recordsMap([{ ...row(), deleted: true }]);
  assert.equal(data[k], null); assert.deepEqual(JSON.parse(JSON.stringify(data)), { [k]: null });
  const result = D.mergeRecords(D.recordsMap([row()]), D.recordsMap([skip]), D.recordsMap([row('新的远端')]));
  const resolved = D.resolveConflict(result, k, 'edited', row('最终人工译文'));
  assert.equal(resolved.pending[k].entry.userSelected, true);
});
test('同步只导出设置白名单，禁止 AI 对象、凭据、任务和过长提示词', () => {
  assert.deepEqual(D.syncPreferences({ targetLanguage: 'ja', apiKey: 'private', wt_ai: { token: 'private' }, inputContextK: 200 }), { targetLanguage: 'ja', inputContextK: 200 });
  const record = { kind: 'preference', id: 'settings', field: 'targetLanguage', value: 'ja', counter: 1, deviceId: device };
  D.validateSyncRecord(record);
  for (const field of ['apiKey', 'token', 'wt_ai', 'wt_tasks', 'endpoint']) assert.throws(() => D.validateSyncRecord({ ...record, field }));
  assert.throws(() => D.validateSyncRecord({ ...record, field: 'prompt', value: '中'.repeat(2000) }), /容量/);
  assert.throws(() => D.syncPreferences({ inputContextK: 2000 }));
  const profile={provider:'api',model:'fixture',endpoint:'https://gateway.example.com/v1/chat/completions',region:'',reasoningEffort:'auto'};D.validateSyncRecord({...record,field:'aiProfile:api',value:profile});
  assert.throws(()=>D.validateSyncRecord({...record,field:'aiProfile:api',value:{...profile,apiKey:'private'}}));
  assert.throws(()=>D.validateSyncRecord({...record,field:'aiProfile:deepl',value:profile}));
});
test('逐字段 Lamport 合并不使用电脑时间，安装删除标记压制旧离线记录及同计数重加', () => {
  const create = { kind: 'site', id: address, field: 'installed', value: true, counter: 1, deviceId: device };
  const deleted = { ...create, value: false, counter: 2, deviceId: device };
  const offline = { ...create, field: 'enabled', value: false, counter: 9, deviceId: otherDevice };
  assert.equal(D.mergeSync([create], [deleted, offline]).find(r => r.field === 'installed').value, false);
  assert.equal(D.mergeSync([deleted], [{ ...create, counter: 2, deviceId: otherDevice }])[0].value, false);
  assert.equal(D.mergeSync([deleted], [{ ...create, counter: 3, deviceId: otherDevice }])[0].value, true);
  assert.throws(() => D.mergeSync([create, { ...create, value: false }]), /身份内容冲突/);
});
test('同步分片按 UTF-8 配额校验，延迟空值不删除、混代分片不接受且容量有限', async () => {
  const rows = Array.from({ length: 80 }, (_, i) => ({ kind: 'site', id: `https://s${i}.example.com`, field: 'name', value: '名称'.repeat(40), counter: i + 1, deviceId: device }));
  const values = await D.packSync(rows); assert.ok(values.wt_install_head.count > 1);
  assert.deepEqual(await D.unpackSync(values), D.mergeSync(rows)); assert.equal(await D.unpackSync({}), null);
  for (const [key, value] of Object.entries(values)) assert.ok(D.bytes(key) + D.bytes(value) <= D.limits.syncItemBytes);
  const mixed = structuredClone(values); mixed.wt_install_0.revision = '0'.repeat(64); await assert.rejects(() => D.unpackSync(mixed), /尚未到齐/);
  const incomplete = structuredClone(values); delete incomplete.wt_install_1; await assert.rejects(() => D.unpackSync(incomplete));
  await assert.rejects(() => D.packSync(Array.from({ length: 400 }, (_, i) => ({ ...rows[0], id: `https://s${i}.example.com`, value: '名'.repeat(300) }))), /配额/);
});
test('本机迁移是幂等纯转换，保留人工、手动标记、多语言、跳过和并发候选，无可靠基线均待上传', async () => {
  let seq = 0; const ops = [], add = (kind, payload, deps = []) => { const op = { schemaVersion: 1, deviceId: device, seq: ++seq, opId: `${device}-${seq}`, siteId: address, generation: 1, kind, payload, deps }; ops.push(op); return op; };
  const create = add('create', { origin: address, name: 'Example', group: 'wrong-legacy-group', builtinId: null });
  const a = add('entry', entry(), [create.opId]); add('entry', entry('另一人工译文'), [create.opId]); add('entry', entry('保存する', 'ja'), [create.opId]);
  add('setting', { key: 'enabled', value: false }, [create.opId]); add('setting', { key: 'excludedPaths', value: ['/private'] }, [create.opId]);
  const skip = { ...entry(null, 'zh-Hans', 'Maybe'), category: 'uncertain', action: 'skip', translation: null }; add('entry', skip, [create.opId]);
  const database = { schemaVersion: 1, deviceId: device, seq, ops }, before = C.canonical(database), preferences = { targetLanguage: 'ja', requestTimeoutMinutes: 3, apiKey: 'must-not-export' };
  const staged = await M.prepare(database, preferences, getDomain); assert.equal(C.canonical(database), before);
  assert.deepEqual(await M.prepare(database, preferences, getDomain), staged); await M.verifyPrepared(staged, database, preferences, getDomain);
  assert.equal(staged.installations[0].enabled, false); assert.equal(staged.installations[0].group, 'example.com'); assert.equal(staged.groups.length, 2);
  const chinese = staged.groups.find(g => g.targetLanguage === 'zh-Hans'); assert.equal(chinese.baselineConfirmed, false); assert.equal(Object.keys(chinese.baseline).length, 0);
  assert.equal(Object.values(chinese.local).filter(r => r.entry.action === 'skip').length, 1); assert.equal(Object.values(chinese.conflicts)[0].length, 2);
  assert.ok(Object.values(chinese.conflicts)[0].some(c => c.opId === a.opId)); assert.equal(JSON.stringify(staged).includes('must-not-export'), false);
  const changed = structuredClone(staged); changed.groups[0].baselineConfirmed = true; await assert.rejects(() => M.verifyPrepared(changed, database, preferences, getDomain));
});
test('本机迁移保留已删网站、旧代次和缺依赖历史，非法输入不会部分转换', async () => {
  const create = { schemaVersion: 1, deviceId: device, seq: 1, opId: `${device}-1`, siteId: address, generation: 1, kind: 'create', payload: { origin: address, name: 'Example', group: 'example.com', builtinId: null }, deps: [] };
  const remove = { ...create, seq: 2, opId: `${device}-2`, kind: 'delete', payload: {}, deps: [create.opId] };
  const pending = { ...create, seq: 3, opId: `${device}-3`, kind: 'entry', payload: entry(), deps: [`${otherDevice}-1`] };
  const database = { schemaVersion: 1, deviceId: device, seq: 3, ops: [create, remove, pending] };
  const prepared = await M.prepare(database, {}, getDomain); assert.equal(prepared.installations[0].deleted, true); assert.deepEqual(prepared.pendingOperationIds, [pending.opId]); assert.deepEqual(prepared.backup.ops, database.ops);
  await assert.rejects(() => M.prepare({ ...database, token: 'fixture' }, {}, getDomain));
});
test('只读仓库固定同一提交，检查不下载词库，不使用 AI，下载保留精确安装范围', async () => {
  const f = await fixture(), commit = 'a'.repeat(40), calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options }); assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
    if (url.includes('/git/ref/')) return new Response(JSON.stringify({ ref: 'refs/heads/main', object: { sha: commit, type: 'commit' } }));
    assert.ok(url.endsWith('?ref=' + commit));
    if (url.includes('index.json')) return new Response(JSON.stringify(f.index));
    if (url.includes('manifest.json')) return new Response(f.manifestRaw);
    return new Response(f.raw);
  };
  const client = R.create({ repository, policy: {}, getDomain, fetch, token: 'fixture-read-only' });
  const checked = await client.check([{ group: 'example.com', origins: [address] }], 'zh-Hans');
  assert.equal(calls.length, 3); assert.equal(checked.groups[0].hasUpdate, true); assert.equal(calls.some(c => c.url.includes('/zh-Hans/')), false);
  const downloaded = await client.downloadGroup(checked.pin, 'example.com', 'zh-Hans', [address]);
  assert.deepEqual(downloaded.installedOrigins, [address]); assert.equal(downloaded.files[0].pack.records[0].entry.translation, '保存'); assert.equal(calls.length, 4);
  const rechecked=await client.check([{ group: 'example.com', origins: [address], revision: downloaded.revision }], 'zh-Hans'); assert.equal(calls.length, 7);assert.equal(rechecked.groups[0].hasUpdate,false);assert.equal(calls.filter(c=>c.url.includes('/zh-Hans/')).length,1,'主动再次检查必须读取最新索引，但不重新下载词库');
  assert.equal(calls.every(c => c.options.method === 'GET'), true);
  assert.equal(D.currentGeneration({ language: 'ja', generation: 2 }, { language: 'zh-Hans', generation: 2 }), false);
});
test('仓库异常不返回部分组；哈希损坏、错误协议、未发布私有仓库和限流明确失败', async () => {
  const f = await fixture(), commit = 'b'.repeat(40);
  for (const status of [401, 403, 404, 429]) {
    const client = R.create({ repository, getDomain, policy: {}, fetch: async () => new Response('', { status }) });
    await assert.rejects(() => client.readIndex(), e => e.status === status);
  }
  const client = R.create({ repository, getDomain, policy: {}, fetch: async url => url.includes('/git/ref/') ? new Response(JSON.stringify({ ref: 'refs/heads/main', object: { sha: commit, type: 'commit' } })) : url.includes('index.json') ? new Response(JSON.stringify(f.index)) : url.includes('manifest.json') ? new Response(f.manifestRaw) : new Response(f.raw + 'bad') });
  const checked = await client.check([{ group: 'example.com', origins: [address] }], 'zh-Hans');
  await assert.rejects(() => client.downloadGroup(checked.pin, 'example.com', 'zh-Hans', [address]), /SHA-256/);
  assert.equal((await client.check([{ group: 'example.com', origins: [address] }], 'ja')).groups[0].status, 'no-language');
  assert.throws(() => R.configuration({ ...repository, branch: '../main' }));
});
