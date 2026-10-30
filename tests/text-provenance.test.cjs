'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const C = require('../extension/managed-core');
const source = name => fs.readFileSync(path.resolve(__dirname, '../extension', name), 'utf8');
const tailscale = require('../sites/tailscale/site.json');
const wait = (ms = 220) => new Promise(resolve => setTimeout(resolve, ms));
const initial = 'Unlisted initial notice for independent review';
const changed = 'New untranslated notice after the site updates';

test('采集请求在途时的页面变化必须补发；后台拒绝不能当作已保存',async t=>{
  const dom=new JSDOM('<html><body><nav><button>First label</button></nav></body></html>',{url:'https://example.com/initial',runScripts:'outside-only'});t.after(()=>dom.window.close());const w=dom.window,calls=[];let release;
  w.chrome={runtime:{id:'test',onMessage:{addListener(){}},sendMessage:async m=>{
    if(m.type==='wt:page')return {ok:true,result:{captureId:'session',globalEnabled:true}};
    calls.push(m);if(calls.length===1)return new Promise(r=>release=r);
    return {ok:true,result:true};
  }}};
  w.eval(source('managed-core.js'));w.eval(source('text-provenance.js'));w.eval(source('managed-content.js'));await wait(30);assert.ok(release);
  w.history.pushState({},'','/logs');w.document.querySelector('button').textContent='Second label';await wait(200);
  release({ok:false,error:'fixture rejected'});await wait(650);
  assert.ok(calls.slice(1).some(m=>m.scan.path==='/logs' && m.scan.items.some(i=>i.sourceText==='Second label')));
  const count=calls.length;await wait(600);assert.equal(calls.length,count,'成功保存后同一快照不重复提交');
});

test('表单提示翻译、同轮属性更新和语言恢复不会读取或修改输入值',async t=>{
  const dom=new JSDOM('<html lang="en"><body><form><input placeholder="First name" value="private-user"><input type="password" placeholder="Create a password" value="secret"><textarea placeholder="Your message">private-message</textarea></form></body></html>',{url:'https://example.com/signup',runScripts:'outside-only'});
  t.after(()=>dom.window.close());const w=dom.window;
  const site={id:'https://example.com',enabled:true,deleted:false,targetLanguage:'zh-Hans',excludedPaths:[],entries:{}};
  w.chrome={runtime:{id:'test',onMessage:{addListener(){}},sendMessage:async()=>({ok:true,result:{site,globalEnabled:true}})}};
  w.eval(source('managed-core.js'));w.eval(source('text-provenance.js'));w.eval(source('managed-content.js'));await wait();
  const input=w.document.querySelector('input');
  const scan=w.WTPage.collect();assert.deepEqual(Array.from(scan.items,i=>i.sourceText),['First name','Create a password','Your message']);
  for(const item of scan.items){const e={...item,sourceLanguage:null,targetLanguage:'zh-Hans',category:'ui',action:'translate',origin:'ai',translation:'提示译文'};site.entries[C.entryKey(e)]=e;}
  w.WTPage.apply();assert.equal(input.placeholder,'提示译文');assert.equal(input.value,'private-user');assert.equal(w.document.querySelector('[type=password]').value,'secret');
  assert.equal(w.document.querySelector('textarea').value,'private-message');assert.equal(w.WTText.sourceAttribute(input,'placeholder'),'First name');assert.equal(w.WTPage.collect().items.length,0);
  input.placeholder='Updated prompt';assert.equal(w.WTPage.collect().items[0].sourceText,'Updated prompt');
  input.placeholder='Another prompt';input.placeholder='Latest prompt';assert.equal(w.WTPage.collect().items[0].sourceText,'Latest prompt');
  site.targetLanguage='ja';w.WTPage.apply();assert.equal(input.placeholder,'Latest prompt');assert.equal(w.document.querySelector('[type=password]').placeholder,'Create a password');
  site.enabled=false;w.WTPage.apply();assert.equal(w.document.documentElement.lang,'en');
});

async function fixture(t, builtinId = 'tailscale') {
  const dom = new JSDOM(`<html lang="en"><body><nav><button>Pricing</button></nav><main><p id="notice">${initial}</p></main></body></html>`, { url:'https://tailscale.com/', runScripts:'outside-only' });
  t.after(() => dom.window.close());
  const site = { id:'https://tailscale.com', builtinId, enabled:true, deleted:false, targetLanguage:'zh-Hans', excludedPaths:[], entries:{} };
  const view = { site, globalEnabled:true }, listeners = [], calls = [];
  const w = dom.window;
  w.chrome = { runtime: { id:'fixture', onMessage:{ addListener() {} }, sendMessage:async message => { calls.push(message.type); return { ok:true, result:view }; } } };
  w.eval(source('managed-core.js')); w.eval(source('text-provenance.js')); w.eval(source('managed-content.js'));
  w.FixedSitePreferences = {
    ready:Promise.resolve({}),
    subscribe(fn) { listeners.push(fn); fn({}); },
    isEnabled() { return site.enabled && !site.deleted && view.globalEnabled && site.targetLanguage === 'zh-Hans'; }
  };
  if (builtinId === 'tailscale') w.eval(`(() => { const SITE=${JSON.stringify(tailscale)};\n${source('site-runtime.js')}\n})();`);
  await wait();
  return {
    w, site, view, calls,
    notice:w.document.querySelector('#notice'), button:w.document.querySelector('button'),
    collect:() => Array.from(w.WTPage.collect().items, item => item.sourceText),
    refresh:async () => { listeners.forEach(fn => fn({})); w.WTPage.apply(); await wait(); }
  };
}

test('内置与自定义网站的 characterData 更新都采集新原文，连续更新只保留最新值', async t => {
  for (const builtin of ['tailscale', null]) {
    const f = await fixture(t, builtin), node = f.notice.firstChild;
    assert.ok(f.collect().includes(initial));
    node.data = changed;
    assert.ok(f.collect().includes(changed), '同一事件循环中采集也不能等 MutationObserver 才更新原文');
    await wait(); assert.ok(f.collect().includes(changed)); assert.ok(!f.collect().includes(initial));
    node.data = 'Intermediate site notice'; node.data = 'Latest site notice';
    await wait(); assert.ok(f.collect().includes('Latest site notice')); assert.ok(!f.collect().includes(changed));
    f.notice.textContent = 'Site replaced the whole text node'; await wait();
    assert.ok(f.collect().includes('Site replaced the whole text node'));
    assert.deepEqual(f.calls, ['wt:page'], '动态更新和采集不得自行触发 AI');
  }
});

test('真实内置词库写入才排除 AI 候选，节点改成未收录英文后重新进入候选', async t => {
  const f = await fixture(t), node = f.button.firstChild;
  assert.equal(node.data, '价格'); assert.equal(f.w.WTText.source(node), 'Pricing');
  assert.deepEqual(f.collect(), [initial]);
  node.data = 'Settings'; await wait();
  assert.equal(node.data, '设置'); assert.equal(f.w.WTText.source(node), 'Settings'); assert.deepEqual(f.collect(), [initial]);
  node.data = 'Unknown navigation action'; await wait();
  assert.equal(f.w.WTText.owner(node), null); assert.ok(f.collect().includes('Unknown navigation action'));
  node.data = 'Pricing'; await wait(); assert.equal(node.data, '价格'); assert.deepEqual(f.collect(), [initial]);
});

test('内置与增量引擎共用最新原文；连续改写、停用和语言切换不回填旧源文', async t => {
  const f = await fixture(t), node = f.notice.firstChild;
  const put = (sourceText, translation, targetLanguage = 'zh-Hans') => {
    const e = { sourceText, translation, targetLanguage, path:'/', context:'main/p/text', sourceLanguage:null, category:'ui', action:'translate', origin:'ai' };
    f.site.entries[C.entryKey(e)] = e;
  };
  put(initial, '已保存的初始说明'); await f.refresh();
  assert.equal(node.data, '已保存的初始说明'); assert.equal(f.w.WTText.owner(node), 'managed');
  assert.deepEqual(f.collect(), []);assert.equal(f.w.WTText.source(node),initial);
  node.data = changed; await wait(); assert.ok(f.collect().includes(changed));
  put(changed, '已保存的新说明'); await f.refresh(); assert.equal(node.data, '已保存的新说明');
  node.data = 'Latest source after another update'; await wait();
  put(node.data, '再次保存的说明'); await f.refresh(); assert.equal(node.data, '再次保存的说明');
  f.view.globalEnabled = false; await f.refresh();
  assert.equal(node.data, 'Latest source after another update'); assert.equal(f.button.textContent, 'Pricing');
  assert.equal(f.w.document.documentElement.lang, 'en'); assert.equal(f.w.document.querySelector('[data-website-translator]'), null);
  f.site.targetLanguage = 'ja'; f.view.globalEnabled = true;
  put('Latest source after another update', '最新のお知らせ', 'ja'); await f.refresh();
  assert.equal(node.data, '最新のお知らせ'); assert.equal(f.button.textContent, 'Pricing');
  assert.equal(f.w.document.documentElement.lang, 'ja');
  f.site.targetLanguage = 'zh-Hans'; await f.refresh();
  assert.equal(node.data, '再次保存的说明'); assert.equal(f.button.textContent, '价格');
  assert.deepEqual(f.collect(), []);assert.equal(f.w.WTText.source(node),'Latest source after another update');
});

test('同一轮站点写入与内置写入能精确交接，不能用旧值相等推断写入者', async t => {
  const f = await fixture(t, null), node = f.notice.firstChild;
  f.w.WTText.writeText(node, '已知内置译文', 'builtin');
  node.data = changed;
  f.w.WTText.writeText(node, '新内置译文', 'builtin');
  assert.equal(f.w.WTText.source(node), changed); assert.ok(!f.collect().includes('新内置译文'));
  // Even a site change away and back to a previous output is an external write.
  node.data = 'Transient source'; node.data = '新内置译文';
  assert.equal(f.w.WTText.owner(node), null); assert.equal(f.w.WTText.source(node), '新内置译文');
  node.data = 'Final untranslated source';
  f.w.WTText.restore(node, 'builtin'); assert.equal(node.data, 'Final untranslated source');
});

test('GitHub 通用文本及选择器替换显式交接原文；网站再改写后可采集', async t => {
  const f = await fixture(t, 'github');
  f.w.FeatureSet = { enable_extension:true };
  f.w.pageConfig = { staticDict:{Pricing:'价格'}, regexpRules:[], textCache:new Map(), tranSelectors:[['#notice', '选择器译文']] };
  f.w.eval(fs.readFileSync(path.resolve(__dirname, '../chrome/src/features/ui-localization.js'), 'utf8'));
  f.w.transElement(f.button.firstChild, 'data'); f.w.transBySelector();
  assert.equal(f.button.textContent, '价格'); assert.equal(f.notice.textContent, '选择器译文');
  assert.deepEqual(f.collect(), []); assert.equal(f.w.WTText.content(f.notice), initial);
  f.w.transBySelector(); assert.equal(f.w.WTText.content(f.notice), initial, '重复选择器扫描不能丢失源文');
  f.notice.firstChild.data = changed; f.w.transElement(f.notice.firstChild, 'data'); await wait();
  assert.deepEqual(f.collect(), [changed]);
});
