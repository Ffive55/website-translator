'use strict';
// Export a reviewable source tree. This command never stages, commits, or contacts GitHub.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {collect,SOURCE_FILES}=require('./package');
const ROOT=path.resolve(__dirname,'..');
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
function auditFiles(files){
  const failures=[];
  const rules=[
    ['private-key',/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
    ['github-token',/\bgh[pousr]_[A-Za-z0-9]{24,}\b|\bgithub_pat_[A-Za-z0-9_]{35,}\b/],
    ['api-token',/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{28,}\b/],
    ['personal-profile-path',/[A-Z]:[\\/]+Users[\\/]+(?!Public\b|Default\b|<|%|\$)[\w.-]+[\\/]/i]
  ];
  for(const [name,bytes] of Object.entries(files)){
    if(path.posix.isAbsolute(name) || name.includes('\\') || name.split('/').some(part=>part==='..' || part==='.') || name.includes('\0'))failures.push({path:name,rule:'unsafe-relative-path'});
    if(/(^|\/)(?:node_modules|\.git|\.cache|local-helper|dist|test-results|\.local-native)(\/|$)/.test(name) || /(^|\/)\.env(?:\.|$)/.test(name) || /\.(?:exe|zip|log|key|pem|pfx|dat|sqlite|db)$/i.test(name))failures.push({path:name,rule:'local-or-binary-file'});
    if(/\.(?:png|jpg|jpeg|webp)$/i.test(name) && !/(^|\/)assets\//.test(name))failures.push({path:name,rule:'unreviewed-image'});
    if(bytes.length>20*1024*1024)failures.push({path:name,rule:'large-file'});
    if(!/\.(?:png|ico|woff2?)$/i.test(name))for(const [rule,pattern] of rules)if(pattern.test(bytes.toString('utf8')))failures.push({path:name,rule});
  }
  if(failures.length)throw new Error('源码检查失败（只显示路径与规则，不显示匹配内容）：'+JSON.stringify(failures));
  for(const name of ['README.md','AGENTS.md','LICENSE','THIRD_PARTY_NOTICES.md','package.json','package-lock.json','docs/source-baseline.json','upstream/github-chinese/lock.json'])if(!files[name])throw new Error('缺少必需文件：'+name);
  const project=JSON.parse(files['package.json']);
  if(JSON.parse(files['edge/manifest.json']).version!==project.version)throw new Error('Edge 版本与项目不一致');
  return Object.entries(files).sort(([a],[b])=>a.localeCompare(b,'en')).map(([name,bytes])=>({path:name,bytes:bytes.length,sha256:digest(bytes)}));
}
function prepare(root=ROOT,{check=false}={}){
  const files=collect(root,SOURCE_FILES),entries=auditFiles(files),version=JSON.parse(files['package.json']).version;
  if(!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version))throw new Error('版本号不能用于输出目录');
  const report={schemaVersion:1,version,sourceCommit:null,sourceTreeSha256:digest(JSON.stringify(entries)),fileCount:entries.length,totalBytes:entries.reduce((n,f)=>n+f.bytes,0),files:entries};
  if(check){console.log(JSON.stringify({checked:true,version,files:report.fileCount,bytes:report.totalBytes,sourceTreeSha256:report.sourceTreeSha256}));return report;}
  const parent=path.join(root,'.cache','github-ready',`v${version}-${new Date().toISOString().replace(/[:.]/g,'-')}-${crypto.randomUUID().slice(0,8)}`),destination=path.join(parent,'website-translator');
  fs.mkdirSync(destination,{recursive:true});
  for(const [name,bytes] of Object.entries(files)){const target=path.join(destination,name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes,{flag:'wx'});if(digest(fs.readFileSync(target))!==digest(bytes))throw new Error('导出校验失败：'+name);}
  fs.writeFileSync(path.join(parent,'inventory.json'),JSON.stringify(report,null,2)+'\n');
  fs.writeFileSync(path.join(parent,'filelist.txt'),entries.map(e=>e.path).join('\n')+'\n');
  fs.writeFileSync(path.join(parent,'PREPARATION.txt'),'此目录仅为本地上传准备，未创建 GitHub 仓库或推送。\nwebsite-translator/ 为候选源码目录；inventory.json 为逐文件 SHA-256。\n未建立提交，所以 sourceCommit 为 null。当前仅 Edge 构建为本版本；其他浏览器目录保留供源码维护。\n源码目录不含 node_modules 或 local-helper；加载前执行 npm ci 和 npm run build。\n敏感信息扫描是规则检查，不构成不存在任何敏感信息的证明；上传前仍需审阅候选文件。\n');
  console.log(JSON.stringify({prepared:true,directory:destination,inventory:path.join(parent,'inventory.json'),files:report.fileCount,bytes:report.totalBytes,sourceTreeSha256:report.sourceTreeSha256},null,2));
  return {directory:destination,report};
}
if(require.main===module){try{if(process.argv.slice(2).some(arg=>arg!=='--check'))throw new Error('只支持 --check 参数');prepare(ROOT,{check:process.argv.includes('--check')});}catch(e){console.error(e.message);process.exitCode=1;}}
module.exports={auditFiles,prepare};
