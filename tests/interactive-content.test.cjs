'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom'),C=require('../extension/managed-core');
const wait=(ms=220)=>new Promise(r=>setTimeout(r,ms));
async function fixture(t,html,extra={}) {
  const dom=new JSDOM('<html lang="en"><body>'+html+'</body></html>',{url:'https://example.com/settings',runScripts:'outside-only'});
  t.after(()=>dom.window.close());const w=dom.window,calls=[],listeners=[];
  const site={id:'https://example.com',enabled:true,deleted:false,targetLanguage:'zh-Hans',excludedPaths:[],entries:{}};
  const state={site,globalEnabled:true,...extra};
  w.chrome={runtime:{id:'test',onMessage:{addListener:fn=>listeners.push(fn)},sendMessage:async m=>{calls.push(m);return m.type==='wt:page'?{ok:true,result:state}:{ok:true,result:true};}}};
  for(const name of ['managed-core.js','text-provenance.js','managed-content.js'])w.eval(fs.readFileSync(path.join(__dirname,'../extension',name),'utf8'));
  await wait(30);
  return {w,site,state,calls,scan:()=>Array.from(w.WTPage.collect().items),request:m=>new Promise(resolve=>listeners[0](m,{id:'test'},resolve)),translate(){for(const item of w.WTPage.collect().items){const e={...item,targetLanguage:site.targetLanguage,sourceLanguage:null,translation:'译文：'+item.sourceText,category:'ui',action:'translate',origin:'ai'};site.entries[C.entryKey(e)]=e;}w.WTPage.apply();},update(){listeners[0]({type:'wt:apply',...state},{id:'test'},()=>{});}};
}

test('原生下拉翻译显示标签，保留显式/隐式提交值、选中状态和原始属性',async t=>{
  const f=await fixture(t,'<form><select name="sort"><optgroup label="Sort order"><option>Recommended</option><option value="price" label="Lowest price">Price ascending</option></optgroup></select></form>');
  const select=f.w.document.querySelector('select'),[first,second]=select.options;
  assert.deepEqual(f.scan().map(i=>i.sourceText),['Sort order','Recommended','Lowest price']);
  f.translate();assert.equal(first.label,'译文：Recommended');assert.equal(second.label,'译文：Lowest price');
  assert.equal(first.value,'Recommended');assert.equal(second.value,'price');assert.equal(first.textContent,'Recommended');assert.equal(select.selectedIndex,0);
  assert.equal(new f.w.FormData(f.w.document.querySelector('form')).get('sort'),'Recommended');assert.equal(f.scan().length,0);
  first.textContent='Popular choices';assert.ok(f.scan().some(i=>i.sourceText==='Popular choices'));f.translate();assert.equal(first.label,'译文：Popular choices');
  second.setAttribute('label','Newest first');assert.ok(f.scan().some(i=>i.sourceText==='Newest first'));
  f.site.targetLanguage='ja';f.w.WTPage.apply();assert.equal(first.hasAttribute('label'),false);assert.equal(second.label,'Newest first');
  f.site.targetLanguage='zh-Hans';f.w.WTPage.apply();assert.equal(first.label,'译文：Popular choices');
  f.site.enabled=false;f.w.WTPage.apply();assert.equal(first.hasAttribute('label'),false);assert.equal(f.w.document.documentElement.lang,'en');
});

test('隐藏的语义菜单和悬浮提示可采集，普通隐藏区及私密内容仍跳过',async t=>{
  const f=await fixture(t,`<div role="tooltip" hidden>How usage is calculated</div><div role="listbox" aria-hidden="true"><div role="option">Monthly billing</div></div>
    <div hidden>Hidden private panel</div><div data-private><div role="tooltip">Private tooltip</div></div>
    <div hidden><div role="tooltip">Hidden private ancestor</div></div><div role="menu"><code>secret code</code><input value="private-input"><span>person@example.com</span></div>
    <select name="deviceName"><option>Office workstation</option></select><select data-sensitive><option>Secret option</option></select>`);
  assert.deepEqual(f.scan().map(i=>i.sourceText).sort(),['How usage is calculated','Monthly billing'].sort());
  f.translate();assert.equal(f.w.document.querySelector('[role=tooltip]').textContent,'译文：How usage is calculated');
  assert.equal(f.w.document.querySelector('input').value,'private-input');assert.equal(f.w.document.querySelector('select option').label,'Office workstation');
});

test('短暂弹层关闭后仍可更新和持续采集，再出现复用词库且不自动请求 AI',async t=>{
  const f=await fixture(t,'<main></main>',{captureId:'capture'});
  const tip=f.w.document.createElement('div');tip.setAttribute('role','tooltip');tip.textContent='Tasks are inferred from a representative sample';f.w.document.body.append(tip);
  await wait(10);tip.remove();await wait();
  assert.ok(f.calls.some(m=>m.type==='wt:capture-data' && m.scan.items.some(i=>i.sourceText===tip.textContent)));
  assert.ok(f.scan().some(i=>i.sourceText===tip.textContent));f.translate();
  const replacement=tip.cloneNode(true);f.w.document.body.append(replacement);await wait();assert.equal(replacement.textContent,'译文：Tasks are inferred from a representative sample');
  assert.equal(f.scan().length,0);assert.ok(f.calls.every(m=>['wt:page','wt:capture-data'].includes(m.type)));
  f.site.enabled=false;f.update();assert.equal(replacement.textContent,tip.textContent);replacement.remove();assert.equal(f.scan().length,0);
});

test('临时记录去重、遵守预算，路由变化不串页，网站改写只采集最新原文',async t=>{
  const f=await fixture(t,'',{captureLimits:{pageCaptureItems:2,pageCaptureChars:1000}});
  async function flash(value){const el=f.w.document.createElement('div');el.setAttribute('role','tooltip');el.textContent=value;f.w.document.body.append(el);await wait(5);el.remove();await wait(5);}
  await flash('First help');await flash('First help');await flash('Second help');
  assert.equal(f.scan().length,2);await flash('Third help');assert.equal(f.scan().length,2);assert.equal(f.w.WTPage.collect().truncated,true);
  f.w.history.pushState({},'','/next');assert.equal(f.scan().length,0);
  const tip=f.w.document.createElement('div');tip.setAttribute('role','tooltip');tip.textContent='Old help';f.w.document.body.append(tip);await wait(5);tip.textContent='New help';await wait(5);tip.remove();await wait(5);
  assert.deepEqual(f.scan().map(i=>i.sourceText),['New help']);assert.equal(f.scan()[0].path,'/next');
  f.translate();await flash('Another help');await flash('Further help');assert.deepEqual(f.scan().map(i=>i.sourceText),['Another help','Further help'],'已处理的临时条目释放预算');
});

test('原生选项已有内置翻译时不重复采集其文本作为标签',async t=>{
  const f=await fixture(t,'<select><option value="fixed">Builtin option</option></select>');
  f.w.WTText.writeText(f.w.document.querySelector('option').firstChild,'内置选项','builtin');
  assert.equal(f.scan().length,0);assert.equal(f.w.document.querySelector('option').label,'内置选项');
});

test('只有明确请求才展开：兼容点击入口，保留既有展开和焦点，不点击动作、链接或提交',async t=>{
  const f=await fixture(t,`<button type="button" id="focus">Focus anchor</button><button type="button" id="trigger" aria-haspopup="menu" aria-expanded="false">Open menu</button>
    <button type="button" id="open" aria-haspopup="menu" aria-expanded="true">Already open</button><button type="button" id="delete">Delete</button>
    <form><button aria-haspopup="menu">Submit</button></form><a href="/elsewhere" aria-haspopup="menu">Navigate</a><div data-private><button type="button" aria-haspopup="menu">Private</button></div>`);
  const {w}=f;w.PointerEvent=w.MouseEvent;w.HTMLElement.prototype.getClientRects=()=>[{}];
  const trigger=w.document.querySelector('#trigger');let clicks=0,otherClicks=0;
  for(const el of w.document.querySelectorAll('button,a'))el.onclick=()=>otherClicks++;
  trigger.onclick=()=>{clicks++;const menu=w.document.querySelector('[role=menu]');if(menu){menu.remove();trigger.setAttribute('aria-expanded','false');}else{const menu=w.document.createElement('div');menu.setAttribute('role','menu');menu.textContent='Lazily created choice';w.document.body.append(menu);trigger.setAttribute('aria-expanded','true');}};
  w.document.querySelector('#focus').focus();
  await f.request({type:'wt:collect'});assert.equal(clicks,0);
  const scan=await f.request({type:'wt:collect',expand:true});
  assert.ok(scan.items.some(i=>i.sourceText==='Lazily created choice'));assert.equal(clicks,2);assert.equal(otherClicks,0);
  assert.equal(trigger.getAttribute('aria-expanded'),'false');assert.equal(w.document.querySelector('#open').getAttribute('aria-expanded'),'true');assert.equal(w.document.activeElement.id,'focus');
  assert.ok(f.calls.every(m=>m.type==='wt:page'));
  f.state.globalEnabled=false;f.update();await f.request({type:'wt:collect',expand:true});assert.equal(clicks,2);
});

test('OpenRouter Base UI 提示可发现且信息图标优先，时间充足时一轮可超过 20 个入口',async t=>{
  const cells=Array.from({length:25},(_,i)=>`<button type="button" data-base-ui-tooltip-trigger aria-pressed="false">Chart cell ${i}</button>`).join('');
  const f=await fixture(t,cells+'<button type="button" tabindex="-1" id="info" aria-label="Information" data-base-ui-tooltip-trigger><svg aria-hidden="true"></svg></button>');
  const {w}=f,visited=[];w.PointerEvent=w.MouseEvent;w.HTMLElement.prototype.getClientRects=()=>[{}];
  const setTimer=w.setTimeout.bind(w);w.setTimeout=(fn,ms,...args)=>setTimer(fn,ms===800?0:ms,...args);
  for(const el of w.document.querySelectorAll('button'))el.addEventListener('mouseenter',()=>visited.push(el.id || el.textContent));
  const info=w.document.querySelector('#info');let clicks=0;
  info.onclick=()=>clicks++;
  info.addEventListener('mouseenter',()=>{
    const portal=w.document.createElement('div');portal.setAttribute('data-base-ui-portal','');
    portal.innerHTML='<div role="presentation" data-side="top" data-align="center"><div data-base-ui-focusable data-side="top" data-open tabindex="-1" class="overflow-hidden rounded-md bg-inverse text-xs">Tasks are inferred by a classifier on a representative sample of prompts.</div></div>';
    w.document.body.append(portal);
  });
  info.addEventListener('mouseleave',()=>w.document.querySelector('[data-base-ui-portal]')?.remove());
  const scan=await f.request({type:'wt:collect',expand:true});
  assert.equal(visited[0],'info');assert.equal(clicks,0);assert.equal(scan.exploration.attempted,26);assert.equal(scan.exploration.limited,false);
  assert.ok(scan.items.some(i=>i.sourceText.startsWith('Tasks are inferred') && !i.context.includes('/@')),'实际提示正文被保留，不能仅采集 aria-label');
  assert.equal(w.document.querySelector('[data-base-ui-portal]'),null);assert.ok(f.calls.every(m=>m.type==='wt:page'));
});

test('同页重复更新跳过已读取提示，译文写入不使进度失效，入口变化、路由和语言切换重新检查',async t=>{
  const f=await fixture(t,'<button type="button" data-base-ui-tooltip-trigger aria-label="Help">Help</button>');
  const {w}=f;w.PointerEvent=w.MouseEvent;w.HTMLElement.prototype.getClientRects=()=>[{}];
  const timer=w.setTimeout.bind(w);w.setTimeout=(fn,ms,...args)=>timer(fn,ms===800?0:ms,...args);
  const trigger=w.document.querySelector('button');let opened=0;
  trigger.onmouseenter=()=>{opened++;const tip=w.document.createElement('div');tip.setAttribute('role','tooltip');tip.textContent='Explanation of rankings';w.document.body.append(tip);};
  trigger.onmouseleave=()=>w.document.querySelector('[role=tooltip]')?.remove();
  assert.equal((await f.request({type:'wt:collect',expand:true})).exploration.attempted,1);
  assert.equal((await f.request({type:'wt:collect',expand:true})).exploration.attempted,0);assert.equal(opened,1);
  f.translate();assert.equal((await f.request({type:'wt:collect',expand:true})).exploration.attempted,0);
  trigger.setAttribute('aria-label','Changed help');await f.request({type:'wt:collect',expand:true});assert.equal(opened,2);
  w.history.pushState({},'','/next');await f.request({type:'wt:collect',expand:true});assert.equal(opened,3);
  f.site.targetLanguage='ja';await f.request({type:'wt:collect',expand:true});assert.equal(opened,4);
});

test('长页优先读取下拉选项，后续更新接着扫描剩余入口，非 button 的 combobox 也能展开',async t=>{
  const tips=Array.from({length:24},(_,i)=>`<button type="button" id="tip${i}" data-base-ui-tooltip-trigger><svg></svg></button>`).join('');
  const f=await fixture(t,tips+'<div id="choices" role="combobox" tabindex="0" aria-expanded="false" aria-haspopup="listbox">Choices</div>');
  const {w}=f;w.PointerEvent=w.MouseEvent;w.HTMLElement.prototype.getClientRects=()=>[{}];
  let elapsed=0;w.Date.now=()=>elapsed;const timer=w.setTimeout.bind(w);w.setTimeout=(fn,ms,...args)=>timer(()=>{if(ms===800)elapsed+=800;fn(...args);},ms===800?0:ms);const order=[];
  for(const el of w.document.querySelectorAll('button')){
    el.onmouseenter=()=>{order.push(el.id);const tip=w.document.createElement('div');tip.setAttribute('role','tooltip');tip.textContent='Explanation '+el.id;w.document.body.append(tip);};
    el.onmouseleave=()=>w.document.querySelector('[role=tooltip]')?.remove();
  }
  const combo=w.document.querySelector('#choices');let selections=0;
  combo.onclick=()=>{if(w.document.querySelector('[role=listbox]')){w.document.querySelector('[role=listbox]').remove();combo.setAttribute('aria-expanded','false');return;}order.push('choices');const menu=w.document.createElement('div');menu.id='lazy-options';menu.setAttribute('role','listbox');menu.innerHTML='<div role="option">Open models</div><div role="option">Closed models</div>';menu.onclick=()=>selections++;w.document.body.append(menu);combo.setAttribute('aria-controls','lazy-options');combo.setAttribute('aria-expanded','true');};
  const first=await f.request({type:'wt:collect',expand:true});assert.equal(order[0],'choices');assert.equal(first.exploration.attempted,15);assert.equal(first.exploration.limited,true);
  assert.ok(first.items.some(i=>i.sourceText==='Closed models'));assert.equal(combo.getAttribute('aria-expanded'),'false');assert.equal(selections,0);
  const second=await f.request({type:'wt:collect',expand:true});assert.equal(second.exploration.attempted,10);assert.equal(order.length,25);
  assert.equal((await f.request({type:'wt:collect',expand:true})).exploration.attempted,0);
});

test('弹层选项优先于长页占用额度，无法打开的入口不会永久挡住后续控件',async t=>{
  const f=await fixture(t,'<main><p>Long page first item</p><button type="button" data-base-ui-tooltip-trigger>Unavailable help</button></main><div role="listbox"><div role="option">Dropdown choice</div></div>',{captureLimits:{pageCaptureItems:1}});
  assert.equal(f.scan()[0].sourceText,'Dropdown choice');
  const {w}=f;w.PointerEvent=w.MouseEvent;w.HTMLElement.prototype.getClientRects=()=>[{}];const timer=w.setTimeout.bind(w);w.setTimeout=(fn,ms,...args)=>timer(fn,ms===800?0:ms,...args);
  assert.equal((await f.request({type:'wt:collect',expand:true})).exploration.attempted,1);
  assert.equal((await f.request({type:'wt:collect',expand:true})).exploration.attempted,1);
  assert.equal((await f.request({type:'wt:collect',expand:true})).exploration.attempted,0);
});

test('下拉选项超过单页额度时不会误记为完成，已处理词条释放额度后继续补采',async t=>{
  const f=await fixture(t,'<button type="button" aria-haspopup="listbox" aria-expanded="false">Choose</button>',{captureLimits:{pageCaptureItems:1}});
  const {w}=f;w.PointerEvent=w.MouseEvent;w.HTMLElement.prototype.getClientRects=()=>[{}];const timer=w.setTimeout.bind(w);w.setTimeout=(fn,ms,...args)=>timer(fn,ms===800?0:ms,...args);
  const trigger=w.document.querySelector('button');let opens=0;
  trigger.onclick=()=>{const old=w.document.querySelector('[role=listbox]');if(old){old.remove();trigger.setAttribute('aria-expanded','false');return;}opens++;const menu=w.document.createElement('div');menu.setAttribute('role','listbox');menu.innerHTML='<div role="option">First choice</div><div role="option">Second choice</div>';w.document.body.append(menu);trigger.setAttribute('aria-expanded','true');};
  const first=await f.request({type:'wt:collect',expand:true});assert.equal(first.items[0].sourceText,'First choice');f.translate();
  const second=await f.request({type:'wt:collect',expand:true});assert.equal(second.items[0].sourceText,'Second choice');f.translate();
  assert.equal((await f.request({type:'wt:collect',expand:true})).exploration.attempted,0);assert.equal(opens,2);
});

test('自动展开使用配置时限，运行中固定启动值，下一轮读取新设置并接续进度',async t=>{
  assert.equal(C.autoExpandSeconds(),12);assert.equal(C.autoExpandSeconds(1),1);assert.equal(C.autoExpandSeconds(120),120);
  for(const value of [0,121,1.2,'12',null])assert.throws(()=>C.autoExpandSeconds(value));
  const f=await fixture(t,Array.from({length:8},(_,i)=>`<button type="button" data-base-ui-tooltip-trigger>Help ${i}</button>`).join(''),{autoExpandSeconds:1});
  const {w}=f;w.PointerEvent=w.MouseEvent;w.HTMLElement.prototype.getClientRects=()=>[{}];let elapsed=0,changed=false;
  w.Date.now=()=>elapsed;const timer=w.setTimeout.bind(w);
  w.setTimeout=(fn,ms,...args)=>timer(()=>{if(ms===800){elapsed+=800;if(!changed){changed=true;f.state.autoExpandSeconds=120;f.update();}}fn(...args);},ms===800?0:ms);
  for(const el of w.document.querySelectorAll('button')){
    el.onmouseenter=()=>{const tip=w.document.createElement('div');tip.setAttribute('role','tooltip');tip.textContent='Explanation for '+el.textContent;w.document.body.append(tip);};
    el.onmouseleave=()=>w.document.querySelector('[role=tooltip]')?.remove();
  }
  const first=await f.request({type:'wt:collect',expand:true});assert.equal(first.exploration.attempted,2);assert.equal(first.exploration.limited,true,'运行中改成 120 秒不能延长当前 1 秒扫描');
  const second=await f.request({type:'wt:collect',expand:true,autoExpandSeconds:3});assert.equal(second.exploration.attempted,4);assert.equal(second.exploration.limited,true);
  const last=await f.request({type:'wt:collect',expand:true,autoExpandSeconds:12});assert.equal(last.exploration.attempted,2);assert.equal(last.exploration.limited,false);
});

test('热门应用简介的 Base UI dialog 悬浮卡片可独立采集、复用且不点击入口或应用链接',async t=>{
  const source='A coding agent that helps you build and ship with AI';
  const f=await fixture(t,`<main><a href="/apps/codex">Codex</a><span class="truncate cursor-help inline-block" role="button" tabindex="0" data-base-ui-click-trigger aria-haspopup="dialog" aria-expanded="false">${source}</span></main>`);
  f.translate();const {w}=f;w.PointerEvent=w.MouseEvent;w.HTMLElement.prototype.getClientRects=()=>[{}];const timer=w.setTimeout.bind(w);w.setTimeout=(fn,ms,...args)=>timer(fn,ms===800?0:ms,...args);
  const trigger=w.document.querySelector('span');let clicks=0,opens=0;
  trigger.onclick=w.document.querySelector('a').onclick=()=>clicks++;
  trigger.onmouseenter=()=>{opens++;const portal=w.document.createElement('div');portal.setAttribute('data-base-ui-portal','');portal.innerHTML='<div role="dialog">'+source+'</div>';w.document.body.append(portal);trigger.setAttribute('aria-expanded','true');};
  w.document.addEventListener('keydown',event=>{if(event.key==='Escape'){w.document.querySelector('[data-base-ui-portal]')?.remove();trigger.setAttribute('aria-expanded','false');}});
  const scan=await f.request({type:'wt:collect',expand:true});assert.ok(scan.items.some(i=>i.sourceText===source && i.context==='page/div/dialog'));
  assert.equal(w.document.querySelector('[role=dialog]'),null);assert.equal(clicks,0);assert.equal(trigger.getAttribute('aria-expanded'),'false');
  assert.equal((await f.request({type:'wt:collect',expand:true})).exploration.attempted,0);assert.equal(opens,1);
  f.translate();trigger.dispatchEvent(new w.MouseEvent('mouseenter'));await wait();assert.equal(w.document.querySelector('[role=dialog]').textContent,'译文：'+source);assert.equal(clicks,0);
});

test('下拉框回填已翻译的选中标签并重新生成 popup ID，不应重新展开已采集选项',async t=>{
  const f=await fixture(t,'<div id="filters"><button type="button" role="combobox" aria-label="Sort order" aria-haspopup="listbox" aria-expanded="false"><span>Recommended</span></button></div>');
  const {w}=f;w.PointerEvent=w.MouseEvent;w.HTMLElement.prototype.getClientRects=()=>[{}];const timer=w.setTimeout.bind(w);w.setTimeout=(fn,ms,...args)=>timer(fn,ms===800?0:ms,...args);
  const trigger=w.document.querySelector('button');let opens=0;
  trigger.onclick=()=>{const old=w.document.querySelector('[role=listbox]');if(old){old.remove();trigger.setAttribute('aria-expanded','false');trigger.removeAttribute('aria-controls');return;}opens++;const menu=w.document.createElement('div');menu.setAttribute('role','listbox');menu.textContent='Recommended';menu.id='base-ui-popup-'+opens;w.document.body.append(menu);trigger.setAttribute('aria-controls',menu.id);trigger.setAttribute('aria-expanded','true');};
  await f.request({type:'wt:collect',expand:true});f.translate();
  const displayed=trigger.querySelector('span').textContent;trigger.querySelector('span').replaceChildren(w.document.createTextNode(displayed));
  // This is a website rewrite, not extension provenance; keep that distinction.
  assert.equal(w.WTText.owner(trigger.querySelector('span').firstChild),null);
  assert.equal((await f.request({type:'wt:collect',expand:true})).exploration.attempted,0);assert.equal(opens,1);
});

test('同一命名下拉框重绘替换 DOM 节点仍复用进度，不串用其他控件且名称变化重新检查',async t=>{
  const f=await fixture(t,'<div id="filters"><button type="button" role="combobox" aria-label="Model type" aria-haspopup="listbox" aria-expanded="false">All models</button></div><div id="other-filters"><button type="button" role="combobox" aria-label="Model type" aria-haspopup="listbox" aria-expanded="false">All models</button></div>');
  const {w}=f;w.PointerEvent=w.MouseEvent;w.HTMLElement.prototype.getClientRects=()=>[{}];const timer=w.setTimeout.bind(w);w.setTimeout=(fn,ms,...args)=>timer(fn,ms===800?0:ms,...args);const counts={};
  function bind(trigger){const group=trigger.parentElement.id;trigger.onclick=()=>{const old=w.document.querySelector('[role=listbox]');if(old){old.remove();trigger.setAttribute('aria-expanded','false');return;}counts[group]=(counts[group] || 0)+1;const menu=w.document.createElement('div');menu.setAttribute('role','listbox');menu.textContent=group==='filters'?'Open models':'Other choices';w.document.body.append(menu);trigger.setAttribute('aria-expanded','true');};}
  w.document.querySelectorAll('button').forEach(bind);await f.request({type:'wt:collect',expand:true});f.translate();
  const old=w.document.querySelector('#filters button');
  const clone=old.cloneNode(true);clone.setAttribute('aria-label','Model type');clone.id='base-ui-new-trigger';old.replaceWith(clone);bind(clone);
  assert.equal((await f.request({type:'wt:collect',expand:true})).exploration.attempted,0);assert.deepEqual(counts,{filters:1,'other-filters':1});
  clone.setAttribute('aria-label','Different filter');await f.request({type:'wt:collect',expand:true});assert.equal(counts.filters,2);
});

test('下拉框关闭动画结束后清除临时 aria-controls，不应在翻译后的下一轮重新展开',async t=>{
  const f=await fixture(t,'<button type="button" role="combobox" aria-label="Time window" aria-haspopup="listbox" aria-expanded="false">This week</button>');
  const {w}=f;w.PointerEvent=w.MouseEvent;w.HTMLElement.prototype.getClientRects=()=>[{}];const timer=w.setTimeout.bind(w);w.setTimeout=(fn,ms,...args)=>timer(fn,ms===800?0:ms,...args);let opens=0;
  const trigger=w.document.querySelector('button');trigger.onclick=()=>{const old=w.document.querySelector('[role=listbox]');if(old){old.remove();trigger.setAttribute('aria-expanded','false');w.setTimeout(()=>trigger.removeAttribute('aria-controls'),20);return;}opens++;const menu=w.document.createElement('div');menu.id='base-ui-popup';menu.setAttribute('role','listbox');menu.textContent='This month';w.document.body.append(menu);trigger.setAttribute('aria-expanded','true');trigger.setAttribute('aria-controls',menu.id);};
  await f.request({type:'wt:collect',expand:true});f.translate();await wait(40);
  assert.equal(trigger.hasAttribute('aria-controls'),false);assert.equal((await f.request({type:'wt:collect',expand:true})).exploration.attempted,0);assert.equal(opens,1);
});

test('显示更多使用原文识别，展开的新内容可采集并保持展开，不点击收起或危险按钮',async t=>{
  const f=await fixture(t,'<section><ul><li>Initial row</li></ul><div><button type="button" id="more">Show more</button></div></section><form><button type="button">Show more</button></form><button type="button" disabled>Show more</button><button type="button" formaction="/submit">Show more</button><a href="/elsewhere">Show more</a><button type="button">View more</button><button type="button" id="delete">Delete all</button>');
  f.translate();const {w}=f;w.PointerEvent=w.MouseEvent;w.HTMLElement.prototype.getClientRects=()=>[{}];let clicks=0,wrong=0;
  for(const el of w.document.querySelectorAll('button,a'))el.onclick=()=>wrong++;
  const more=w.document.querySelector('#more');more.onclick=()=>{clicks++;w.document.querySelector('ul').insertAdjacentHTML('beforeend','<li>New expanded explanation</li><li><input value="private-input"><code>private-code</code></li>');more.textContent='Show less';};
  const scan=await f.request({type:'wt:collect',expand:true});assert.ok(scan.items.some(i=>i.sourceText==='New expanded explanation'));assert.ok(!JSON.stringify(scan).includes('private-'));
  assert.equal(clicks,1);assert.equal(wrong,0);assert.equal(more.textContent,'Show less');assert.equal(w.document.querySelectorAll('li').length,3);
  await f.request({type:'wt:collect',expand:true});assert.equal(clicks,1);assert.equal(wrong,0);
});

test('加载更多持续新增时按时间接续，不受入口数量限制且不重复请求无变化的按钮',async t=>{
  const f=await fixture(t,'<section><ul></ul><div><button type="button">加载更多</button></div></section>',{autoExpandSeconds:1});const {w}=f;
  w.PointerEvent=w.MouseEvent;w.HTMLElement.prototype.getClientRects=()=>[{}];let elapsed=0,clicks=0;w.Date.now=()=>elapsed;const timer=w.setTimeout.bind(w);
  w.setTimeout=(fn,ms,...args)=>timer(()=>{if(ms===100)elapsed+=100;fn(...args);},ms===100?0:ms);
  const more=w.document.querySelector('button');more.onclick=()=>{clicks++;w.document.querySelector('ul').insertAdjacentHTML('beforeend','<li>Loaded row '+clicks+'</li>');if(clicks===25)more.remove();};
  const first=await f.request({type:'wt:collect',expand:true});assert.equal(clicks,10);assert.equal(first.exploration.limited,true);
  const second=await f.request({type:'wt:collect',expand:true,autoExpandSeconds:12});assert.equal(clicks,25);assert.equal(second.items.filter(i=>i.sourceText.startsWith('Loaded row')).length,25);
  await f.request({type:'wt:collect',expand:true});assert.equal(clicks,25);
  const noop=w.document.createElement('button');noop.type='button';noop.textContent='Load more';noop.onclick=()=>clicks++;w.document.querySelector('section').append(noop);
  await f.request({type:'wt:collect',expand:true});assert.equal(clicks,26);
  await f.request({type:'wt:collect',expand:true});assert.equal(clicks,27);
  await f.request({type:'wt:collect',expand:true});assert.equal(clicks,27);
});
