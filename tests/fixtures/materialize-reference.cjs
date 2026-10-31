/* GPL-3.0-or-later. v0.3.14 algorithm for small differential fixtures only. */
const C=require('../../extension/managed-core');const {validateOp,canonical,assert,entryKey}=C;
  function materialize(operations) {
    const all = new Map();
    for (const op of operations) { validateOp(op); const old = all.get(op.opId); assert(!old || canonical(old) === canonical(op), 'opId 内容冲突'); all.set(op.opId, op); }
    const applied = new Map(), pending = new Map(all), ancestors = new Map();
    while (pending.size) {
      let progress = false;
      for (const [id, op] of pending) if (op.deps.every(d => applied.has(d))) {
        const set = new Set(op.deps); op.deps.forEach(d => ancestors.get(d).forEach(a => set.add(a)));
        const history = [...set].map(id => applied.get(id));
        if (op.kind === 'create' && op.generation > 1) assert(history.some(a => a.siteId === op.siteId && a.generation === op.generation - 1 && a.kind === 'delete'), '重新添加缺少前代删除依赖');
        if (op.kind !== 'create') assert(history.some(a => a.siteId === op.siteId && a.generation === op.generation && a.kind === 'create'), '变更缺少网站创建依赖');
        ancestors.set(id, set); applied.set(id, op); pending.delete(id); progress = true;
      }
      if (!progress) break;
    }
    const latest = rows => rows.filter(a => !rows.some(b => ancestors.get(b.opId).has(a.opId)));
    const choose = rows => latest(rows).sort((a,b) => a.opId.localeCompare(b.opId)).at(-1);
    const sites = {};
    for (const op of applied.values()) {
      if (op.kind !== 'create') continue;
      const existing = sites[op.siteId];
      if (!existing || existing.generation < op.generation) sites[op.siteId] = { ...op.payload, id: op.siteId, generation: op.generation, enabled: true, targetLanguage: 'zh-Hans', excludedPaths: [], entries: {}, conflicts: {} };
    }
    for (const site of Object.values(sites)) {
      const rows = [...applied.values()].filter(o => o.siteId === site.id && o.generation === site.generation);
      Object.assign(site, choose(rows.filter(o => o.kind === 'create')).payload);
      site.deleted = rows.some(o => o.kind === 'delete');
      for (const key of ['enabled','targetLanguage','excludedPaths']) {
        const winner = choose(rows.filter(o => o.kind === 'setting' && o.payload.key === key));
        if (winner) site[key] = winner.payload.value;
      }
      const groups = new Map();
      for (const o of rows.filter(o => o.kind === 'entry')) { const k = entryKey(o.payload); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(o); }
      for (const [key, values] of groups) {
        const manual = values.filter(o => o.payload.origin === 'manual' || o.payload.userSelected===true);
        const candidates = latest(manual.length ? manual : values);
        site.entries[key] = choose(candidates).payload;
        if (candidates.length > 1) site.conflicts[key] = candidates.map(o => ({ opId: o.opId, ...o.payload }));
      }
    }
    return { sites, pending: [...pending.keys()], applied: [...applied.keys()] };
  }

module.exports=materialize;
