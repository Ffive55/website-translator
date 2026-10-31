'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { OAuth } = require('./oauth.cjs');
function encode(message) {
  const data=Buffer.from(JSON.stringify(message));if(data.length>1000000)throw new Error('本地响应超过消息上限');
  const header=Buffer.alloc(4);header.writeUInt32LE(data.length);return Buffer.concat([header,data]);
}
async function main(){
  const directory=path.join(process.env.LOCALAPPDATA || require('node:os').homedir(),'WebsiteTranslator');
  await fs.mkdir(directory,{recursive:true,mode:0o700});
  const controller=new AbortController();
  const oauth=new OAuth(directory,{signal:controller.signal});
  let pending=Buffer.alloc(0),chain=Promise.resolve(),closed=false;
  const send=message=>{if(!closed)process.stdout.write(encode(message));};
  process.stdout.on('error',()=>{closed=true;controller.abort();});
  async function handle(message){
    switch(message.action){
      case 'ping':return {connected:true,version:require('../package.json').version};
      case 'status':return oauth.status();
      case 'login':return oauth.login(result=>send({ok:true,result}));
      case 'logout':return oauth.logout();
      case 'models':return oauth.models();
      case 'translate':return oauth.translate(message.model,message.payload,message.prompt,message.reasoningEffort,message.timeoutMinutes,message.inputContextK);
      default:throw new Error('未知本地操作');
    }
  }
  process.stdin.on('data',chunk=>{
    pending=Buffer.concat([pending,chunk]);
    while(pending.length>=4){
      const size=pending.readUInt32LE();if(!size || size>9000000){closed=true;controller.abort();process.exitCode=1;process.stdin.destroy();return;}
      if(pending.length<4+size)return;
      const data=pending.subarray(4,4+size);pending=pending.subarray(4+size);
      chain=chain.then(async()=>{if(closed)return;try{const result=await handle(JSON.parse(data));send({ok:true,result});}catch(e){send({ok:false,error:e instanceof SyntaxError?'本地消息或数据格式无效':e.message,kind:e.kind,status:e.status,retryAfterMs:e.retryAfterMs});}});
    }
  });
  process.stdin.on('end',()=>{closed=true;controller.abort();chain.finally(()=>process.exit());});
}
if(require.main===module)main().catch(()=>process.exitCode=1);
module.exports={encode};
