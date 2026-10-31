'use strict';
const fs=require('node:fs'),path=require('node:path');
const fields=['developerName','contactEmail','privacyPolicyUrl','helperDownloadUrl','supportUrl'];
function configuration(root){
  const filename=path.join(root,'store/publishing.json');
  const values=fs.existsSync(filename)?JSON.parse(fs.readFileSync(filename,'utf8')):Object.fromEntries(fields.map(k=>[k,null]));
  if(Object.keys(values).some(k=>!fields.includes(k)))throw Error('发布配置含未知字段');
  for(const field of fields){
    const value=values[field];if(value===null || value===undefined)continue;
    if(typeof value!=='string'||!value.trim()||value!==value.trim()||/[\r\n\0]/.test(value))throw Error('发布配置无效：'+field);
    if(field.endsWith('Url')){const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password)throw Error('发布地址必须为无凭据的 HTTPS：'+field);}
    if(field==='contactEmail'&&!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value))throw Error('公开邮箱格式无效');
  }
  return {values,pending:['developerName','contactEmail','privacyPolicyUrl'].filter(field=>!values[field]),runtime:{helperDownloadUrl:values.helperDownloadUrl||null,privacyPolicyUrl:values.privacyPolicyUrl||null,supportUrl:values.supportUrl||null}};
}
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function privacy(root,config=configuration(root)){
  const filename=path.join(root,'PRIVACY.md');
  if(!fs.existsSync(filename))return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>隐私政策</title><p>隐私政策尚未生成。</p></html>\n';
  const raw=fs.readFileSync(filename,'utf8').replace(/\{\{(developerName|contactEmail)\}\}/g,(_,field)=>config.values[field]||'发布前待配置');
  const inline=line=>escape(line).replace(/\[([^\]]+)\]\(((?:https:\/\/|mailto:)[^\s)]+)\)/g,'<a href="$2" rel="noopener noreferrer">$1</a>');
  const body=raw.split(/\r?\n\s*\r?\n/).map(block=>{
    const lines=block.trim().split(/\r?\n/);if(/^#{1,3} /.test(lines[0])){const n=lines[0].match(/^#+/)[0].length;return `<h${n}>${inline(lines[0].slice(n+1))}</h${n}>`;}
    if(lines.every(line=>line.startsWith('- ')))return '<ul>'+lines.map(line=>'<li>'+inline(line.slice(2))+'</li>').join('')+'</ul>';
    return '<p>'+lines.map(inline).join('<br>')+'</p>';
  }).join('\n');
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>隐私政策 · 网站翻译插件</title><style>body{font:16px/1.8 system-ui,"Microsoft YaHei",sans-serif;color:#20334e;max-width:900px;margin:auto;padding:28px 24px;background:#fafcff}h1,h2{line-height:1.4}h2{margin-top:32px}a{color:#235fbd}li{margin:8px 0}</style></head><body>'+body+'</body></html>\n';
}
module.exports={configuration,privacy};
