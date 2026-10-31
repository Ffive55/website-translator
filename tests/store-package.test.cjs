'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {configuration,privacy}=require('../script/store-distribution'),{storeFiles,emit,assertNoNestedArchive}=require('../script/package-edge-store');
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'wt-store-'));t.after(()=>{assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('wt-store-'));fs.rmSync(root,{recursive:true,force:true});});return root;}
test('发布地址不能含凭据或执行协议，缺少公开隐私地址明确标记待填',t=>{
 const root=fixture(t);fs.mkdirSync(path.join(root,'store'));const file=path.join(root,'store/publishing.json'),base={developerName:'Publisher',contactEmail:'publisher@example.com',privacyPolicyUrl:null,helperDownloadUrl:null,supportUrl:null};
 fs.writeFileSync(file,JSON.stringify(base));assert.deepEqual(configuration(root).pending,['privacyPolicyUrl']);
 for(const value of ['http://example.com','javascript:alert(1)','https://user:secret@example.com']){fs.writeFileSync(file,JSON.stringify({...base,helperDownloadUrl:value}));assert.throws(()=>configuration(root));}
});
test('商城包只含浏览器运行资源与许可证，本地通信是可选权限，ZIP 逐文件校验',t=>{
 const files=storeFiles(path.resolve(__dirname,'..'));assert.ok(files['managed/privacy.html']);assert.ok(files['managed/distribution.json']);assert.ok(files.LICENSE);assert.ok(!Object.keys(files).some(name=>/local-helper|\.exe$|\.ps1$|\.cmd$/.test(name)));
 const root=fixture(t),result=emit(path.join(root,'store.zip'),files);assert.equal(result.files,Object.keys(files).length);assert.ok(fs.existsSync(result.path+'.sha256'));
});
test('打包隐私页面与公开 Markdown 使用同一文本，不含待填信息',()=>{
 const root=path.resolve(__dirname,'..'),html=privacy(root);assert.match(html,/Ffive55/);assert.match(html,/ffive@foxmail.com/);assert.match(html,/API Key/);assert.match(html,/不对浏览器同步存储另加独立口令加密/);assert.ok(!html.includes('发布前待配置'));assert.ok(!html.includes('<script'));
});
test('商城包拒绝嵌套压缩扩展名和伪装成 JSON 的归档文件，允许普通 JSON 与图片',()=>{
 for(const name of ['data.zip','data.json.gz','data.tar','data.svgz','data.br'])assert.throws(()=>assertNoNestedArchive(name,Buffer.from('{}')),/嵌套压缩/);
 for(const hex of ['504b0304','1f8b0800','377abcaf271c','526172211a07','425a68','fd377a585a00','28b52ffd'])assert.throws(()=>assertNoNestedArchive('data.json',Buffer.from(hex,'hex')),/嵌套压缩/);
 assertNoNestedArchive('data.json',Buffer.from('{}'));assertNoNestedArchive('icon.png',Buffer.from('89504e470d0a1a0a','hex'));
});
test('初始化种子以普通 JSON 分发，协议和运行时不依赖 gzip 解码',()=>{
 const root=path.resolve(__dirname,'..'),filename=path.join(root,'edge/managed/repository-seed.json');
 assert.ok(fs.existsSync(filename));assert.ok(!fs.existsSync(filename+'.gz'));
 const seed=JSON.parse(fs.readFileSync(filename,'utf8'));assert.equal(seed.schemaVersion,1);assert.ok(seed.files['dictionaries/github.com/zh-Hans/github.com.json']);
 assert.ok(!fs.readFileSync(path.join(root,'edge/managed/dictionary-runtime.js'),'utf8').includes('DecompressionStream'));
});
test('商城包默认语言为简体中文，名称和描述有本地化引用，语言文件不会漏打包',()=>{
 const files=storeFiles(path.resolve(__dirname,'..')),manifest=JSON.parse(files['manifest.json']),messages=JSON.parse(files['_locales/zh_CN/messages.json']);
 assert.equal(manifest.default_locale,'zh_CN');assert.equal(manifest.name,'__MSG_extensionName__');assert.equal(manifest.description,'__MSG_extensionDescription__');assert.equal(messages.extensionName.message,'网站翻译插件');assert.ok(messages.extensionDescription.message.includes('本地词库'));
});
