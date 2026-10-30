'use strict';
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto'),{unzipSync}=require('fflate');
const NODE_VERSION='24.21.0',ARCHIVE=`node-v${NODE_VERSION}-win-x64.zip`;
const NODE_SHA256='158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541';
async function buildNativeBundle(root){
  const cached=path.join(root,'.cache','native-runtime',ARCHIVE);
  let bytes;
  if(fs.existsSync(cached))bytes=fs.readFileSync(cached);
  else {const r=await fetch(`https://nodejs.org/dist/v${NODE_VERSION}/${ARCHIVE}`);if(!r.ok)throw new Error(`Node runtime download: HTTP ${r.status}`);bytes=Buffer.from(await r.arrayBuffer());}
  if(createHash('sha256').update(bytes).digest('hex')!==NODE_SHA256)throw new Error('Node runtime archive checksum mismatch');
  fs.mkdirSync(path.dirname(cached),{recursive:true});if(!fs.existsSync(cached))fs.writeFileSync(cached,bytes);
  const archive=unzipSync(bytes),prefix=`node-v${NODE_VERSION}-win-x64/`,files={};
  for(const [from,to] of [['node.exe','runtime/node.exe'],['LICENSE','runtime/LICENSE.txt']]){if(!archive[prefix+from])throw new Error(`Missing Node ${from}`);files[to]=archive[prefix+from];}
  for(const name of ['host.cjs','oauth.cjs','sync.cjs','install.ps1','secure-store.ps1']){
    const data=fs.readFileSync(path.join(root,'native',name));files['native/'+name]=name.endsWith('.ps1')?Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from(data.toString('utf8').replace(/^\ufeff/,''))]):data;
  }
  for(const name of ['LICENSE','THIRD_PARTY_NOTICES.md','extension/managed-core.js','extension/managed-batching.js'])files[name]=fs.readFileSync(path.join(root,name));
  const joseRoot=path.join(root,'node_modules','jose');
  function addJose(relative){const p=path.join(joseRoot,relative);if(fs.lstatSync(p).isDirectory()){for(const name of fs.readdirSync(p).sort())addJose(path.join(relative,name));}else files['node_modules/jose/'+relative.replaceAll('\\','/')]=fs.readFileSync(p);}
  for(const name of ['package.json','LICENSE.md','dist'])addJose(name);
  const project=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
  files['package.json']=Buffer.from(JSON.stringify({name:'website-translator-local-helper',version:project.version,private:true},null,2));
  files['runtime/source.json']=Buffer.from(JSON.stringify({version:NODE_VERSION,platform:'win32',arch:'x64',url:`https://nodejs.org/dist/v${NODE_VERSION}/${ARCHIVE}`,sha256:NODE_SHA256},null,2));
  files['README.txt']=Buffer.from('Windows x64 本地连接程序\r\n包含 Node.js 与 jose，无需另装 Node.js、npm 或 PowerShell 7。\r\n在插件目录内双击 local-helper\\Install.cmd，粘贴设置页显示的扩展 ID。\r\n完成后返回设置页检查本地连接。浏览器不能自动注册本地主机。\r\n安装后的目录需保持原位置；移动或更新扩展 ID 后重新运行安装。\r\n');
  return files;
}
function installer(browser){return Buffer.from(`@echo off\r\nsetlocal DisableDelayedExpansion\r\n"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0native\\install.ps1" -Browser ${browser} -ExtensionId "%~1"\r\nif errorlevel 1 (echo Installation failed. Please check the message above.) else (echo Installation finished. Return to the extension and check the connection.)\r\npause\r\n`);}
module.exports={buildNativeBundle,installer,NODE_SHA256};
