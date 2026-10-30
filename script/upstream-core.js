'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const normalize = text => text.replace(/\r\n/g, '\n');
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const TARGETS = ['chrome/locals.js', 'edge/locals.js', 'firefox/locals.js'];
const BASE = 'upstream/github-chinese/locals.base.js';
const LOCK = 'upstream/github-chinese/lock.json';

function validateSource(source) {
  if (/^(<<<<<<< |=======$|>>>>>>> )/m.test(source)) throw new Error('词库仍包含合并冲突标记');
  // 只编译检查语法，不在更新器中执行下载的 JavaScript。
  new vm.Script(source, { filename: 'locals.js' });
  if (!/\bI18N\.conf\s*=/.test(source) || !/I18N\[['"]zh-CN['"]\]/.test(source)) {
    throw new Error('上游词库结构改变，需人工检查兼容性');
  }
}

function readState(root) {
  const lockText = fs.readFileSync(path.join(root, LOCK), 'utf8');
  const lock = JSON.parse(lockText);
  if (lock.schema !== 1 || !/^[a-f0-9]{40}$/.test(lock.commit) ||
      !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(lock.repository) ||
      !/^[a-zA-Z0-9_./-]+$/.test(lock.branch) || lock.file !== 'chrome/locals.js') {
    throw new Error('上游锁定信息无效');
  }
  const base = normalize(fs.readFileSync(path.join(root, BASE), 'utf8'));
  if (hash(base) !== lock.sha256) throw new Error('上游基线校验失败；不要手工修改基线文件');
  const current = normalize(fs.readFileSync(path.join(root, TARGETS[0]), 'utf8'));
  for (const file of TARGETS.slice(1)) {
    if (normalize(fs.readFileSync(path.join(root, file), 'utf8')) !== current) throw new Error(`三端词库不一致，请先整理 ${file} 的本地改动`);
  }
  validateSource(base);
  validateSource(current);
  return { lock, lockHash: hash(lockText), base, current };
}

function threeWayMerge(current, base, incoming, directory) {
  for (const [file, source] of [['current.locals.js', current], ['base.locals.js', base], ['incoming.locals.js', incoming]]) {
    fs.writeFileSync(path.join(directory, file), source);
  }
  const result = spawnSync('git', ['merge-file', '-p', '-L', 'LOCAL', '-L', 'BASE', '-L', 'UPSTREAM',
    path.join(directory, 'current.locals.js'), path.join(directory, 'base.locals.js'), path.join(directory, 'incoming.locals.js')],
  { encoding: 'utf8', maxBuffer: 24 * 1024 * 1024, windowsHide: true });
  if (result.error) throw result.error;
  if (result.status === null || result.status < 0 || result.status > 127) throw new Error(`git merge-file 失败：${result.stderr}`);
  fs.writeFileSync(path.join(directory, 'merged.locals.js'), result.stdout);
  return { source: result.stdout, conflicts: result.status !== 0 };
}

function writePatch(before, after, output) {
  const result = spawnSync('git', ['diff', '--no-index', '--no-color', '--', before, after],
    { encoding: 'utf8', maxBuffer: 24 * 1024 * 1024, windowsHide: true });
  if (result.error || ![0, 1].includes(result.status)) throw result.error || new Error(result.stderr);
  fs.writeFileSync(output, result.stdout);
}

function atomicWrite(filename, data) {
  const temporary = `${filename}.upstream-${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, data, { flag: 'wx' });
    fs.renameSync(temporary, filename);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function applyUpdate({ root, state, incoming, merged, commit, directory, validate }) {
  validateSource(merged);
  validateSource(incoming);
  const latest = readState(root);
  if (latest.lockHash !== state.lockHash || hash(latest.current) !== hash(state.current)) throw new Error('检查后本地文件已变化，请重新检查再同步');
  const newLock = { ...state.lock, commit, sha256: hash(incoming), syncedAt: new Date().toISOString() };
  const writes = new Map(TARGETS.map(file => [file, merged]));
  writes.set(BASE, incoming);
  writes.set(LOCK, JSON.stringify(newLock, null, 2) + '\n');
  const backups = new Map();
  const changed = [];
  for (const file of writes.keys()) {
    const data = fs.readFileSync(path.join(root, file));
    backups.set(file, data);
    const backupFile = path.join(directory, 'backup', file);
    fs.mkdirSync(path.dirname(backupFile), { recursive: true });
    fs.writeFileSync(backupFile, data);
  }
  try {
    for (const [file, content] of writes) {
      atomicWrite(path.join(root, file), content);
      changed.push(file);
    }
    validate();
  } catch (error) {
    const failures = [];
    for (const file of changed.reverse()) {
      try { atomicWrite(path.join(root, file), backups.get(file)); }
      catch (rollbackError) { failures.push(`${file}: ${rollbackError.message}`); }
    }
    if (failures.length) throw new Error(`同步失败，部分文件恢复失败；备份位于 ${directory}/backup。${failures.join('; ')}。原错误：${error.message}`);
    throw new Error(`同步失败，已恢复原词库、基线和锁定记录。${error.message}`);
  }
  return newLock;
}

module.exports = { normalize, hash, TARGETS, BASE, LOCK, validateSource, readState, threeWayMerge, writePatch, applyUpdate };
