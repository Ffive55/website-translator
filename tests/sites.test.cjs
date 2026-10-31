'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { JSDOM } = require('jsdom');
const { ROOT, validateSite, loadSites } = require('../script/site-config');
const runtime = fs.readFileSync(path.join(ROOT, 'extension/site-runtime.js'), 'utf8');
const preferencesCode = fs.readFileSync(path.join(ROOT, 'extension/site-preferences.js'), 'utf8');
const tailscale = JSON.parse(fs.readFileSync(path.join(ROOT, 'sites/tailscale/site.json'), 'utf8'));
const wait = (ms = 160) => new Promise(resolve => setTimeout(resolve, ms));

function tempProject(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'site-config-test-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('site-config-test-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

async function page(t, html, { url = 'https://console.tailscale.com/admin/machines', site = tailscale, initial = true, siteEnabled = true, built = false } = {}) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const listeners = [];
  const errors = [];
  dom.window.console.error = (...args) => errors.push(args.join(' '));
  dom.window.chrome = {
    runtime: { onMessage: { addListener() {} } },
    storage: {
      sync: { get: async () => ({ enable_extension: initial, [`site_enabled_${site.id}`]: siteEnabled }) },
      onChanged: { addListener: listener => listeners.push(listener) }
    }
  };
  const source = built ? fs.readFileSync(path.join(ROOT, 'chrome/sites/tailscale.js'), 'utf8') :
    `(() => { const SITE = ${JSON.stringify(site)};\n${runtime}\n})();`;
  dom.window.eval(`const SUPPORTED_SITES = ${JSON.stringify([site])};\n${preferencesCode}`);
  dom.window.eval(source);
  await wait();
  assert.deepEqual(errors, [], '运行时不应产生初始化错误');
  return {
    window: dom.window, document: dom.window.document,
    toggle: async enabled => {
      listeners.forEach(listener => listener({ enable_extension: { newValue: enabled } }, 'sync'));
      await wait();
    },
    toggleSite: async (id, enabled) => {
      listeners.forEach(listener => listener({ [`site_enabled_${id}`]: { newValue: enabled } }, 'sync'));
      await wait();
    }
  };
}

test('生成后的 Tailscale 脚本翻译工作台入口，保留链接、子元素与事件', async t => {
  const { window, document } = await page(t, '<nav><a href="/admin/machines">Machines</a><button id="settings"><svg></svg> Settings </button></nav><p>3 machines</p>', { built: true });
  const button = document.querySelector('button');
  let clicked = false;
  button.addEventListener('click', () => { clicked = true; });
  button.dispatchEvent(new window.MouseEvent('click'));
  assert.equal(clicked, true);
  assert.equal(button.textContent, ' 设置 ');
  assert.ok(button.querySelector('svg'));
  assert.equal(document.querySelector('a').getAttribute('href'), '/admin/machines');
  assert.equal(document.querySelector('a').textContent, '设备');
  assert.equal(document.querySelector('p').textContent, '3 台设备');
});

test('动态新增节点、属性及状态变化会再次翻译，不反复触发自身观察器', async t => {
  const { document } = await page(t, '<main><span id="status">Connected</span></main>');
  const status = document.querySelector('#status');
  status.firstChild.data = 'Disconnected';
  const button = document.createElement('button');
  button.textContent = 'Filters';
  button.setAttribute('title', 'Search devices');
  document.querySelector('main').append(button);
  await wait();
  assert.equal(status.textContent, '已断开');
  assert.equal(button.textContent, '筛选');
  assert.equal(button.title, '搜索设备');
  button.setAttribute('aria-label', 'Save changes');
  await wait();
  assert.equal(button.getAttribute('aria-label'), '保存更改');
  const observer = new document.defaultView.MutationObserver(() => assert.fail('稳定页面不应持续改写 DOM'));
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  await wait();
  observer.disconnect();
});

test('保护代码、编辑器、输入值、设备名、IP、邮箱与品牌', async t => {
  const { document } = await page(t, `<pre>Settings</pre><code>Save</code><textarea>Settings</textarea>
    <div contenteditable="plaintext-only">Settings</div><div class="monaco-editor">Settings</div>
    <div translate="no">Settings</div><div class="notranslate">Settings</div>
    <input value="Settings" placeholder="Search devices"><a href="/admin/machines/100.64.0.1">Settings</a>
    <p>100.64.0.1</p><p>settings@example.com</p><p>Windows</p><p>Tailscale</p>`);
  assert.equal(document.querySelector('pre').textContent, 'Settings');
  assert.equal(document.querySelector('code').textContent, 'Save');
  assert.equal(document.querySelector('textarea').value, 'Settings');
  for (const div of document.querySelectorAll('div')) assert.equal(div.textContent, 'Settings');
  assert.equal(document.querySelector('input').value, 'Settings');
  assert.equal(document.querySelector('input').placeholder, '搜索设备');
  assert.equal(document.querySelector('a').textContent, 'Settings');
  assert.deepEqual([...document.querySelectorAll('p')].map(node => node.textContent), ['100.64.0.1', 'settings@example.com', 'Windows', 'Tailscale']);
});

test('首页翻译主要内容，文档正文保持原范围；登录页可翻译表单提示', async t => {
  const { document } = await page(t, '<nav>Platform</nav><a href="/pricing">Pricing</a><button>Get started</button><article><h1>Installation takes minutes</h1><p>An original article paragraph.</p></article>', { url: 'https://tailscale.com/' });
  assert.equal(document.querySelector('nav').textContent, '平台');
  assert.equal(document.querySelector('a').textContent, '价格');
  assert.equal(document.querySelector('button').textContent, '开始使用');
  assert.equal(document.querySelector('h1').textContent, '几分钟即可安装');
  assert.equal(document.querySelector('p').textContent, 'An original article paragraph.');
  const docs = await page(t, '<article><h1>Settings</h1><p>Machines</p></article>', { url: 'https://tailscale.com/docs/example' });
  assert.equal(docs.document.querySelector('h1').textContent, 'Settings');
  assert.equal(docs.document.querySelector('p').textContent, 'Machines');
  const login = await page(t, '<input placeholder="Enter your email..."><button>Sign in with Google</button>', { url: 'https://login.tailscale.com/login' });
  assert.equal(login.document.querySelector('input').placeholder, '输入邮箱…');
  assert.equal(login.document.querySelector('button').textContent, '使用 Google 登录');
});

test('关闭恢复原文与属性，重新开启后使用站点最新状态', async t => {
  const { document, toggle } = await page(t, '<button title="Filters">Settings</button><span>Connected</span>');
  document.querySelector('span').firstChild.data = 'Disconnected';
  await toggle(false);
  assert.equal(document.querySelector('button').textContent, 'Settings');
  assert.equal(document.querySelector('button').title, 'Filters');
  assert.equal(document.querySelector('span').textContent, 'Disconnected');
  await toggle(true);
  assert.equal(document.querySelector('span').textContent, '已断开');
  assert.equal(document.querySelector('button').textContent, '设置');
});

test('初始关闭时不翻译，启用后翻译现有页面', async t => {
  const { document, toggle } = await page(t, '<button>Settings</button>', { initial: false });
  assert.equal(document.querySelector('button').textContent, 'Settings');
  await toggle(true);
  assert.equal(document.querySelector('button').textContent, '设置');
});

test('SPA pushState 切换页面词条并恢复离开翻译范围的原文', async t => {
  const site = { ...tailscale, selectors: [], dictionary: { Settings: '公共设置' }, pages: [
    { pathPrefix: '/one', dictionary: { Settings: '第一页设置' } },
    { pathPrefix: '/two', selectors: ['nav'], dictionary: { Settings: '第二页设置' } }
  ] };
  const { window, document } = await page(t, '<nav>Settings</nav><p>Settings</p>', { site, url: 'https://tailscale.com/one' });
  assert.equal(document.querySelector('nav').textContent, '第一页设置');
  window.history.pushState({}, '', '/two');
  await wait(650);
  assert.equal(document.querySelector('nav').textContent, '第二页设置');
  assert.equal(document.querySelector('p').textContent, 'Settings');
});

test('动态添加免翻标记时恢复该区域', async t => {
  const { document } = await page(t, '<div><button>Settings</button></div>');
  document.querySelector('div').setAttribute('translate', 'no');
  await wait();
  assert.equal(document.querySelector('button').textContent, 'Settings');
});

test('不在未授权或伪装域名运行；子域名匹配有边界', async t => {
  for (const url of ['https://tailscale.com.evil.test/admin', 'https://github.com/admin']) {
    const { document } = await page(t, '<button>Settings</button>', { url });
    assert.equal(document.querySelector('button').textContent, 'Settings');
  }
  const site = { ...tailscale, matches: ['https://*.example.com/*'] };
  const allowed = await page(t, '<button>Settings</button>', { site, url: 'https://sub.example.com/admin' });
  assert.equal(allowed.document.querySelector('button').textContent, '设置');
});

test('配置校验拒绝任意站点、非法正则、危险属性和路径穿越', () => {
  assert.throws(() => validateSite({ ...tailscale, matches: ['https://*/*'] }), /无效域名/);
  assert.throws(() => validateSite({ ...tailscale, id: '../oops' }), /id 必须/);
  assert.throws(() => validateSite({ ...tailscale, attributes: ['value'] }), /attributes/);
  assert.throws(() => validateSite({ ...tailscale, regexp: [{ pattern: '[', replacement: 'x' }] }), /正则错误/);
});

test('网站注册自动发现；不同适配器不能接管重叠域名', t => {
  const directory = tempProject(t);
  for (const site of [...loadSites(), { id: 'another', name: '另一个', engine: 'dictionary', matches: ['https://*.tailscale.com/*'] }]) {
    fs.mkdirSync(path.join(directory, 'sites', site.id), { recursive: true });
    fs.writeFileSync(path.join(directory, 'sites', site.id, 'site.json'), JSON.stringify(site));
  }
  assert.throws(() => loadSites(directory), /域名冲突/);
});

test('三种浏览器仅对指定域名注入对应脚本，新增站点不加载 GitHub 词库', () => {
  for (const browser of (process.env.WT_BROWSER?[process.env.WT_BROWSER]:['chrome','edge','firefox'])) {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, browser, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.permissions, ['storage', 'scripting', 'activeTab', 'nativeMessaging', 'alarms', 'contextMenus', ...(browser==='edge'?['unlimitedStorage']:[])]);
    const entry = manifest.content_scripts.find(item => item.matches.includes('https://console.tailscale.com/*'));
    assert.deepEqual(entry.js, ['managed/core.js', 'managed/text-provenance.js', 'managed/content.js', ...(browser==='edge'?['managed/tldts.js','managed/dictionary-core.js','managed/dictionary-adapters.js','managed/github-dictionary-handlers.js','managed/dictionary-loader.js']:[]), 'sites/catalog.js', 'sites/preferences.js', 'sites/browser-translation-guard.js', 'sites/tailscale.js']);
    assert.equal(entry.run_at, 'document_start');
    assert.ok(!manifest.host_permissions.includes('https://*/*'));
    for (const filename of entry.js) assert.ok(fs.existsSync(path.join(ROOT, browser, filename)));
    if(browser==='edge'){assert.ok(!fs.existsSync(path.join(ROOT,browser,'locals.js')));assert.ok(!fs.readFileSync(path.join(ROOT,browser,'sites/tailscale.js'),'utf8').includes('Installation takes minutes'));}else assert.equal(fs.readFileSync(path.join(ROOT, browser, 'sites/tailscale.js'), 'utf8'), fs.readFileSync(path.join(ROOT, 'chrome/sites/tailscale.js'), 'utf8'));
  }
  execFileSync(process.execPath, ['script/build-sites.js', '--check', ...(process.env.WT_BROWSER?['--browser',process.env.WT_BROWSER]:[])], { cwd: ROOT });
});

test('新增网站命令贯通三端构建和停用，不需要修改核心代码', t => {
  const directory = tempProject(t);
  fs.cpSync(path.join(ROOT, 'extension'), path.join(directory, 'extension'), { recursive: true });
  fs.mkdirSync(path.join(directory, 'node_modules/tldts/dist'), { recursive: true });
  for (const file of ['LICENSE', 'dist/index.umd.min.js']) fs.copyFileSync(path.join(ROOT, 'node_modules/tldts', file), path.join(directory, 'node_modules/tldts', file));
  for (const file of ['script/add-site.js', 'script/site-config.js', 'script/build-sites.js',
    'extension/site-runtime.js', 'extension/browser-translation-guard.js', 'extension/site-preferences.js', 'sites/github/site.json',
    'package.json', 'chrome/manifest.json', 'edge/manifest.json', 'firefox/manifest.json']) {
    fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, file), path.join(directory, file));
  }
  const run = (...args) => execFileSync(process.execPath, args, { cwd: directory, stdio: 'pipe' });
  run('script/add-site.js', 'example', 'https://example.com', '示例网站');
  const filename = path.join(directory, 'sites/example/site.json');
  const original = fs.readFileSync(filename, 'utf8');
  assert.throws(() => run('script/add-site.js', 'example', 'https://example.com', '不会覆盖'));
  assert.equal(fs.readFileSync(filename, 'utf8'), original);
  run('script/build-sites.js');
  run('script/build-sites.js', '--check');
  for (const browser of ['chrome', 'edge', 'firefox']) {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, browser, 'manifest.json'), 'utf8'));
    assert.ok(manifest.host_permissions.includes('https://example.com/*'));
    assert.ok(manifest.content_scripts.some(entry => entry.js.includes('sites/example.js')));
    assert.ok(fs.readFileSync(path.join(directory, browser, 'sites/catalog.js'), 'utf8').includes('示例网站'));
  }
  fs.writeFileSync(filename, JSON.stringify({ ...JSON.parse(original), enabled: false }));
  run('script/build-sites.js');
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'chrome/manifest.json'), 'utf8'));
  assert.ok(!manifest.host_permissions.includes('https://example.com/*'));
  assert.ok(!manifest.content_scripts.some(entry => entry.js.includes('sites/example.js')));
});

test('工作台大小写、省略号及 SVG 提示翻译，不覆盖设备名称和图形', async t => {
  const { document, toggle } = await page(t, `<table><tr><th>LAST SEEN</th><th>MACHINES ACTION MENU</th></tr></table>
    <button>Generate auth key...</button><p>You don't have any auth keys yet</p>
    <a href="/admin/machines/100.64.0.1" aria-label="Detail view for Settings">Settings</a>
    <svg aria-label="Update available for demo"><text>Settings</text><path d="M0 0"/></svg>
    <p>36 hours</p>`, { built: true });
  assert.equal(document.querySelector('th').textContent, '最近在线');
  assert.equal(document.querySelector('button').textContent, '生成认证密钥…');
  assert.equal(document.querySelector('p').textContent, '尚未创建任何认证密钥');
  assert.equal(document.querySelector('a').textContent, 'Settings');
  assert.equal(document.querySelector('a').getAttribute('aria-label'), '查看 Settings 的详情');
  assert.equal(document.querySelector('svg').getAttribute('aria-label'), 'demo 有可用更新');
  assert.equal(document.querySelector('svg text').textContent, 'Settings');
  assert.equal(document.querySelector('svg path').getAttribute('d'), 'M0 0');
  assert.equal(document.querySelector('p:last-child').textContent, '36 小时');
  await toggle(false);
  assert.equal(document.querySelector('svg').getAttribute('aria-label'), 'Update available for demo');
});

function policyPage(t, url = 'https://console.tailscale.com/admin', serverMarker = false) {
  const dom = new JSDOM(`<html lang="en"><head>${serverMarker ? '<meta name="google" content="notranslate" data-server>' : ''}</head><body><button>Settings</button></body></html>`);
  t.after(() => dom.window.close());
  let listener;
  let resolveSettings;
  let reloads = 0;
  const context = vm.createContext({
    document: dom.window.document, MutationObserver: dom.window.MutationObserver, console,
    location: new URL(url), window: { location: { reload() { reloads++; } } },
    chrome: { storage: {
      sync: { get: () => new Promise(resolve => { resolveSettings = resolve; }) },
      onChanged: { addListener: callback => { listener = callback; } }
    } }
  });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'chrome/sites/catalog.js'), 'utf8'), context);
  vm.runInContext(preferencesCode, context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'chrome/sites/browser-translation-guard.js'), 'utf8'), context);
  return {
    context, document: dom.window.document,
    resolve: values => resolveSettings(values),
    change: values => listener(Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { newValue: value }])), 'sync'),
    get reloads() { return reloads; }
  };
}

test('禁用网站冷加载时从不注入免翻译标记，其他网站开关不触发刷新', async t => {
  const page = policyPage(t);
  const selector = 'meta[data-fixed-site-translation="browser-guard"]';
  assert.equal(page.document.querySelector(selector), null, '未读到网站偏好前不能误拦截浏览器翻译');
  page.resolve({ enable_extension: true, site_enabled_tailscale: false });
  await wait();
  assert.equal(page.document.querySelector(selector), null);
  assert.equal(page.reloads, 0);
  page.change({ site_enabled_github: false });
  assert.equal(page.reloads, 0);
  assert.equal(page.document.documentElement.lang, 'en');
  page.change({ site_enabled_tailscale: true });
  assert.equal(page.reloads, 1);
  assert.equal(page.document.querySelector(selector).content, 'notranslate');
  page.change({ site_enabled_tailscale: false });
  assert.equal(page.reloads, 2);
  assert.equal(page.document.querySelector(selector), null);
  page.change({ site_enabled_tailscale: false });
  assert.equal(page.reloads, 2, '相同设置不能循环刷新');
});

test('浏览器翻译标记保留站点原标记，兼容替换 head 和读取配置期间的修改', async t => {
  const page = policyPage(t, undefined, true);
  const selector = 'meta[data-fixed-site-translation="browser-guard"]';
  page.change({ site_enabled_tailscale: false });
  page.resolve({ enable_extension: true, site_enabled_tailscale: true });
  await wait();
  assert.equal(page.document.querySelector(selector), null);
  assert.ok(page.document.querySelector('meta[data-server]'));
  page.change({ site_enabled_tailscale: true });
  const head = page.document.createElement('head');
  page.document.head.replaceWith(head);
  await wait();
  assert.equal(head.querySelector(selector).content, 'notranslate');
  assert.equal(page.document.querySelectorAll(selector).length, 1);
});

test('Tailscale 独立开关恢复原文，重新开启总开关不覆盖网站禁用选择', async t => {
  const { document, toggleSite, toggle } = await page(t, '<button>Settings</button>', { siteEnabled: false, built: true });
  assert.equal(document.querySelector('button').textContent, 'Settings');
  await toggleSite('tailscale', true);
  assert.equal(document.querySelector('button').textContent, '设置');
  await toggleSite('tailscale', false);
  await toggle(false);
  await toggle(true);
  assert.equal(document.querySelector('button').textContent, 'Settings');
});

test('禁用 GitHub 时不改写页面语言、不初始化任何翻译功能', async t => {
  const page = policyPage(t, 'https://github.com/example/repo');
  page.resolve({ enable_extension: true, site_enabled_github: false });
  await wait();
  page.context.I18N = {};
  page.context.loadFeatureSet = async () => {};
  page.context.watchFeatureChanges = () => assert.fail('禁用站点不得启动 GitHub 翻译');
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'chrome/src/entry.js'), 'utf8'), page.context);
  await page.context.init();
  assert.equal(page.document.documentElement.lang, 'en');
  assert.equal(page.document.querySelector('meta[name="google"]'), null);
});


test('用户截图回归：横幅、可见链接、搜索占位符、全大写表头和底部说明一起翻译', async t => {
  const { document } = await page(t, `<section>
    <h3>Did you know you can browse privately from fast VPN servers across the globe?</h3>
    <p>Access hundreds of servers in 40+ countries with our Mullvad VPN add-on for $5 per month for every 5 devices</p>
    <a aria-label="Read documentation about Mullvad exit nodes">Learn about Mullvad exit nodes</a>
    </section><h1>Machines</h1><a aria-label="Read documentation about machines">See how to manage devices</a>
    <input placeholder="Search by name, owner, tag, version..." value="test-host">
    <table><tr><th>LAST SEEN</th></tr></table>
    <p id="intro">Tailscale works best when it’s installed on multiple devices. Explore what you can do with Tailscale in these environments.</p>`, { built: true });
  assert.match(document.querySelector('h3').textContent, /保护浏览隐私/);
  assert.match(document.querySelector('section p').textContent, /每 5 台设备每月 5 美元/);
  assert.equal(document.querySelectorAll('a')[0].textContent, '了解 Mullvad 出口节点');
  assert.equal(document.querySelectorAll('a')[1].textContent, '了解如何管理设备');
  assert.equal(document.querySelector('input').placeholder, '按名称、所有者、标签、版本搜索…');
  assert.equal(document.querySelector('input').value, 'test-host');
  assert.equal(document.querySelector('th').textContent, '最近在线');
  assert.match(document.querySelector('#intro').textContent, /在多台设备上安装 Tailscale/);
});
