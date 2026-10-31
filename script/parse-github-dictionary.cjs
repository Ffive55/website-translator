'use strict';
// Parse the legacy dictionary as data. Never evaluate upstream JavaScript.
const acorn = require('acorn');
const crypto = require('node:crypto');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);

function parseDictionary(source) {
  if (Buffer.byteLength(source) > 12 * 1024 * 1024) throw new Error('旧词库超过 12 MiB');
  const ast = acorn.parse(source, { ecmaVersion: 2022, locations: true });
  let root;
  const handlers = new Map(), regexps = new Map(), assignments = [];
  const fail = node => { throw new Error(`词库第 ${node.loc.start.line} 行含未支持的数据语法 ${node.type}；未执行源文件`); };
  const property = node => {
    const key = node.computed ? value(node.property) : node.property.name;
    if (typeof key !== 'string' || forbidden.has(key)) fail(node);
    return key;
  };
  function reference(node) {
    if (node.type === 'Identifier' && node.name === 'I18N' && root) return root;
    if (node.type === 'MemberExpression') {
      const object = reference(node.object), key = property(node);
      if (!object || !Object.hasOwn(object, key)) fail(node);
      return object[key];
    }
    return fail(node);
  }
  function value(node) {
    if (node.type === 'Literal') {
      if (node.regex) {
        const { pattern: source, flags } = node.regex;
        const id = 'r-' + digest(source + '\0' + flags);
        const token = Object.freeze({ $regexp: id });
        if (!regexps.has(id)) regexps.set(id, { id, source, flags });
        return token;
      }
      if (node.value === null || ['string', 'boolean', 'number'].includes(typeof node.value)) return node.value;
    }
    if (node.type === 'ObjectExpression') {
      const result = Object.create(null);
      for (const p of node.properties) {
        if (p.type === 'SpreadElement') {
          const object = value(p.argument);
          if (!object || Array.isArray(object) || typeof object !== 'object') fail(p);
          Object.assign(result, object);
        } else {
          if (p.type !== 'Property' || p.kind !== 'init' || p.method || p.computed) fail(p);
          const key = p.key.type === 'Identifier' ? p.key.name : p.key.value;
          if (typeof key !== 'string' || forbidden.has(key)) fail(p);
          result[key] = value(p.value);
        }
      }
      return result;
    }
    if (node.type === 'ArrayExpression') {
      const result = [];
      for (const item of node.elements) {
        if (!item) fail(node);
        if (item.type === 'SpreadElement') {
          const array = value(item.argument);
          if (!Array.isArray(array)) fail(item);
          result.push(...array);
        } else result.push(value(item));
      }
      return result;
    }
    if (['FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)) {
      const code = source.slice(node.start, node.end).replace(/\r\n/g, '\n');
      const id = 'h-' + digest(code);
      if (!handlers.has(id)) handlers.set(id, { id, code, line: node.loc.start.line });
      return Object.freeze({ $handler: id });
    }
    if (node.type === 'MemberExpression') return reference(node);
    return fail(node);
  }
  for (const statement of ast.body) {
    if (statement.type === 'VariableDeclaration' && statement.declarations.length === 1) {
      const d = statement.declarations[0];
      if (root || d.id.name !== 'I18N' || d.init?.type !== 'ObjectExpression' || d.init.properties.length) fail(statement);
      root = value(d.init);
    } else if (statement.type === 'ExpressionStatement' && statement.expression.type === 'AssignmentExpression') {
      const e = statement.expression;
      if (e.operator !== '=' || e.left.type !== 'MemberExpression') fail(e);
      const target = reference(e.left.object), key = property(e.left);
      if (!target || typeof target !== 'object' || Array.isArray(target)) fail(e);
      target[key] = value(e.right);
      assignments.push({ line: statement.loc.start.line, key });
    } else fail(statement);
  }
  if (!root?.conf || !root['zh-CN']) throw new Error('旧词库缺少 conf 或 zh-CN');
  return { data: root, handlers: [...handlers.values()], regexps: [...regexps.values()], assignments, sourceSha256: digest(source.replace(/\r\n/g, '\n')) };
}

module.exports = { parseDictionary, digest };
