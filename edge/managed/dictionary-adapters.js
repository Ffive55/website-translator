/* GPL-3.0-or-later. Hydrate validated data with local, fixed handlers only. */
(() => {
  'use strict';
  const C = typeof module !== 'undefined' ? require('./managed-core.js') : globalThis.WTCore;
  const D = typeof module !== 'undefined' ? require('./dictionary-core.js') : C.dictionary;
  function hydrate(pack, options, bindHandlers) {
    D.validatePackage(pack, options);
    C.assert(pack.adapter, '该数据包没有专用适配器');
    const graph = pack.adapter;
    const objects = graph.nodes.map(n => n.type === 'array' ? [] : Object.create(null));
    const root = objects[graph.root.ref];
    const handlers = bindHandlers ? bindHandlers(root) : Object.create(null);
    const value = token => {
      if (token === null || typeof token !== 'object') return token;
      if (Object.hasOwn(token, 'ref')) return objects[token.ref];
      if (Object.hasOwn(token, 'handler')) { C.assert(Object.hasOwn(handlers, token.handler), '本地处理器缺失'); return handlers[token.handler]; }
      const rule = options.policy.regexps[token.regexp.id];
      return new RegExp(rule.source, rule.flags);
    };
    graph.nodes.forEach((node, i) => {
      if (node.type === 'array') for (const item of node.values) objects[i].push(value(item));
      else for (const [key, token] of node.values) objects[i][key] = value(token);
    });
    return root;
  }
  const api = Object.freeze({ hydrate });
  if (typeof module !== 'undefined') module.exports = api;
  else C.dictionaryAdapters = api;
})();
