'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const C=require('../extension/managed-core'),reference=require('./fixtures/materialize-reference.cjs');
const {fixture}=require('./fixtures/history.cjs');
function normalize(state){return {...state,applied:state.applied.slice().sort(),pending:state.pending.slice().sort(),sites:Object.fromEntries(Object.entries(state.sites).map(([id,s])=>[id,{...s,conflicts:Object.fromEntries(Object.entries(s.conflicts).map(([k,rows])=>[k,rows.slice().sort((a,b)=>a.opId.localeCompare(b.opId))]))}]))};}
test('区间因果图与旧算法在乱序、分支、并发人工和缺依赖记录上等价',()=>{
 for(let round=0;round<40;round++){const db=fixture(40),root=db.ops[0],extra=[];for(let i=0;i<12;i++){const deviceId=randomUUID();extra.push({...db.ops[5+i],deviceId,seq:1,opId:deviceId+'-1',deps:[root.opId],payload:{...db.ops[5+i].payload,origin:'manual',translation:'并发 '+i}});}const ops=[...db.ops,...extra];if(round%2)ops.reverse();if(round%3===0)ops.splice(ops.findIndex(o=>o.opId===db.ops[20].opId),1);assert.deepEqual(normalize(C.materialize(ops)),normalize(reference(ops)));}
});
test('一万条线性旧历史无二次方祖先集合，保留全部词条和删除语义',()=>{
 const db=fixture(10000),start=performance.now(),state=C.materialize(db.ops);assert.equal(Object.keys(Object.values(state.sites)[0].entries).length,10000);assert.equal(state.pending.length,0);assert.ok(performance.now()-start<5000,'一万条历史应在 5 秒内完成纯数据验证');
 const last=db.ops.at(-1);const deleted={...last,seq:db.seq+1,opId:db.deviceId+'-'+(db.seq+1),kind:'delete',payload:{},deps:[last.opId]};assert.equal(Object.values(C.materialize([...db.ops,deleted]).sites)[0].deleted,true);
});
module.exports={fixture};
