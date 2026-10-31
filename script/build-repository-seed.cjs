'use strict';
// Data for explicit empty-repository initialization; never a runtime dictionary fallback.
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const C=require('../extension/managed-core');
const ROOT=path.resolve(__dirname,'..'),json=v=>JSON.stringify(v,null,2)+'\n';
const digest=v=>createHash('sha256').update(typeof v==='string'?v:C.canonical(v)).digest('hex');
function seed(){
  const read=p=>fs.readFileSync(path.join(ROOT,p),'utf8').replace(/\r\n/g,'\n');
  const original=JSON.parse(read('dictionaries/github.com/manifest.json'));
  const file=original.languages['zh-Hans'].files.find(f=>f.id==='github.com');
  if(!file||file.requires.length||file.origins.length!==1||file.origins[0]!=='https://github.com')throw Error('初始化词库必须只含 GitHub 主站');
  const raw=read(file.path);if(Buffer.byteLength(raw)!==file.bytes||digest(raw)!==file.sha256)throw Error('初始化词库源文件完整性失败');
  const content={origins:['https://github.com'],files:[file]},revision=digest(content);
  const manifest=json({schemaVersion:1,minReaderVersion:1,group:'github.com',languages:{'zh-Hans':{revision,...content}}});
  const index=json({schemaVersion:1,minReaderVersion:1,groups:[{group:'github.com',manifest:{path:'dictionaries/github.com/manifest.json',bytes:Buffer.byteLength(manifest),sha256:digest(manifest)},languages:{'zh-Hans':revision}}]});
  const source=JSON.parse(read('docs/github-dictionary-conversion.json')).source;
  const files={
    'README.md':'# 网站翻译词库仓库\n\n本仓库用于集中保存网站翻译插件使用的统一 JSON 词库，供插件读取、更新和协作维护。词库数据遵循 GPL-3.0-or-later，来源与版权归属见 THIRD_PARTY_NOTICES.md。\n\n## 连接方式\n\n在网站翻译插件设置中打开“词库仓库”，选择本仓库所在的 GitHub 或 Gitee 平台，输入有权访问本仓库的连接令牌，点击“仓库测试”，选择本仓库并确认。插件自动识别分支，无需填写仓库地址或分支。读取需要仓库读取权限，上传修改需要写入权限。确认后可在网站管理中搜索和下载词库。\n',
    'LICENSE':read('LICENSE'),
    'THIRD_PARTY_NOTICES.md':'# 来源与许可\n\n本仓库是 website-translator 的独立词库数据，不是上游作者发布的官方产品。\n\n词库来自 [MaydayV/github-chinese](https://github.com/MaydayV/github-chinese) 及 [maboloshi/github-chinese](https://github.com/maboloshi/github-chinese)，版权属于 52cik、maboloshi 及社区贡献者，按 GPL 第 3 版或更新版本分发。转换工具与派生源码见 [Ffive55/website-translator](https://github.com/Ffive55/website-translator)。固定来源提交及原文件哈希见 source.json。许可证全文见 LICENSE。\n',
    'source.json':json({schemaVersion:1,extensionVersion:JSON.parse(read('package.json')).version,source}),
    [file.path]:raw,
    'dictionaries/github.com/manifest.json':manifest,
    'dictionaries/index.json':index
  };
  return {schemaVersion:1,files};
}
function buildRepositorySeed(browser,check=false){
  const target=path.join(ROOT,browser,'managed/repository-seed.json'),obsolete=path.join(ROOT,browser,'managed/repository-seed.json.gz'),bytes=Buffer.from(json(seed()));
  if(check){if(fs.existsSync(obsolete)||!fs.existsSync(target)||!fs.readFileSync(target).equals(bytes))throw Error('初始化词库需要重新构建为普通 JSON');}
  else {fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes);if(fs.existsSync(obsolete))fs.unlinkSync(obsolete);}
}
module.exports={seed,buildRepositorySeed};
