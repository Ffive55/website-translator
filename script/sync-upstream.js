'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { normalize, hash, validateSource, readState, threeWayMerge, writePatch, applyUpdate } = require('./upstream-core');
const ROOT = path.resolve(__dirname, '..');
const CACHE = path.join(ROOT, '.cache/upstream');

async function download(url, json = false) {
  const headers = { 'User-Agent': 'website-translator-upstream-sync', Accept: json ? 'application/vnd.github+json' : 'text/plain' };
  if (json && process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`上游请求失败：HTTP ${response.status}（${new URL(url).hostname}）`);
  const maximum = 12 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > maximum) throw new Error('上游文件大小异常');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maximum) { await reader.cancel(); throw new Error('上游响应超过大小限制'); }
    chunks.push(value);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return json ? JSON.parse(text) : normalize(text);
}

async function resolveCommit(lock, getJson = url => download(url, true), runGit = spawnSync) {
  try {
    const result = await getJson(`https://api.github.com/repos/${lock.repository}/commits/${encodeURIComponent(lock.branch)}`);
    if (!/^[a-f0-9]{40}$/.test(result.sha)) throw new Error('API 未返回有效提交');
    return result.sha;
  } catch {
    console.log('[upstream] GitHub API 暂不可用，使用 git ls-remote 查询分支。');
    const refName = `refs/heads/${lock.branch}`;
    const result = runGit('git', ['ls-remote', '--exit-code', '--heads', `https://github.com/${lock.repository}.git`, refName], {
      encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }
    });
    if (result.error || result.status !== 0) throw new Error('GitHub API 与 Git 分支查询均失败，请检查网络和上游仓库/分支；项目文件未修改');
    const line = result.stdout.trim().split(/\r?\n/).find(value => value.split(/\s+/)[1] === refName);
    const sha = line?.split(/\s+/)[0];
    if (!/^[a-f0-9]{40}$/.test(sha || '')) throw new Error('无法从上游分支解析提交 SHA');
    return sha;
  }
}

async function incomingAt(lock, ref) {
  const commit = ref || await resolveCommit(lock);
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('必须使用完整的 40 位上游提交 SHA');
  const source = await download(`https://raw.githubusercontent.com/${lock.repository}/${commit}/${lock.file}`);
  validateSource(source);
  return { commit, source };
}

function runTests(directory) {
  const npm = process.env.npm_execpath;
  if (!npm || !fs.existsSync(npm)) throw new Error('请通过 npm run upstream:update 或 upstream:resolve 执行，以便运行回归测试');
  console.log('[upstream] 运行完整回归测试…');
  const result = spawnSync(process.execPath, [npm, 'test'], { cwd: ROOT, encoding: 'utf8', timeout: 240000, maxBuffer: 24 * 1024 * 1024, windowsHide: true });
  fs.writeFileSync(path.join(directory, 'validation.log'), (result.stdout || '') + (result.stderr || ''));
  if (result.error || result.status !== 0) throw new Error(`回归测试未通过，详见 ${path.relative(ROOT, directory)}/validation.log`);
}

function saveReport(directory, report) {
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}

async function main() {
  const [mode = '--check', ...args] = process.argv.slice(2);
  if (!['--check', '--apply', '--resolve'].includes(mode)) throw new Error('仅支持 --check、--apply、--resolve');
  if (mode !== '--resolve' && args.length && !(args.length === 2 && args[0] === '--ref' && /^[a-f0-9]{40}$/.test(args[1]))) throw new Error('可选参数：--ref <完整提交 SHA>');
  if (mode === '--resolve' && args.length !== 1) throw new Error('用法：npm run upstream:resolve -- .cache/upstream/<检查目录>/report.json');
  fs.mkdirSync(CACHE, { recursive: true });
  const mutex = path.join(CACHE, '.sync.lock');
  let handle;
  try { handle = fs.openSync(mutex, 'wx'); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('另一个同步进程正在运行；如上次进程异常退出，确认没有同步进程后移除 .cache/upstream/.sync.lock');
    throw error;
  }
  try {
    const state = readState(ROOT);
    let report;
    let directory;
    let incoming;
    let merged;
    if (mode === '--resolve') {
      const reportFile = path.resolve(ROOT, args[0]);
      if (!reportFile.startsWith(CACHE + path.sep) || path.basename(reportFile) !== 'report.json') throw new Error('只能使用本项目 .cache/upstream 下的报告');
      directory = path.dirname(reportFile);
      report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
      if (report.schema !== 1 || report.lockHash !== state.lockHash || report.currentHash !== hash(state.current)) throw new Error('冲突报告已过期，本地词库或基线已经变化；请重新检查');
      // 再次从锁定的官方仓库取同一提交，不信任报告里任意 URL 或被替换的下载文件。
      incoming = await incomingAt(state.lock, report.incomingCommit);
      if (hash(incoming.source) !== report.incomingHash) throw new Error('上游内容与报告不一致');
      merged = fs.readFileSync(path.join(directory, 'merged.locals.js'), 'utf8');
      validateSource(merged);
    } else {
      incoming = await incomingAt(state.lock, args[1]);
      const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}`;
      directory = path.join(CACHE, name);
      fs.mkdirSync(directory);
      const merge = threeWayMerge(state.current, state.base, incoming.source, directory);
      merged = merge.source;
      report = {
        schema: 1, repository: state.lock.repository, branch: state.lock.branch, file: state.lock.file,
        baseCommit: state.lock.commit, incomingCommit: incoming.commit,
        lockHash: state.lockHash, currentHash: hash(state.current), incomingHash: hash(incoming.source),
        status: merge.conflicts ? 'conflict' : hash(incoming.source) === hash(state.base) ? 'unchanged' : 'ready',
        createdAt: new Date().toISOString()
      };
      writePatch(path.join(directory, 'base.locals.js'), path.join(directory, 'incoming.locals.js'), path.join(directory, 'upstream.patch'));
      writePatch(path.join(directory, 'current.locals.js'), path.join(directory, 'merged.locals.js'), path.join(directory, 'merged.patch'));
      saveReport(directory, report);
    }
    console.log(`[upstream] 来源：${state.lock.repository} (${state.lock.branch})`);
    console.log(`[upstream] 基线：${state.lock.commit}\n[upstream] 最新：${incoming.commit}`);
    console.log(`[upstream] 报告：${path.relative(ROOT, directory)}/report.json`);
    if (mode !== '--resolve' && report.status === 'conflict') {
      console.error('[upstream] 有合并冲突，未修改项目文件。请检查并编辑报告目录的 merged.locals.js，再运行 upstream:resolve。');
      process.exitCode = 2;
      return;
    }
    if (mode !== '--resolve' && report.status === 'unchanged') {
      console.log('[upstream] 上游词库没有变化，本地词库及其他功能保持不变。');
      return;
    }
    if (mode === '--check') {
      validateSource(merged);
      console.log('[upstream] 可以合并。查看 upstream.patch 和 merged.patch 后，运行 npm run upstream:update。');
      return;
    }
    try {
      applyUpdate({ root: ROOT, state, incoming: incoming.source, merged, commit: incoming.commit, directory, validate: () => runTests(directory) });
      report.status = 'applied';
      report.appliedAt = new Date().toISOString();
      saveReport(directory, report);
      console.log('[upstream] 已同步三端词库，通过回归测试并更新基线。请查看 git diff，按需运行 npm run package。');
    } catch (error) {
      report.status = 'failed';
      report.error = error.message;
      saveReport(directory, report);
      throw error;
    }
  } finally {
    fs.closeSync(handle);
    fs.unlinkSync(mutex);
  }
}
if (require.main === module) main().catch(error => { console.error(`[upstream] ${error.message}`); process.exitCode = 1; });
module.exports = { resolveCommit };
