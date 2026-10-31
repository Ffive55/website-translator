/* GPL-3.0-or-later. Safe HTTP diagnostics; never expose response bodies or tokens. */
(() => {
  'use strict';
  async function fromResponse(response, { authenticated=false, write=false, now=Date.now() }={}) {
    let message='';
    try{const reader=response.body?.getReader();if(reader){let size=0;const chunks=[];try{while(size<8192){const r=await reader.read();if(r.done)break;size+=r.value.length;chunks.push(r.value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}if(size<=8192){const data=new Uint8Array(size);let pos=0;for(const chunk of chunks){data.set(chunk,pos);pos+=chunk.length;}message=JSON.parse(new TextDecoder().decode(data)).message || '';}}}catch{}
    const retry=response.headers.get('retry-after'),reset=Number(response.headers.get('x-ratelimit-reset'))*1000;
    const rate=response.status===429 || response.status===403&&(response.headers.get('x-ratelimit-remaining')==='0'||retry!==null||/rate limit|secondary rate|abuse/i.test(message));
    let kind='network',text=`GitHub 请求失败（HTTP ${response.status}），本机词库和修改保留`,retryAt=0;
    if(rate){kind='rate-limit';const seconds=retry!==null?Number(retry):NaN;retryAt=Number.isFinite(seconds)?now+Math.max(1,seconds)*1000:retry&&Number.isFinite(Date.parse(retry))?Date.parse(retry):reset>now?reset:now+60000;text='GitHub 已限流（HTTP '+response.status+'），暂停请求至 '+new Date(retryAt).toLocaleTimeString('zh-CN',{hour12:false})+' 后重试；本机词库仍可使用';}
    else if(response.status===401){kind='authorization';text=authenticated?'GitHub Token 验证失败（HTTP 401），请更新本设备凭据':'私有词库需要在本设备配置 GitHub Token（HTTP 401）';}
    else if(response.status===403){kind='authorization';text=response.headers.get('x-github-sso')?.includes('required')?'GitHub 组织要求为 Token 完成 SSO 授权（HTTP 403）':'GitHub 权限不足（HTTP 403），请检查 Token 所选仓库及 Contents '+(write?'写入':'读取')+'权限；这不是已确认的限流';}
    else if(response.status===404){kind='not-found';text='仓库、分支或词库不存在，或当前 Token 无权读取（HTTP 404）；请核对仓库和发布状态';}
    const number=name=>{const value=response.headers.get(name);return value!==null&&Number.isFinite(Number(value))?Number(value):null;};
    const rateLimit={limit:number('x-ratelimit-limit'),remaining:number('x-ratelimit-remaining'),used:number('x-ratelimit-used'),resetAt:reset||null};
    if(rate)text+='；'+(authenticated?'已携带 Token':'匿名请求')+(rateLimit.limit!==null?'，配额 '+rateLimit.limit+'/小时':'')+(rateLimit.remaining!==null?'，剩余 '+rateLimit.remaining:'');
    const error=new Error(text);Object.assign(error,{status:response.status,kind,retryAt,authenticated,rateLimit,requestId:response.headers.get('x-github-request-id')||undefined});return error;
  }
  const api={fromResponse};if(typeof module!=='undefined')module.exports=api;else WTCore.dictionaryErrors=api;
})();
