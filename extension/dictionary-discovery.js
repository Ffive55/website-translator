/* GPL-3.0-or-later. Bounded, read-only repository discovery; no credentials in results. */
(() => {
  'use strict';
  const C=typeof module!=='undefined'?require('./managed-core.js'):WTCore;
  const R=typeof module!=='undefined'?require('./dictionary-repository.js'):C.dictionaryRepository;
  const I=typeof module!=='undefined'?require('./dictionary-initialize.js'):C.dictionaryInitialize;
  function create({provider,token,fetch:send=globalThis.fetch,getDomain,policy,now=Date.now,resumable=[]}) {
    R.platform(provider);C.assert(typeof token==='string' && token.length>0,'请先输入或保存本平台令牌');
    const http=R.transport({provider,token,fetch:send,now}),candidates=[],choices=new Map();
    let user=null,page=1,queue=[],current=null,more=true,done=false,partial=false,scanned=0,empty=0,inaccessible=0,invalid=0,listed=0;
    const snapshot=()=>({provider,login:user,done,partial,scanned,listed,empty,inaccessible,invalid,candidates:[...candidates]});
    function finish(){current=null;scanned++;}
    function add(repository,type,commit=null,groups=0){
      const row=current.row,write=(row.permissions||row.permission)?.push;
      if(type!=='dictionary'&&(write===false||row.archived))return;
      const candidate={id:crypto.randomUUID(),repository,type,commit,private:!!row.private,writePermission:typeof write==='boolean'?write:null,groups};
      candidates.push(candidate);choices.set(candidate.id,candidate);
    }
    async function next() {
      if(done)return snapshot();
      if(user===null){const account=await http.request('/user');C.assert(typeof account.login==='string','平台未返回有效账号');user=account.login;return snapshot();}
      if(!current){
        if(!queue.length && more){
          if(listed>=2000){done=true;partial=true;return snapshot();}
          const rows=await http.request('/user/repos?visibility=all&per_page=100&page='+page++,{maximum:4*1024*1024});
          C.assert(Array.isArray(rows) && rows.length<=100,'仓库列表格式无效');queue=rows;listed+=rows.length;more=rows.length===100;
          return snapshot();
        }
        if(!queue.length){done=true;return snapshot();}
        const row=queue.shift(),full=row.full_name;
        C.assert(typeof full==='string' && full.split('/').length===2,'平台返回的仓库名称无效');
        const [owner,repo]=full.split('/');
        const repository=R.configuration({provider,owner,repo,branch:row.default_branch||'main'});
        current={row,repository,branches:row.default_branch?[repository.branch]:[],page:1,enumerated:false,checked:new Set()};
        const resume=resumable.find(saved=>!saved.done&&R.provider(saved.repository)===provider&&saved.repository.owner===owner&&saved.repository.repo===repo);
        if(resume){add(R.configuration(resume.repository),'resume');finish();return snapshot();}
      }
      if(!current.branches.length){
        if(current.enumerated){finish();return snapshot();}
        const r=current.repository;
        const branches=await http.request('/repos/'+r.owner+'/'+r.repo+'/branches?per_page=100&page='+current.page++);
        C.assert(Array.isArray(branches) && branches.length<=100,'分支列表格式无效');
        if(current.page===2&&branches.length===0&&await I.empty(r,token,send)){empty++;add(r,'empty');finish();return snapshot();}
        current.branches=branches.map(b=>b.name).filter(name=>!current.checked.has(name));
        current.enumerated=branches.length<100 || current.page>10;
        if(current.page>10 && branches.length===100)partial=true;
        return snapshot();
      }
      const branch=current.branches.shift();current.checked.add(branch);
      try {
        const repository=R.configuration({...current.repository,branch});
        const client=R.create({repository,token,fetch:send,getDomain,policy,now}),pin=await client.readIndex(true);
        add(repository,'dictionary',pin.commit,pin.index.groups.length);
        // Prefer the validated default branch; enumerate others only when it has no valid index.
        finish();
      }catch(error){
        // GitHub reports a truly empty Git database as 409. Confirm emptiness
        // using successful branch/tag lists; never classify the 409 alone.
        if(['rate-limit','network'].includes(error.kind)&&error.status!==409)throw error;
        if(error.kind==='authorization'){inaccessible++;finish();}
        else if(error.kind!=='not-found'&&error.status!==409)invalid++;
      }
      return snapshot();
    }
    return {next,snapshot,choice:id=>choices.get(id)?.repository,candidate:id=>choices.get(id)};
  }
  const api={create};if(typeof module!=='undefined')module.exports=api;else C.dictionaryDiscovery=api;
})();
