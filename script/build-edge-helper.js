'use strict';
const fs=require('node:fs'),path=require('node:path');
const {buildNativeBundle,installer}=require('./build-native-bundle');
async function main(){
  const root=path.resolve(__dirname,'..'),files=await buildNativeBundle(root);
  for(const [name,data] of Object.entries({...files,'Install.cmd':installer('edge')})){
    const destination=path.join(root,'edge','local-helper',name);
    // A running native host can lock node.exe; identical runtime files need no rewrite.
    if(fs.existsSync(destination) && fs.readFileSync(destination).equals(Buffer.isBuffer(data)?data:Buffer.from(data)))continue;
    fs.mkdirSync(path.dirname(destination),{recursive:true});fs.writeFileSync(destination,data);
  }
  console.log('[helper] Edge 本地程序已准备（含 Windows x64 Node.js 和依赖）；未安装、未修改注册表、未打包。');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
