/* GPL-3.0-or-later. Shared only by extension scripts in the isolated world. */
(() => {
  'use strict';
  if (globalThis.WTText) return;
  const records = new WeakMap();
  const attributes = new WeakMap();
  function invalidate(mutations, ownWrite) {
    let consumed = false;
    for (const mutation of mutations) {
      if (mutation.type === 'attributes') {
        if (ownWrite?.attribute === mutation.attributeName && ownWrite.node === mutation.target && ownWrite.before === mutation.oldValue && !consumed) consumed = true;
        else attributes.get(mutation.target)?.delete(mutation.attributeName);
        continue;
      }
      if (mutation.type !== 'characterData') continue;
      // Only the mutation taken synchronously from our actual setter is owned.
      if (!consumed && ownWrite && mutation.target === ownWrite.node && mutation.oldValue === ownWrite.before) {
        consumed = true;
      } else records.delete(mutation.target);
    }
  }
  const observer = new MutationObserver(mutations => invalidate(mutations));
  observer.observe(document, { subtree: true, characterData: true, characterDataOldValue: true, attributes: true, attributeOldValue: true, attributeFilter: ['placeholder','aria-label','title','label'] });
  function readAttribute(node, attribute) {
    invalidate(observer.takeRecords());
    const record = attributes.get(node)?.get(attribute), value = node.getAttribute(attribute);
    if (record && value === record.output) return record;
    attributes.get(node)?.delete(attribute);
    return { source: value, output: value, owner: null };
  }
  function writeAttribute(node, attribute, output, owner) {
    const previous = readAttribute(node, attribute), before = node.getAttribute(attribute);
    if (!attributes.has(node)) attributes.set(node, new Map());
    if (output !== previous.source) attributes.get(node).set(attribute, {source:previous.source, output, owner});
    else attributes.get(node).delete(attribute);
    if (before === output) return;
    try { if (output === null) node.removeAttribute(attribute); else node.setAttribute(attribute, output); }
    finally { invalidate(observer.takeRecords(), {node, attribute, before}); }
  }
  function read(node) {
    // collect() can run before observer callbacks, including several site writes in one task.
    invalidate(observer.takeRecords());
    const record = records.get(node);
    if (record && node.data === record.output) return record;
    records.delete(node);
    return { source: node.data, output: node.data, owner: null };
  }
  function writeText(node, output, owner) {
    const previous = read(node), before = node.data;
    if(owner==='builtin' && previous.owner==='managed-selected')return;
    if (output !== previous.source) records.set(node, { source: previous.source, output, owner });
    else records.delete(node);
    if (before === output) return;
    try { node.data = output; }
    finally { invalidate(observer.takeRecords(), { node, before }); }
  }
  function content(node) {
    if (node.nodeType === Node.TEXT_NODE) return read(node).source;
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    let source = '';
    while (walker.nextNode()) source += read(walker.currentNode).source;
    return source;
  }
  function writeContent(node, output, owner) {
    if(owner==='builtin' && hasSelected(node))return;
    if (node.nodeType === Node.TEXT_NODE) { writeText(node, output, owner); return; }
    const source = content(node);
    // Preserve existing descendants when a selector is revisited with the same output.
    if (node.textContent === output) return;
    node.textContent = output;
    invalidate(observer.takeRecords());
    const text = node.firstChild;
    if (text?.nodeType === Node.TEXT_NODE && text.data === output && output !== source) records.set(text, { source, output, owner });
  }
  function hasSelected(node) {
      if(node.nodeType===Node.TEXT_NODE)return read(node).owner==='managed-selected';
      const walker=document.createTreeWalker(node,NodeFilter.SHOW_TEXT);
      while(walker.nextNode())if(read(walker.currentNode).owner==='managed-selected')return true;
      return false;
    }
  globalThis.WTText = Object.freeze({
    hasSelected,
    source: node => read(node).source,
    owner: node => read(node).owner,
    content, writeText, writeContent,
    sourceAttribute: (node, attribute) => readAttribute(node, attribute).source,
    attributeOwner: (node, attribute) => readAttribute(node, attribute).owner,
    writeAttribute,
    restoreAttribute(node, attribute, owner) { const r=readAttribute(node,attribute); if(r.owner===owner) writeAttribute(node,attribute,r.source,owner); },
    restore(node, owner) { const record = read(node); if (record.owner === owner) writeText(node, record.source, owner); }
  });
})();
