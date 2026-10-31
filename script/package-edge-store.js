'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {zipSync,unzipSync}=require('fflate'),{collect,SOURCE_FILES}=require('./package');
const {configuration,privacy}=require('./store-distribution'),{buildNativeBundle,installer}=require('./build-native-bundle');
const ROOT=path.resolve(__dirname,'..'),digest=value=>crypto.createHash('sha256').update(value).digest('hex');
function assertNoNestedArchive(name,bytes){
 const raw=Buffer.from(bytes),signatures=['504b0304','504b0506','504b0708','1f8b','377abcaf271c','526172211a07','425a68','fd377a585a00','28b52ffd'];
 assert.ok(!/\.(?:zip|gz|gzip|tgz|tar|bz2|xz|7z|rar|zst|br|svgz|jar|crx|xpi|vsix)$/i.test(name)&&!signatures.some(hex=>raw.subarray(0,hex.length/2).toString('hex')===hex),'商城包内不允许嵌套压缩资源：'+name);
}
function emit(destination,files){
 const entries=Object.fromEntries(Object.entries(files).map(([name,bytes])=>[name,[bytes,{mtime:new Date(2026,0,1,0,0,0)}]]));
 const zip=Buffer.from(zipSync(entries,{level:6})),unpacked=unzipSync(zip);
 assert.deepEqual(Object.keys(unpacked).sort(),Object.keys(files).sort());
 for(const name of Object.keys(files))assert.ok(Buffer.from(unpacked[name]).equals(Buffer.from(files[name])),'ZIP 校验失败：'+name);
 fs.mkdirSync(path.dirname(destination),{recursive:true});fs.writeFileSync(destination,zip);
 const sha256=digest(zip);fs.writeFileSync(destination+'.sha256',sha256+'  '+path.basename(destination)+'\n');
 return {path:destination,bytes:zip.length,files:Object.keys(files).length,sha256};
}
function storeFiles(root){
 const files=collect(path.join(root,'edge'),['manifest.json','content.js','assets','popup','sites','managed','_locales']);
 for(const name of ['LICENSE','THIRD_PARTY_NOTICES.md'])files[name]=fs.readFileSync(path.join(root,name));
 const manifest=JSON.parse(files['manifest.json']);
 assert.equal(manifest.manifest_version,3);assert.ok(!manifest.permissions.includes('nativeMessaging'));assert.ok(manifest.optional_permissions.includes('nativeMessaging'));
 assert.equal(manifest.default_locale,'zh_CN');
 const messages=JSON.parse(files['_locales/zh_CN/messages.json']);
 for(const key of ['name','description']){const match=/^__MSG_([A-Za-z0-9_]+)__$/.exec(manifest[key]);assert.ok(match&&messages[match[1]]?.message,'商城语言缺少本地化引用：'+key);}
 for(const name of Object.keys(files)){
  assertNoNestedArchive(name,files[name]);
  assert.ok(!/(?:^|\/)(?:local-helper|node_modules|\.git|\.cache)(?:\/|$)|\.(?:exe|cmd|bat|ps1|key|pem|pfx)$/i.test(name),'商城包不接受本地程序或凭据文件：'+name);
  if(/\.(?:js|json|html|css|md)$/.test(name))assert.ok(!/\bgithub_pat_[A-Za-z0-9_]{35,}|\bgh[pousr]_[A-Za-z0-9]{24,}|\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{28,}/.test(Buffer.from(files[name]).toString('utf8')),'疑似密钥：'+name);
 }
 for(const item of manifest.content_scripts)for(const file of [...item.js||[],...item.css||[]])assert.ok(files[file],file);
 for(const file of [manifest.background.service_worker,manifest.options_page,manifest.action.default_popup,'managed/privacy.html','managed/distribution.json'])assert.ok(files[file],file);
 return files;
}
async function packageStore(root=ROOT,{requireReady=false}={}){
 const project=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')),config=configuration(root),prefix=`${project.name}-v${project.version}`;
 const out=path.join(root,'dist'),materials=path.join(out,prefix+'-edge-submission');fs.mkdirSync(materials,{recursive:true});
 const files=storeFiles(root);assert.equal(JSON.parse(files['manifest.json']).version,project.version);
 const store=emit(path.join(out,prefix+'-edge-store.zip'),files);
 const helperFiles={...await buildNativeBundle(root),'Install.cmd':installer('edge'),'Uninstall.cmd':Buffer.from('@echo off\r\nsetlocal DisableDelayedExpansion\r\n"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0native\\install.ps1" -Browser edge -Uninstall\r\npause\r\n')};
 const helper=emit(path.join(out,prefix+'-windows-x64-helper.zip'),helperFiles);
 const sources=collect(root,SOURCE_FILES);require('./prepare-github').auditFiles(sources);
 const source=emit(path.join(out,prefix+'-source.zip'),sources);
 const policySha256=digest(fs.readFileSync(path.join(root,'PRIVACY.md'),'utf8').replace(/\r\n/g,'\n').trimEnd());
 let published;try{published=JSON.parse(fs.readFileSync(path.join(root,'.cache/store-privacy-publication.json'),'utf8'));}catch{}
 const privacyVerified=published?.anonymousStatus===200 && published?.sha256===policySha256 && published?.url===config.values.privacyPolicyUrl;
 const report={version:project.version,developer:config.values.developerName,contact:config.values.contactEmail,store,helper,source,
  publicPrivacyUrl:config.values.privacyPolicyUrl,publicPrivacyVerified:privacyVerified,nativePublicDownload:!!config.values.helperDownloadUrl,
  missingFields:config.pending,submissionFieldsComplete:!config.pending.length&&privacyVerified,sourceVersionPublished:false,certificationSubmitted:false};
 for(const name of ['权限与数据披露.md','商城文案.zh-CN.md','审核测试说明.md'])fs.copyFileSync(path.join(root,'docs/store',name),path.join(materials,name));
 fs.copyFileSync(path.join(root,'PRIVACY.md'),path.join(materials,'PRIVACY.md'));fs.writeFileSync(path.join(materials,'privacy-policy.html'),privacy(root,config));
 fs.copyFileSync(store.path,path.join(materials,path.basename(store.path)));fs.copyFileSync(store.path+'.sha256',path.join(materials,path.basename(store.path)+'.sha256'));
 fs.writeFileSync(path.join(materials,'submission.json'),JSON.stringify(report,null,2)+'\n');
  for(const [from,to] of [[`.cache/v${project.version}-store-verification.json`,'verification.json'],['.cache/store-public-links.json','public-links-verification.json']])if(fs.existsSync(path.join(root,from)))fs.copyFileSync(path.join(root,from),path.join(materials,to));
 fs.writeFileSync(path.join(materials,'提交顺序.txt'),'1. 上传 edge-store.zip 到 Partner Center，不要上传审核材料总包、source.zip 或 helper.zip。\r\n2. 按文案、权限说明和审核步骤填写控制台，隐私政策已公开验证。\r\n3. 当前不提供本地程序公开下载；核心词库/API 功能独立运行。\r\n4. 提交前核对账号、真实服务测试和相同版本源码的公开提供。源码包已在 dist 准备，但代码未推送。\r\n5. 自动化测试与本地准备不代表微软审核通过。\r\n');
 const screenshots=path.join(materials,'screenshots');if(fs.existsSync(screenshots))emit(path.join(out,prefix+'-edge-submission.zip'),collect(materials,fs.readdirSync(materials)));
 fs.writeFileSync(path.join(root,'.cache/v'+project.version+'-store-package-verification.json'),JSON.stringify(report,null,2)+'\n');
 if(requireReady && !report.submissionFieldsComplete)throw Error('公开隐私政策或提交字段尚未完成');
 console.log(JSON.stringify({store:store.path,helper:helper.path,source:source.path,materials,submissionFieldsComplete:report.submissionFieldsComplete,publicPrivacyVerified:privacyVerified,nativePublicDownload:report.nativePublicDownload},null,2));return report;
}
if(require.main===module)packageStore(ROOT,{requireReady:process.argv.includes('--require-ready')}).catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={storeFiles,emit,packageStore,assertNoNestedArchive};
