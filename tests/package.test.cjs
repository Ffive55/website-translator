'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const assert = require('node:assert/strict');
const { collect } = require('../script/package');
test('打包白名单排除缓存、凭据、依赖和测试截图', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'translation-package-test-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('translation-package-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const file of ['src/good.js', 'src/.env', 'src/token.key', 'src/run.log', 'src/.cache/report.json', 'src/node_modules/lib.js', 'src/test-results/private.png']) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), 'fixture');
  }
  assert.deepEqual(Object.keys(collect(root, ['src'])), ['src/good.js']);
});
