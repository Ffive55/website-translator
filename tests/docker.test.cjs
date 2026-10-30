'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { loadSites } = require('../script/site-config');

const root = path.resolve(__dirname, '..');
const wait = (ms = 180) => new Promise(resolve => setTimeout(resolve, ms));
const catalog = loadSites().map(({ id, name, matches, engine }) => ({ id, name, matches, engine }));
const preferences = fs.readFileSync(path.join(root, 'extension/site-preferences.js'), 'utf8');

async function page(t, siteId, url, html, overrides = {}) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const listeners = [];
  const settings = { enable_extension: true, ...overrides };
  dom.window.chrome = {
    runtime: { onMessage: { addListener() {} } },
    storage: {
      sync: { get: async defaults => ({ ...defaults, ...settings }) },
      onChanged: { addListener: listener => listeners.push(listener) }
    }
  };
  dom.window.eval(`const SUPPORTED_SITES = ${JSON.stringify(catalog)};\n${preferences}`);
  dom.window.eval(fs.readFileSync(path.join(root, `chrome/sites/${siteId}.js`), 'utf8'));
  await wait();
  return {
    window: dom.window,
    document: dom.window.document,
    async set(key, value) {
      settings[key] = value;
      for (const listener of listeners) listener({ [key]: { newValue: value } }, 'sync');
      await wait();
    }
  };
}

test('Docker 官网首页与价格页翻译入口、说明和套餐标签', async t => {
  const home = await page(t, 'docker', 'https://www.docker.com/', `<nav><a href="/products/">Products</a><a href="/pricing/">Pricing</a></nav>
    <h1>Trust Docker <span>for the Agents You Don’t</span></h1><a href="https://app.docker.com/signup">Get started</a>
    <p>Docker securely contains autonomous agents so you can confidently build, ship, and run on trust.</p>
    <pre>docker run nginx</pre>`);
  assert.equal(home.document.querySelector('nav a').textContent, '产品');
  assert.equal(home.document.querySelector('h1').textContent, '信赖 Docker 管理你尚不信任的智能体');
  assert.equal(home.document.querySelector('a[href="/pricing/"]').textContent, '价格');
  assert.equal(home.document.querySelector('a[href="https://app.docker.com/signup"]').textContent, '开始使用');
  assert.match(home.document.querySelector('p').textContent, /安全隔离自主智能体/);
  assert.equal(home.document.querySelector('pre').textContent, 'docker run nginx');
  const pricing = await page(t, 'docker', 'https://www.docker.com/pricing/', '<h1>Find Your Perfect Docker Plan</h1><button>Compare plans</button><span>per user/month</span>');
  assert.equal(pricing.document.querySelector('h1').textContent, '选择适合你的 Docker 套餐');
  assert.equal(pricing.document.querySelector('button').textContent, '比较套餐');
  assert.equal(pricing.document.querySelector('span').textContent, '每位用户 / 月');
});

test('Docker 账号页面翻译导航、安全提示及动态身份文案，保留输入与密码', async t => {
  const app = await page(t, 'docker-hub', 'https://app.docker.com/accounts/test/settings/2fa-setup', `
    <nav><a href="/accounts/test">Home</a><a href="/settings">Personal access tokens</a></nav>
    <button data-tour-id="context-switcher"><div class="MuiTypography-body1">Settings</div><div class="MuiTypography-body2">Your individual account</div></button>
    <h3 class="font-heading">Welcome back, <strong>Settings</strong>!</h3>
    <button aria-label="Notification center: 3 notifications">Help</button>
    <div role="dialog"><h1>Confirm your identity</h1><p>You must verify your identity before managing 2FA features.</p>
      <input type="password" value="Password"><input placeholder="Search Docker Hub" value="nginx:latest">
      <button>Confirm</button><button>Cancel</button></div>`);
  const { document } = app;
  assert.equal(document.querySelector('nav a').textContent, '首页');
  assert.equal(document.querySelector('nav a + a').textContent, '个人访问令牌');
  assert.equal(document.querySelector('[data-tour-id] .MuiTypography-body1').textContent, 'Settings');
  assert.equal(document.querySelector('[data-tour-id] .MuiTypography-body2').textContent, '个人账户');
  assert.match(document.querySelector('h3').textContent, /欢迎回来，\s*Settings/);
  assert.equal(document.querySelector('[aria-label]').getAttribute('aria-label'), '通知中心：3 条通知');
  assert.equal(document.querySelector('h1').textContent, '确认身份');
  assert.match(document.querySelector('p').textContent, /必须先验证身份/);
  assert.equal(document.querySelector('input[type=password]').value, 'Password');
  assert.equal(document.querySelector('input[placeholder]').value, 'nginx:latest');
  assert.equal(document.querySelector('input[placeholder]').placeholder, '搜索 Docker Hub');
  assert.equal(document.querySelector('div[role=dialog] button').textContent, '确认');
});

test('Docker Hub 保留仓库名、标签、命令和用户撰写的镜像说明', async t => {
  const hub = await page(t, 'docker-hub', 'https://hub.docker.com/_/settings/tags', `
    <h2>Settings</h2><nav><a href="/search">Explore</a><button>My Hub</button></nav>
    <button data-testid="product-card-click"><h6><a data-testid="product-card-name" href="/r/test/settings">Settings</a></h6>
      <p>Docker Official Image</p><span>Image</span></button>
    <div data-testid="markdownContent" class="dMarkdown"><h3>Quick reference</h3><p>Settings</p><pre>docker pull nginx:latest</pre></div>
    <div data-testid="page_content_repository_list"><p>All repositories within the <strong>Settings</strong> namespace.</p></div>
    <table><tbody><tr><td>Settings</td><td>Private</td></tr></tbody></table>
    <a href="/layers/library/nginx/latest">latest</a><pre><code>docker pull nginx:latest</code></pre>
    <p id="vulnerabilities">Vulnerabilities</p>`);
  const { document } = hub;
  assert.equal(document.querySelector('h2').textContent, 'Settings');
  assert.equal(document.querySelector('a[href="/search"]').textContent, '探索');
  assert.equal(document.querySelector('[data-testid=product-card-name]').textContent, 'Settings');
  assert.equal(document.querySelector('[data-testid=product-card-click] p').textContent, 'Docker Official Image');
  assert.equal(document.querySelector('[data-testid=product-card-click] span').textContent, '镜像');
  assert.equal(document.querySelector('.dMarkdown h3').textContent, '快速参考');
  assert.equal(document.querySelector('.dMarkdown p').textContent, 'Settings');
  assert.equal(document.querySelector('[data-testid=page_content_repository_list] strong').textContent, 'Settings');
  assert.match(document.querySelector('[data-testid=page_content_repository_list] p').textContent, /Settings/);
  assert.equal(document.querySelector('td:first-child').textContent, 'Settings');
  assert.equal(document.querySelector('td:nth-child(2)').textContent, '私有');
  assert.equal(document.querySelector('a[href^="/layers/"]').textContent, 'latest');
  assert.equal(document.querySelector('code').textContent, 'docker pull nginx:latest');
  assert.equal(document.querySelector('#vulnerabilities').textContent, '漏洞');
});

test('没有显式 value 的原生选项保持原文和提交值，有显式值的选项可翻译', async t => {
  const app = await page(t, 'docker-hub', 'https://hub.docker.com/repository-settings/default-privacy',
    '<select><option>Private</option><option value="public">Public</option></select>');
  const [implicit, explicit] = app.document.querySelectorAll('option');
  assert.equal(implicit.textContent, 'Private');
  assert.equal(implicit.value, 'Private');
  assert.equal(explicit.textContent, '公开');
  assert.equal(explicit.value, 'public');
});

test('Docker 动态弹窗会翻译；禁用工作台不会影响官网独立开关', async t => {
  const app = await page(t, 'docker-hub', 'https://app.docker.com/billing/demo', '<main><button>Billing</button></main>');
  const dialog = app.document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  dialog.innerHTML = '<h2>Billing settings</h2><button>Cancel</button><button>Save</button>';
  app.document.body.append(dialog);
  await wait();
  assert.equal(dialog.querySelector('h2').textContent, '账单设置');
  assert.equal(dialog.querySelector('button').textContent, '取消');
  await app.set('site_enabled_docker', false);
  assert.equal(dialog.querySelector('h2').textContent, '账单设置');
  await app.set('site_enabled_docker-hub', false);
  assert.equal(dialog.querySelector('h2').textContent, 'Billing settings');
  await app.set('enable_extension', false);
  await app.set('enable_extension', true);
  assert.equal(dialog.querySelector('h2').textContent, 'Billing settings');
});

test('两个 Docker 网站分别在设置目录和三端清单注册，关闭后不注入浏览器免翻译标记', async t => {
  for (const browser of (process.env.WT_BROWSER?[process.env.WT_BROWSER]:['chrome','edge','firefox'])) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, browser, 'manifest.json'), 'utf8'));
    for (const [site, match] of [['docker', 'https://www.docker.com/*'], ['docker-hub', 'https://app.docker.com/*'], ['docker-hub', 'https://hub.docker.com/*']]) {
      const entry = manifest.content_scripts.find(item => item.matches.includes(match));
      assert.ok(entry, `${browser} 缺少 ${match}`);
      assert.ok(entry.js.includes(`sites/${site}.js`));
      assert.ok(manifest.host_permissions.includes(match));
      assert.equal(entry.run_at, 'document_start');
    }
    assert.equal(manifest.version, require('../package.json').version);
  }
  const dom = new JSDOM('<html lang="en"><head></head><body></body></html>');
  t.after(() => dom.window.close());
  let observer;
  let reloads = 0;
  const context = vm.createContext({
    document: dom.window.document, MutationObserver: dom.window.MutationObserver, console,
    location: new URL('https://hub.docker.com/'), window: { location: { reload: () => { reloads++; } } },
    chrome: { storage: {
      sync: { get: async defaults => ({ ...defaults, 'site_enabled_docker-hub': false }) },
      onChanged: { addListener: fn => { observer = fn; } }
    } }
  });
  vm.runInContext(`const SUPPORTED_SITES = ${JSON.stringify(catalog)};\n${preferences}`, context);
  vm.runInContext(fs.readFileSync(path.join(root, 'extension/browser-translation-guard.js'), 'utf8'), context);
  await wait();
  assert.equal(context.document.querySelector('meta[data-fixed-site-translation]'), null);
  observer({ site_enabled_docker: { newValue: false } }, 'sync');
  assert.equal(reloads, 0);
  observer({ 'site_enabled_docker-hub': { newValue: true } }, 'sync');
  assert.equal(reloads, 1);
  assert.equal(context.document.querySelector('meta[data-fixed-site-translation]').content, 'notranslate');
});

