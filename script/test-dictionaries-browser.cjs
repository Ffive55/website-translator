'use strict';
// Real IndexedDB transactions in an isolated Edge profile. No account, AI or GitHub calls.
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..');
async function main() {
  const output = path.join(ROOT, '.cache/dictionary-browser'); await fs.mkdir(output, { recursive: true });
  const fixture = path.join(output, 'extension');
  await fs.cp(path.join(ROOT, 'edge'), fixture, { recursive: true, filter: name => !name.includes(path.sep + 'local-helper') });
  const context = await chromium.launchPersistentContext(path.join(output, 'profile-' + Date.now()), { channel: 'msedge', headless: true,
    args: [`--disable-extensions-except=${fixture}`, `--load-extension=${fixture}`], viewport: { width: 1280, height: 900 } });
  try {
    let [worker] = context.serviceWorkers(); if (!worker) worker = await context.waitForEvent('serviceworker');
    const id = worker.url().split('/')[2], ui = await context.newPage();
    await ui.goto(`chrome-extension://${id}/managed/managed.html`); await ui.waitForFunction(()=>document.querySelector('#version').textContent.length>0);await ui.evaluate(()=>chrome.runtime.sendMessage({type:'wt:state'}));
    const githubRaw = await fs.readFile(path.join(ROOT, 'dictionaries/github.com/zh-Hans/github.com.json'), 'utf8');
    const githubManifest = JSON.parse(await fs.readFile(path.join(ROOT, 'dictionaries/github.com/manifest.json'), 'utf8'));
    const description = githubManifest.languages['zh-Hans'].files.find(f => f.id === 'github.com');
    const result = await worker.evaluate(async ({ githubRaw, description }) => {
      const C = WTCore, D = C.dictionary, policy = await (await fetch(chrome.runtime.getURL('managed/dictionary-policy.json'))).json();
      const options = { name: 'wt-dictionary-test', getDomain: tldts.getDomain, policy }, checks = [];
      const check = (ok, message) => { if (!ok) throw new Error(message); checks.push(message); };
      const rejects = async (fn, message) => { let failed = false; try { await fn(); } catch { failed = true; } check(failed, message); };
      const before = await chrome.storage.local.get(['wt_database', 'wt_tasks']);
      const repository = { owner: 'Ffive55', repo: 'website-translator', branch: 'main' }, origin = 'https://dictionary-fixture.example', group = 'dictionary-fixture.example';
      const row = (translation = '基础译文', sourceText = 'Save') => ({ site: origin, entry: { sourceText, context: 'main/button/text', path: '/', sourceLanguage: null, targetLanguage: 'zh-Hans', category: 'ui', action: 'translate', translation, origin: 'ai' } });
      async function candidate(translation = '基础译文', extra = false) {
        const pack = { schemaVersion: 1, minReaderVersion: 1, group, targetLanguage: 'zh-Hans', origins: [origin], kind: 'entries', records: [row(translation)], adapter: null }, raw = JSON.stringify(pack);
        const description = { id: 'dictionary-fixture.example', path: `dictionaries/${group}/zh-Hans/dictionary-fixture.example.json`, kind: 'entries', origins: [origin], sha256: await D.digest(raw), bytes: D.bytes(raw), requires: [] };
        const files = [{ description, pack, raw }];
        if (extra) {
          const second = { ...pack, records: [row('取消', 'Cancel')] }, secondRaw = JSON.stringify(second);
          files.push({ pack: second, raw: secondRaw, description: { ...description, id: 'second', path: `dictionaries/${group}/zh-Hans/second.json`, sha256: await D.digest(secondRaw), bytes: D.bytes(secondRaw) } });
        }
        return { schemaVersion: 1, repository, commit: 'a'.repeat(40), group, targetLanguage: 'zh-Hans', installedOrigins: [origin],
          revision: await D.digest({ group, language: 'zh-Hans', origins: [origin], files: files.map(f => f.description) }), missing: [], files };
      }
      let store = await C.dictionaryStore.open(options);
      const setup = { repository, targetLanguage: 'zh-Hans', installations: [{ origin, generation: 1 }] };
      let state = await store.setContext(setup), revision = state.revision;
      check((await store.setContext(setup)).revision === revision, '相同安装上下文幂等');
      const initial = await candidate(); check((await store.install(initial, revision)).installed, '分组首次完整安装');
      const edit = row('本机人工'); edit.entry.origin = 'manual'; edit.entry.userSelected = true;
      await store.edit(repository, group, 'zh-Hans', edit, revision);
      const newer = await candidate('远端新版');
      const conflict = await store.install(newer, revision), active = await store.read(repository, group, 'zh-Hans');
      check(!conflict.installed && conflict.conflicts.length === 1 && active.contentRevision === initial.revision && active.local[D.entryIdentity(edit)].entry.userSelected, '冲突保留旧基线与本机人工效果，候选暂存');
      check((await store.resolve(repository, group, 'zh-Hans', D.entryIdentity(edit), 'remote', null, revision)).installed, '明确采用远端后原子切换');
      check(Object.keys((await store.read(repository, group, 'zh-Hans')).local).length === 0, '相同远端结果清除重复修改状态');
      const historical=await candidate('新提交译文');historical.commit='b'.repeat(40);await store.install(historical,revision);
      await rejects(()=>store.install(initial,revision),'已安装新提交后拒绝历史提交迟到重放');
      const firstTicket=await store.beginDownload(repository,group,'zh-Hans',revision),secondTicket=await store.beginDownload(repository,group,'zh-Hans',revision);
      await rejects(()=>store.install(historical,revision,firstTicket),'同一上下文中较新的下载请求使旧请求失效');
      await store.install(historical,revision,secondTicket);
      const beforeFailure = await store.read(repository, group, 'zh-Hans'), damaged = await candidate('应拒绝', true); damaged.files[1].raw += 'bad';
      await rejects(() => store.install(damaged, revision), '一个文件校验失败时整个分组不切换');
      check(C.canonical(beforeFailure) === C.canonical(await store.read(repository, group, 'zh-Hans')), '校验失败保留完整旧词库');
      await store.edit(repository, group, 'zh-Hans', edit, revision);
      const another = await candidate('远端再改'); another.commit='c'.repeat(40); await store.install(another, revision);
      await store.edit(repository, group, 'zh-Hans', row('新修改', 'Cancel'), revision);
      await rejects(() => store.resolve(repository, group, 'zh-Hans', D.entryIdentity(edit), 'remote', null, revision), '冲突处理期间新编辑使旧解决操作失效');
      await store.install(another, revision); await store.resolve(repository, group, 'zh-Hans', D.entryIdentity(edit), 'local', null, revision);
      const beforeEdits = await store.read(repository, group, 'zh-Hans');
      await Promise.all([store.edit(repository, group, 'zh-Hans', row('一', 'First'), revision), store.edit(repository, group, 'zh-Hans', row('二', 'Second'), revision)]);
      const afterEdits = await store.read(repository, group, 'zh-Hans');
      check(afterEdits.revision === beforeEdits.revision + 2 && afterEdits.local[D.entryIdentity(row('', 'First'))] && afterEdits.local[D.entryIdentity(row('', 'Second'))], '并发 IndexedDB 编辑串行提交，保留两条新修改');
      state = await store.setContext({ ...setup, targetLanguage: 'ja' });
      await rejects(() => store.install(initial, revision), '目标语言变化拒绝迟到下载');
      revision = state.revision;
      await store.setContext({ ...setup, installations: [] }); await rejects(() => store.install(initial, revision), '删除网站后旧下载不能复活安装记录');
      check(!await chrome.permissions.contains({ origins: [origin + '/*'] }), '缓存与恢复不会自行授予网站权限');
      const prepared = await C.dictionaryMigration.prepare(before.wt_database, {}, tldts.getDomain);
      const staged1 = await store.stageLegacy(prepared), staged2 = await store.stageLegacy(prepared);
      check(staged1.sourceSha256 === staged2.sourceSha256 && staged1.runtimeSwitched === false, '本机迁移备份幂等暂存且不切换真实工作数据');
      const imported=await C.dictionaryStore.open({...options,name:'wt-import-test'}),importContext=await imported.setContext(setup);
      await imported.install(initial,importContext.revision);await imported.edit(repository,group,'zh-Hans',row('备份独有','BackupOnly'),importContext.revision);
      const backup=await imported.exportData();await imported.edit(repository,group,'zh-Hans',row('当前独有','CurrentOnly'),importContext.revision);
      await imported.importData(backup,'import-fixture');let importedState=await imported.read(repository,group,'zh-Hans');
      check(Object.keys(importedState.local).length===2,'备份与当前本机增量合并后两方都保留待上传状态');const importRevision=importedState.revision;
      await imported.importData(backup,'import-fixture');check((await imported.read(repository,group,'zh-Hans')).revision===importRevision,'中断后相同导入 ID 不重复应用 IndexedDB');
      const fresh=await candidate('新远端');fresh.commit='d'.repeat(40);await imported.install(fresh,importContext.revision);const beforeOld=await imported.read(repository,group,'zh-Hans');
      await rejects(()=>imported.importData(backup,'older-backup'),'旧备份不能覆盖已安装的新远端基线');check(C.canonical(await imported.read(repository,group,'zh-Hans'))===C.canonical(beforeOld),'拒绝导入后原词库及本地修改逐字不变');
      const otherRepository={...repository,repo:'another-dictionary'},otherContext=await imported.setContext({...setup,repository:otherRepository});await imported.edit(otherRepository,group,'zh-Hans',row('另一仓库本地'),otherContext.revision);await imported.resetLocal(origin,otherRepository,'1:false');
      check(C.canonical(await imported.read(repository,group,'zh-Hans'))===C.canonical(beforeOld),'删除另一仓库的网站不清空当前仓库的本地修改');check((await imported.exportArchives()).some(a=>Object.keys(a.local).length===1),'移除网站的未上传修改保留在可导出归档');
      const invalidBackup=structuredClone(backup);invalidBackup[0].group='other.example';await rejects(()=>imported.importData(invalidBackup,'wrong-scope'),'备份文件与分组范围不符时拒绝导入');imported.close();
      const largeContext = await store.setContext({ repository, targetLanguage: 'zh-Hans', installations: [{ origin: 'https://github.com', generation: 1 }] });
      const large = { schemaVersion: 1, repository, commit: 'b'.repeat(40), group: 'github.com', targetLanguage: 'zh-Hans', installedOrigins: ['https://github.com'], missing: [],
        revision: await D.digest({ group: 'github.com', language: 'zh-Hans', origins: ['https://github.com'], files: [description] }), files: [{ description, raw: githubRaw, pack: JSON.parse(githubRaw) }] };
      check((await store.install(large, largeContext.revision)).installed, '真实 5.7 MB GitHub 转换词库通过完整校验并写入 IndexedDB');
      store.close(); store = await C.dictionaryStore.open(options);
      check((await store.read(repository, 'github.com', 'zh-Hans')).contentRevision === large.revision, '关闭和重新打开数据库后大词库可恢复');
      const after = await chrome.storage.local.get(['wt_database', 'wt_tasks']);
      check(C.canonical(before) === C.canonical(after), '整个缓存与迁移测试不改旧数据库、不建立 AI 任务');
      const usage = await navigator.storage.estimate(); store.close();
      return { checks, count: checks.length, usage: usage.usage, quota: usage.quota, browser: navigator.userAgent };
    }, { githubRaw, description });
    assert.equal(result.count, 25); await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally { await context.close(); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
