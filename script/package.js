'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { zipSync } = require('fflate');
const ROOT = path.resolve(__dirname, '..');
const OMIT = new Set(['node_modules', '.git', '.cache', '.omo', '.local-native', 'local-helper', 'test-results', 'dist']);
const EXTENSION_FILES = ['manifest.json', 'content.js', 'locals.js', 'assets', 'options', 'popup', 'sites', 'managed'];
const SOURCE_FILES = ['README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'THIRD_PARTY_NOTICES.md', 'LICENSE', 'AGENTS.md',
  'package.json', 'package-lock.json', '.gitignore', '.gitattributes', '.github', 'assets', 'chrome', 'edge', 'firefox', 'extension', 'native', 'sites', 'script', 'tests', 'docs', 'upstream'];

function collect(directory, entries) {
  const files = {};
  function visit(relative) {
    const filename = path.join(directory, relative);
    const stat = fs.lstatSync(filename);
    if (stat.isSymbolicLink()) throw new Error(`打包不接受符号链接: ${relative}`);
    const basename = path.basename(relative);
    if (OMIT.has(basename) || /^\.env(?:\.|$)/.test(basename) || /\.(log|pem|key|pfx|tmp)$/i.test(basename)) return;
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(filename).sort()) visit(path.join(relative, name));
    } else {
      files[relative.split(path.sep).join('/')] = fs.readFileSync(filename);
    }
  }
  entries.forEach(visit);
  return files;
}

async function packageProject(root = ROOT) {
  const { name: packageName, version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const out = path.join(root, 'dist');
  fs.mkdirSync(out, { recursive: true });
  const releases = [];
  const {buildNativeBundle,installer}=require('./build-native-bundle');
  const helper=await buildNativeBundle(root);
  function emit(name, files) {
    // 固定 ZIP 时间，确保同一输入可复现；不打入本机路径或临时文件。
    const entries = Object.fromEntries(Object.entries(files).map(([file, content]) => [file, [content, { mtime: new Date(2026, 0, 1, 0, 0, 0) }]]));
    const destination = path.join(out, name);
    fs.writeFileSync(destination, zipSync(entries, { level: 6 }));
    releases.push(destination);
    console.log(`[package] ${name}（${Object.keys(files).length} 个文件）`);
  }
  for (const browser of ['chrome', 'edge', 'firefox']) {
    const files = collect(path.join(root, browser), EXTENSION_FILES);
    for(const [name,data] of Object.entries({...helper,'Install.cmd':installer(browser)})){
      const target=path.join(root,browser,'local-helper',name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,data);
      files['local-helper/'+name]=data;
    }
    for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) files[file] = fs.readFileSync(path.join(root, file));
    emit(`${packageName}-v${version}-${browser}.zip`, files);
  }
  emit(`${packageName}-v${version}-source.zip`, collect(root, SOURCE_FILES));
  return releases;
}
if (require.main === module) packageProject().catch(error=>{console.error(error);process.exitCode=1;});
module.exports = { collect, packageProject, SOURCE_FILES };
