/* GPL-3.0-or-later. Pure legacy conversion used by the runtime migration and backup importer. */
(() => {
  'use strict';
  const C = typeof module !== 'undefined' ? require('./managed-core.js') : globalThis.WTCore;
  const D = typeof module !== 'undefined' ? require('./dictionary-core.js') : C.dictionary;
  async function prepare(database, preferences, getDomain) {
    C.assert(database && database.schemaVersion === 1 && C.uuid(database.deviceId) && Number.isSafeInteger(database.seq) && database.seq >= 0 && Array.isArray(database.ops), '旧数据库结构无效');
    C.assert(Object.keys(database).every(k => ['schemaVersion', 'deviceId', 'seq', 'ops'].includes(k)) && D.bytes(database) <= 32 * 1024 * 1024, '旧数据库包含未知字段或超过迁移容量');
    for (const op of database.ops) { C.validateOp(op); D.origin(op.siteId); C.assert(op.deviceId !== database.deviceId || op.seq <= database.seq, '旧数据库序号落后于已保存记录'); }
    const legacy = C.materialize(database.ops), installations = [], groups = new Map();
    for (const site of Object.values(legacy.sites)) {
      const group = D.groupFor(site.origin, getDomain);
      installations.push({ origin: site.origin, name: site.name, group, enabled: site.enabled, excludedPaths: [...site.excludedPaths],
        deleted: site.deleted, generation: site.generation, builtinId: site.builtinId, builtinVersion: site.builtinVersion ?? null });
      for (const entry of Object.values(site.entries)) {
        const key = C.canonical([group, entry.targetLanguage]);
        if (!groups.has(key)) groups.set(key, { group, targetLanguage: entry.targetLanguage, baseline: Object.create(null), local: Object.create(null), conflicts: Object.create(null), baselineConfirmed: false });
        const layer = groups.get(key), row = { site: site.origin, entry: structuredClone(entry) }, id = D.entryIdentity(row);
        D.validateRecord(row, [site.origin], entry.targetLanguage); layer.local[id] = row;
        const conflicts = site.conflicts[C.entryKey(entry)];
        if (conflicts) layer.conflicts[id] = conflicts.map(candidate => {
          const { opId, ...value } = candidate; C.validEntry(value);
          return { opId, site: site.origin, entry: structuredClone(value) };
        });
      }
    }
    const safePreferences = D.syncPreferences(preferences);
    const sourceSha256 = await D.digest({ database, preferences: safePreferences });
    return { schemaVersion: 1, status: 'prepared', sourceSha256, backupSha256: await D.digest(database),
      installations: installations.sort((a, b) => a.origin.localeCompare(b.origin, 'en')),
      groups: [...groups.values()].sort((a, b) => C.canonical([a.group, a.targetLanguage]).localeCompare(C.canonical([b.group, b.targetLanguage]), 'en')),
      preferences: safePreferences, pendingOperationIds: legacy.pending,
      // Complete validated history preserves old generations, unresolved dependencies and rollback.
      backup: structuredClone(database), requiresLegacyBackupForRollback: true };
  }
  async function verifyPrepared(staged, database, preferences, getDomain) {
    const expected = await prepare(database, preferences, getDomain);
    C.assert(C.canonical(staged) === C.canonical(expected), '迁移暂存区或旧数据库已改变，不能切换'); return expected;
  }
  const api = Object.freeze({ prepare, verifyPrepared });
  if (typeof module !== 'undefined') module.exports = api;
  else C.dictionaryMigration = api;
})();
