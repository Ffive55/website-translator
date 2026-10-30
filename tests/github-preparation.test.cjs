'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {auditFiles,prepare}=require('../script/prepare-github');
const {SOURCE_FILES}=require('../script/package');
const base=()=>Object.fromEntries(Object.entries({'README.md':'fixture','AGENTS.md':'fixture','LICENSE':'fixture','THIRD_PARTY_NOTICES.md':'fixture','package.json':'{"version":"0.0.1"}','package-lock.json':'{}','docs/source-baseline.json':'{}','upstream/github-chinese/lock.json':'{}','edge/manifest.json':'{"version":"0.0.1"}'}).map(([name,value])=>[name,Buffer.from(value)]));
test('上传审阅拒绝敏感值、本机文件和越界路径，错误不回显匹配值',()=>{
  const token='sk-'+ 'x'.repeat(40);
  for(const [name,value] of [['extension/config.js',token],['docs/private.png','image'],['edge/local-helper/runtime/node.exe','binary'],['../escape','invalid']])assert.throws(()=>auditFiles({...base(),[name]:Buffer.from(value)}),error=>error.message.includes(name) && !error.message.includes(token));
  assert.equal(auditFiles(base()).length,9);
  assert.throws(()=>auditFiles({...base(),'edge/manifest.json':Buffer.from('{"version":"0.0.2"}')}),/版本/);
});
test('干净导出保留清单字节，排除本机依赖与配置且不改源 Git 状态',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wt-github-prepare-'));t.after(()=>{assert.equal(path.dirname(root),os.tmpdir());assert.ok(path.basename(root).startsWith('wt-github-prepare-'));fs.rmSync(root,{recursive:true,force:true});});
  const dirs=new Set(['.github','assets','chrome','edge','firefox','extension','native','sites','script','tests','docs','upstream']);
  for(const name of SOURCE_FILES)dirs.has(name)?fs.mkdirSync(path.join(root,name),{recursive:true}):fs.writeFileSync(path.join(root,name),'fixture');
  for(const [name,bytes] of Object.entries({...base(),'extension/runtime.js':Buffer.from('runtime'),'extension/.env':Buffer.from('local-only'),'edge/local-helper/private.dat':Buffer.from('local-only'),'.git/config':Buffer.from('original')})){fs.mkdirSync(path.dirname(path.join(root,name)),{recursive:true});fs.writeFileSync(path.join(root,name),bytes);}
  const {directory,report}=prepare(root);assert.equal(report.sourceCommit,null);assert.ok(!fs.existsSync(path.join(directory,'.git')));assert.ok(!fs.existsSync(path.join(directory,'extension/.env')));assert.ok(!fs.existsSync(path.join(directory,'edge/local-helper')));assert.equal(fs.readFileSync(path.join(root,'.git/config'),'utf8'),'original');
  for(const item of report.files)assert.deepEqual(fs.readFileSync(path.join(directory,item.path)),fs.readFileSync(path.join(root,item.path)));
  const second=prepare(root);assert.notEqual(second.directory,directory);assert.equal(second.report.sourceTreeSha256,report.sourceTreeSha256);
});
