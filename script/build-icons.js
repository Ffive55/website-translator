'use strict';

// SVG 是唯一图标源文件。中间的“中”字由路径构成，不依赖系统字体。
const fs = require('node:fs');
const path = require('node:path');
const { Resvg } = require('@resvg/resvg-js');
const root = path.resolve(__dirname, '..');
const svg = fs.readFileSync(path.join(root, 'assets/extension-icon.svg'), 'utf8');

for (const size of [16, 32, 48, 128, 512]) {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
  for (const browser of ['chrome', 'edge', 'firefox']) {
    fs.writeFileSync(path.join(root, browser, 'assets/icons', `icon${size}.png`), png);
  }
}
console.log('图标已生成并同步到 Chrome、Edge、Firefox（16/32/48/128/512）。');
