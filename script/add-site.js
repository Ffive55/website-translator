'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ROOT, validateSite } = require('./site-config');

const [id, address, name = id] = process.argv.slice(2);
if (!id || !address) {
  console.error('用法: npm run site:add -- example https://example.com "网站名称"');
  process.exit(1);
}
const url = new URL(address);
if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) throw new Error('请输入不含端口或登录信息的 http(s) 网站地址');
const site = validateSite({
  id, name, engine: 'dictionary', matches: [`${url.protocol}//${url.hostname}/*`],
  dictionary: { 'Sign in': '登录', 'Settings': '设置', 'Save': '保存', 'Cancel': '取消' },
  selectors: [], ignore: [], regexp: [], pages: []
});
const directory = path.join(ROOT, 'sites', id);
// 不覆盖已有网站配置。
fs.mkdirSync(directory);
fs.writeFileSync(path.join(directory, 'site.json'), JSON.stringify(site, null, 2) + '\n', { flag: 'wx' });
console.log(`已创建 sites/${id}/site.json。补充词库后执行 npm run build，再重新加载扩展并刷新网页。`);
