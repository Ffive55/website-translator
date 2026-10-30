'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const assert = require('node:assert/strict');
const { hash, TARGETS, BASE, LOCK, validateSource, readState, threeWayMerge, applyUpdate } = require('../script/upstream-core');
const base = `// Copyright fixture\nvar I18N = {};\nI18N.conf = {};\nI18N['zh-CN'] = {\n  One: '一',\n  Two: '二',\n  Three: '三',\n  Four: '四',\n  Five: '五',\n  Six: '六'\n};\n`;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'translation-upstream-test-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('translation-upstream-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const file of [...TARGETS, BASE]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), base);
  }
  fs.writeFileSync(path.join(root, LOCK), JSON.stringify({ schema: 1, repository: 'MaydayV/github-chinese', branch: 'chrome', file: 'chrome/locals.js', commit: 'a'.repeat(40), sha256: hash(base) }));
  fs.mkdirSync(path.join(root, 'report'));
  return { root, directory: path.join(root, 'report') };
}

test('三方合并保留本地词条和注释，同时接受上游其他位置的更新', t => {
  const { directory } = fixture(t);
  const local = base.replace("One: '一'", "One: '本地一'");
  const incoming = base.replace("Six: '六'", "Six: '上游六'");
  const result = threeWayMerge(local, base, incoming, directory);
  assert.equal(result.conflicts, false);
  assert.ok(result.source.includes("One: '本地一'"));
  assert.ok(result.source.includes("Six: '上游六'"));
  assert.ok(result.source.startsWith('// Copyright fixture'));
  validateSource(result.source);
});

test('同一词条冲突只生成报告，不覆盖项目词库', t => {
  const { root, directory } = fixture(t);
  const local = base.replace("One: '一'", "One: '本地译法'");
  const incoming = base.replace("One: '一'", "One: '上游译法'");
  const result = threeWayMerge(local, base, incoming, directory);
  assert.equal(result.conflicts, true);
  assert.match(result.source, /<<<<<<< LOCAL/);
  assert.throws(() => validateSource(result.source), /冲突标记/);
  for (const file of TARGETS) assert.equal(fs.readFileSync(path.join(root, file), 'utf8'), base);
});

test('更新成功同步三端，记录纯上游基线而非带本地改动的合并结果', t => {
  const { root, directory } = fixture(t);
  const state = readState(root);
  const incoming = base.replace("Six: '六'", "Six: '新六'");
  const merged = incoming.replace("One: '一'", "One: '本地一'");
  let tested = false;
  applyUpdate({ root, state, incoming, merged, commit: 'b'.repeat(40), directory, validate() { tested = true; } });
  assert.ok(tested);
  for (const file of TARGETS) assert.equal(fs.readFileSync(path.join(root, file), 'utf8'), merged);
  assert.equal(fs.readFileSync(path.join(root, BASE), 'utf8'), incoming);
  const next = readState(root);
  assert.equal(next.lock.commit, 'b'.repeat(40));
  assert.equal(next.lock.sha256, hash(incoming));
});

test('测试失败后，三个词库、基线和锁定文件按原始字节恢复', t => {
  const { root, directory } = fixture(t);
  fs.writeFileSync(path.join(root, TARGETS[0]), base.replace(/\n/g, '\r\n'));
  const files = [...TARGETS, BASE, LOCK];
  const before = files.map(file => fs.readFileSync(path.join(root, file)));
  const state = readState(root);
  const incoming = base.replace("Six: '六'", "Six: '错误变更'");
  assert.throws(() => applyUpdate({ root, state, incoming, merged: incoming, commit: 'b'.repeat(40), directory, validate() { throw new Error('模拟回归失败'); } }), /已恢复原词库/);
  files.forEach((file, i) => assert.ok(fs.readFileSync(path.join(root, file)).equals(before[i])));
});

test('拒绝过期的同步计划与三端不同步，不丢失后续本地编辑', t => {
  const { root, directory } = fixture(t);
  const state = readState(root);
  for (const file of TARGETS) fs.writeFileSync(path.join(root, file), base + '// later edit\n');
  assert.throws(() => applyUpdate({ root, state, incoming: base, merged: base, commit: 'b'.repeat(40), directory, validate() {} }), /本地文件已变化/);
  fs.writeFileSync(path.join(root, TARGETS[1]), base);
  assert.throws(() => readState(root), /三端词库不一致/);
});

test('拒绝损坏基线和无效脚本；校验不会执行代码', t => {
  const { root } = fixture(t);
  assert.doesNotThrow(() => validateSource(base + "throw new Error('must not execute');"));
  assert.throws(() => validateSource('not javascript {{{'));
  fs.appendFileSync(path.join(root, BASE), '// tampered');
  assert.throws(() => readState(root), /基线校验失败/);
});

test('实际仓库上游锁定文件、基线和三端词库一致', () => {
  readState(path.resolve(__dirname, '..'));
});

test('公开 API 不可用时通过 Git 查询相同分支；双重失败不返回假更新状态', async () => {
  const { resolveCommit } = require('../script/sync-upstream');
  const lock = { repository: 'MaydayV/github-chinese', branch: 'chrome' };
  const failApi = async () => { throw new Error('HTTP 403'); };
  const sha = await resolveCommit(lock, failApi, (binary, args) => {
    assert.equal(binary, 'git');
    assert.equal(args.at(-1), 'refs/heads/chrome');
    return { status: 0, stdout: `${'b'.repeat(40)}\trefs/heads/chrome\n` };
  });
  assert.equal(sha, 'b'.repeat(40));
  await assert.rejects(resolveCommit(lock, failApi, () => ({ status: 128 })), /均失败/);
});
