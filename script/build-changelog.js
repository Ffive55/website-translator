'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const escape = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function buildChangelog(check = false, browsers=['chrome','edge','firefox']) {
  const markdown = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8').replace(/\r\n/g, '\n');
  const { version, displayName } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const sections = [];
  for (const line of markdown.split('\n')) {
    const match = line.match(/^## v([\d.]+) \(([^)]+)\)$/);
    if (match) sections.push({ version: match[1], date: match[2], points: [] });
    else if (line.startsWith('- ') && sections.length) sections.at(-1).points.push(line.slice(2));
  }
  if (sections[0]?.version !== version) throw new Error('CHANGELOG 最新版本必须与 package.json 一致');
  const blocks = sections.map(section => `<section class="card" id="v${section.version.replace(/\./g, '-')}"><h2>v${escape(section.version)} · ${escape(section.date)}</h2><ul>${section.points.map(point => `<li>${escape(point)}</li>`).join('')}</ul></section>`).join('\n');
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>更新日志 · ${escape(displayName)}</title><link rel="stylesheet" href="../managed/managed.css"></head>
<body><main class="page"><header class="hero"><p class="eyebrow">${escape(displayName)}</p><h1>更新日志</h1><p>当前版本 v${escape(version)} · <a href="options.html">翻译设置</a></p></header><div class="form">${blocks}</div></main></body></html>
`;
  for (const browser of browsers) {
    const target = path.join(ROOT, browser, 'options/changelog.html');
    if (check) {
      if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n') !== html) throw new Error(`${browser} 更新日志未同步，请执行 npm run build`);
    } else fs.writeFileSync(target, html);
  }
  console.log(`[changelog] ${check ? '校验' : '生成'}完成：v${version}`);
}
if (require.main === module) buildChangelog(process.argv.includes('--check'));
module.exports = { buildChangelog };
