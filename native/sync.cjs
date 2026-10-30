'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const C = require('../extension/managed-core');
const digest = data => createHash('sha256').update(C.canonical(data)).digest('hex');
const envelope = data => ({ schemaVersion: 1, checksum: digest(data), data });
const bytes = data => Buffer.byteLength(C.canonical(data), 'utf8');
function verify(value) { C.assert(value?.schemaVersion === 1 && Object.keys(value).sort().join(',') === 'checksum,data,schemaVersion' && value.checksum === digest(value.data), '文件校验失败'); return value.data; }
async function safeDirectory(directory, {create=false}={}) {
  const root = path.resolve(directory || path.join(os.homedir(), 'OneDrive', '文档', 'website-translator'));
  C.assert(/^[a-zA-Z0-9_-]+$/.test(path.basename(root)), '同步根目录名称仅允许英文、数字、连字符和下划线');
  if(create){
    if(!directory){const oneDrive=await fs.lstat(path.join(os.homedir(),'OneDrive')).catch(()=>null);C.assert(oneDrive?.isDirectory() && !oneDrive.isSymbolicLink(),'未找到本机 OneDrive 根目录，请先配置 OneDrive 客户端，或填写已有 OneDrive 的实际路径');}
    await fs.mkdir(root,{recursive:true});
  }
  const stat = await fs.lstat(root).catch(() => null);
  C.assert(stat?.isDirectory() && !stat.isSymbolicLink(), '同步目录不存在或不是普通目录，请先创建并确认 OneDrive 路径');
  for (const name of ['changes','snapshots','backups','acks']) {
    const target = path.join(root,name); await fs.mkdir(target, { recursive:true });
    C.assert(!(await fs.lstat(target)).isSymbolicLink(), '同步子目录不能是链接');
  }
  return root;
}
async function read(file, limit = 900000) {
  const stat = await fs.lstat(file);
  C.assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= limit, '同步文件类型或大小无效');
  return verify(JSON.parse(await fs.readFile(file,'utf8')));
}
async function confirmDirectory(directory) {
  const root=await safeDirectory(directory,{create:true}),probe=path.join(root,`check-${randomUUID()}.tmp`);
  let created=false;
  try {
    const handle=await fs.open(probe,'wx');created=true;
    try {await handle.writeFile('website-translator-directory-check');await handle.sync();}finally{await handle.close();}
    C.assert(await fs.readFile(probe,'utf8')==='website-translator-directory-check','目录读写校验失败');
    return {directory:await fs.realpath(root),writable:true};
  } finally {if(created)await fs.unlink(probe);}
}
async function immutable(file, data) {
  const bytes = C.canonical(envelope(data));
  // Exclusive temp file and hard-link publication: the final filename can never be overwritten.
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temp, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await read(temp, 8000000);
    try { await fs.link(temp,file); } catch(e) { if(e.code !== 'EEXIST') throw e; C.assert(C.canonical(await read(file,8000000)) === C.canonical(data), '不可变文件冲突'); }
  } finally { await fs.unlink(temp).catch(()=>{}); }
}
async function exchange({directory,deviceId,ops}) {
  C.assert(C.uuid(deviceId) && Array.isArray(ops) && ops.length <= 10000, '同步请求无效或超过本版本上限');
  C.materialize(ops);
  const root = await safeDirectory(directory);
  for (const op of ops) await immutable(path.join(root,'changes',`${op.opId}.json`),op);
  const merged = new Map(); let invalid = 0;
  const add = op => { C.validateOp(op); const old = merged.get(op.opId); C.assert(!old || C.canonical(old) === C.canonical(op), 'opId 冲突'); merged.set(op.opId,op); };
  const snapshots = await fs.readdir(path.join(root,'snapshots'));
  C.assert(snapshots.length <= 10000, '快照数量超过本版本上限');
  for (const name of snapshots.filter(n=>n.endsWith('.json'))) {
    try {
      const snapshot=await read(path.join(root,'snapshots',name),8000000);
      C.assert(snapshot.schemaVersion===1 && C.uuid(snapshot.deviceId) && Object.keys(snapshot).sort().join(',')==='deviceId,included,ops,schemaVersion' && Array.isArray(snapshot.ops) && snapshot.ops.length<=10000 && Array.isArray(snapshot.included),'快照无效');
      const state=C.materialize(snapshot.ops);
      C.assert(!state.pending.length && C.canonical(state.applied.sort())===C.canonical(snapshot.included.slice().sort()),'快照依赖或包含范围无效');
      snapshot.ops.forEach(add);
    } catch (error) { if (error.message === 'opId 冲突') throw error; invalid++; }
  }
  const names = await fs.readdir(path.join(root,'changes'));
  C.assert(names.length <= 20000, '同步目录超过本版本文件上限');
  for (const name of names.filter(n=>n.endsWith('.json'))) {
    try {
      const op = C.validateOp(await read(path.join(root,'changes',name),90000));
      add(op);
    } catch (error) { if (error.message === 'opId 冲突') throw error; invalid++; }
  }
  const all = [...merged.values()];
  C.assert(all.length <= 10000 && bytes({ok:true,result:{ops:all,invalid,directory:root}}) < 850000, '同步记录超过当前单次 UTF-8 字节或数量上限，未丢弃本机词库');
  const state = C.materialize(all);
  const snapshot = { schemaVersion:1, deviceId, included:state.applied.sort(), ops:all.filter(o=>state.applied.includes(o.opId)) };
  if (bytes(envelope(snapshot)) <= 8000000) {
    const name = `${deviceId}-${digest(snapshot)}.json`;
    await immutable(path.join(root,'snapshots',name),snapshot);
    await immutable(path.join(root,'backups',name),snapshot);
  }
  // Native Messaging limits host replies to 1 MiB. Refuse rather than silently truncate.
  return { ops:all, invalid, pending:state.pending.length, directory:root };
}
async function acknowledge({directory,deviceId,applied}) {
  validateAck({schemaVersion:1,deviceId,applied});
  const root = await safeDirectory(directory), data = { schemaVersion:1, deviceId, applied:[...new Set(applied)].sort() };
  await immutable(path.join(root,'acks',`${deviceId}-${digest(data)}.json`),data);
  let peerConfirmed = false;
  const files = await fs.readdir(path.join(root,'acks'));
  C.assert(files.length <= 20000, '确认记录超过本版本文件上限');
  for (const name of files.filter(n=>n.endsWith('.json'))) {
    try { const ack = validateAck(await read(path.join(root,'acks',name))); if(ack.deviceId !== deviceId && applied.length && applied.every(id=>ack.applied.includes(id))) peerConfirmed=true; } catch { /* Incomplete peer confirmation is not confirmation. */ }
  }
  return { peerConfirmed };
}
function validateAck(ack) {
  C.assert(ack && ack.schemaVersion === 1 && C.uuid(ack.deviceId) && Object.keys(ack).sort().join(',') === 'applied,deviceId,schemaVersion' && Array.isArray(ack.applied) && ack.applied.length <= 10000 && new Set(ack.applied).size === ack.applied.length && ack.applied.every(C.opId), '确认记录无效');
  return ack;
}
module.exports = { digest, envelope, verify, read, immutable, safeDirectory, confirmDirectory, exchange, acknowledge, validateAck };
