'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { ROOT, loadSites } = require('./site-config');
const normalize = value => value.replace(/\r\n/g, '\n');

function buildSites(check = false, browsers=['chrome','edge','firefox']) {
  const project = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const sites = loadSites().filter(site => site.enabled !== false);
  const runtime = normalize(fs.readFileSync(path.join(ROOT, 'extension', 'site-runtime.js'), 'utf8'));
  const guard = normalize(fs.readFileSync(path.join(ROOT, 'extension', 'browser-translation-guard.js'), 'utf8'));
  const preferences = normalize(fs.readFileSync(path.join(ROOT, 'extension', 'site-preferences.js'), 'utf8'));
  const shared = ['sites/catalog.js', 'sites/preferences.js', 'sites/browser-translation-guard.js'];
  const entries = sites.map(site => ({
    matches: site.matches,
    js: ['managed/core.js', 'managed/text-provenance.js', 'managed/content.js', ...shared, ...(site.engine === 'github' ? ['locals.js', 'content.js'] : [`sites/${site.id}.js`])],
    run_at: 'document_start'
  }));
  let stale = false;
  function output(relative, value) {
    const target = path.join(ROOT, relative);
    if (check) {
      if (!fs.existsSync(target) || normalize(fs.readFileSync(target, 'utf8')) !== value) {
        console.error(`[sites] 需要构建: ${relative}`);
        stale = true;
      }
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, value);
    }
  }
  for (const browser of browsers) {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, browser, 'manifest.json'), 'utf8'));
    manifest.name = project.displayName;
    manifest.version = project.version;
    if (project.homepage) manifest.homepage_url = project.homepage;
    else delete manifest.homepage_url;
    if (browser === 'firefox') manifest.browser_specific_settings.gecko.id = `${project.name}@local.invalid`;
    manifest.description = '使用本地词库翻译已适配的网站界面，支持按网站独立开关与持续扩展。';
    manifest.action.default_title = project.displayName;
    manifest.options_page = 'managed/managed.html';
    manifest.host_permissions = [...new Set(sites.flatMap(site => site.matches))];
    manifest.content_scripts = entries;
    manifest.permissions = [...new Set([...manifest.permissions, 'scripting', 'activeTab', 'nativeMessaging', 'alarms', 'contextMenus'])];
    manifest.optional_host_permissions = ['https://*/*', 'http://*/*'];
    if (browser === 'firefox') manifest.background = { scripts: ['sites/catalog.js','managed/tldts.js','managed/core.js','managed/providers.js','managed/batching.js','managed/background.js'] };
    else manifest.background = { service_worker: 'managed/worker.js' };
    const managedFiles = { 'batching.js':'managed-batching.js','providers.js':'managed-providers.js', 'core.js':'managed-core.js', 'text-provenance.js':'text-provenance.js', 'content.js':'managed-content.js', 'background.js':'managed-background.js', 'managed.html':'managed.html', 'managed.css':'managed.css', 'ui.js':'managed-ui.js' };
    for (const [target, source] of Object.entries(managedFiles)) output(`${browser}/managed/${target}`, normalize(fs.readFileSync(path.join(ROOT,'extension',source),'utf8')));
    output(`${browser}/managed/worker.js`, "importScripts('../sites/catalog.js','tldts.js','core.js','providers.js','batching.js','background.js');\n");
    output(`${browser}/managed/tldts.js`, normalize(fs.readFileSync(path.join(ROOT,'node_modules/tldts/dist/index.umd.min.js'),'utf8')).replace(/\/\/# sourceMappingURL=.*\n?/,''));
    output(`${browser}/managed/TLDTS-LICENSE`, normalize(fs.readFileSync(path.join(ROOT,'node_modules/tldts/LICENSE'),'utf8')));
    output(`${browser}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
    output(`${browser}/sites/browser-translation-guard.js`, guard);
    output(`${browser}/sites/preferences.js`, preferences);
    output(`${browser}/sites/catalog.js`, `// 自动生成，请修改 sites/<id>/site.json\nconst SUPPORTED_SITES = ${JSON.stringify(sites.map(({ id, name, matches, engine }) => ({ id, name, matches, engine })), null, 2)};\n`);
    for (const site of sites.filter(site => site.engine === 'dictionary')) {
      const content = `// 自动生成，请修改 sites/${site.id}/site.json 和 extension/site-runtime.js\n(() => {\nconst SITE = ${JSON.stringify(site, null, 2)};\n${runtime}\n})();\n`;
      new vm.Script(content, { filename: `${site.id}.js` });
      output(`${browser}/sites/${site.id}.js`, content);
    }
  }
  if (stale) throw new Error('网站构建产物未同步，请执行 npm run build');
  console.log(`[sites] ${check ? '校验' : '构建'}完成: ${sites.map(site => site.name).join('、')}`);
}

if (require.main === module) {const i=process.argv.indexOf('--browser');const browsers=i<0?['chrome','edge','firefox']:[process.argv[i+1]];if(browsers.some(b=>!['chrome','edge','firefox'].includes(b)))throw new Error('Unknown browser');buildSites(process.argv.includes('--check'),browsers);}
module.exports = { buildSites };
