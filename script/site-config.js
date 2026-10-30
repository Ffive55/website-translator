'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const SAFE_ATTRIBUTES = ['title', 'placeholder', 'aria-label', 'alt'];

function validateSite(site, directory = site.id) {
  const fail = message => { throw new Error(`网站 ${directory}: ${message}`); };
  if (!/^[a-z][a-z0-9-]*$/.test(site.id) || site.id !== directory) fail('id 必须与目录名一致，且仅使用小写字母、数字、连字符');
  if (typeof site.name !== 'string' || !site.name.trim()) fail('缺少 name');
  if (!['github', 'dictionary'].includes(site.engine)) fail('engine 必须是 github 或 dictionary');
  if ((site.engine === 'github') !== (site.id === 'github')) fail('github 引擎仅供 GitHub 适配器使用');
  if (!Array.isArray(site.matches) || !site.matches.length) fail('matches 不能为空');
  for (const match of site.matches) {
    if (typeof match !== 'string' || !/^https?:\/\/(?:\*\.)?[a-z0-9]+(?:[.-][a-z0-9]+)*\/\*$/.test(match)) {
      fail(`无效域名匹配 ${match}；使用 https://example.com/*，子域名可用 https://*.example.com/*`);
    }
  }
  if (site.enabled !== undefined && typeof site.enabled !== 'boolean') fail('enabled 必须是布尔值');
  if (site.caseInsensitive !== undefined && typeof site.caseInsensitive !== 'boolean') fail('caseInsensitive 必须是布尔值');
  function validateRules(block) {
    if (block.dictionary !== undefined) {
      if (!block.dictionary || Array.isArray(block.dictionary) || typeof block.dictionary !== 'object') fail('dictionary 必须是对象');
      for (const [source, target] of Object.entries(block.dictionary)) {
        if (!source.trim() || typeof target !== 'string' || !target.trim()) fail('词条原文和译文不能为空');
      }
    }
    if (block.selectors !== undefined && (!Array.isArray(block.selectors) || block.selectors.some(x => typeof x !== 'string' || !x.trim()))) fail('selectors 必须是非空 CSS 选择器字符串数组');
    if (block.ignore !== undefined && (!Array.isArray(block.ignore) || block.ignore.some(x => typeof x !== 'string' || !x.trim()))) fail('ignore 必须是 CSS 选择器字符串数组');
    if (block.ignoreText !== undefined && (!Array.isArray(block.ignoreText) || block.ignoreText.some(x => typeof x !== 'string' || !x.trim()))) fail('ignoreText 必须是 CSS 选择器字符串数组');
    if (block.regexp !== undefined && !Array.isArray(block.regexp)) fail('regexp 必须是数组');
    for (const rule of block.regexp || []) {
      if (typeof rule.pattern !== 'string' || typeof rule.replacement !== 'string' || !/^[iu]*$/.test(rule.flags || '')) fail('正则必须包含 pattern、replacement，flags 仅允许 i/u');
      try { new RegExp(rule.pattern, rule.flags || ''); } catch (error) { fail(`正则错误: ${error.message}`); }
    }
  }
  validateRules(site);
  if (site.attributes !== undefined && (!Array.isArray(site.attributes) || site.attributes.some(x => !SAFE_ATTRIBUTES.includes(x)))) fail('attributes 仅支持 title、placeholder、aria-label、alt');
  if (site.pages !== undefined && !Array.isArray(site.pages)) fail('pages 必须是数组');
  for (const page of site.pages || []) {
    if (typeof page.pathPrefix !== 'string' || !page.pathPrefix.startsWith('/')) fail('页面规则必须包含以 / 开头的 pathPrefix');
    if (page.exact !== undefined && typeof page.exact !== 'boolean') fail('exact 必须是布尔值');
    validateRules(page);
  }
  return site;
}

function loadSites(root = ROOT) {
  const directory = path.join(root, 'sites');
  const sites = fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => validateSite(JSON.parse(fs.readFileSync(path.join(directory, entry.name, 'site.json'), 'utf8')), entry.name))
    .sort((a, b) => a.id.localeCompare(b.id));
  const domains = [];
  for (const site of sites.filter(site => site.enabled !== false)) {
    for (const match of site.matches) {
      const [, scheme, host] = match.match(/^(https?):\/\/([^/]+)\//);
      const base = host.replace(/^\*\./, '');
      for (const previous of domains) {
        if (previous.id === site.id || previous.scheme !== scheme) continue;
        if (host === previous.host || base === previous.base ||
            (host.startsWith('*.') && previous.base.endsWith(`.${base}`)) ||
            (previous.host.startsWith('*.') && base.endsWith(`.${previous.base}`))) {
          throw new Error(`网站域名冲突: ${site.id} 与 ${previous.id} (${match})`);
        }
      }
      domains.push({ id: site.id, scheme, host, base });
    }
  }
  if (!sites.some(site => site.id === 'github' && site.enabled !== false)) throw new Error('必须保留 GitHub 适配器');
  return sites;
}

module.exports = { ROOT, validateSite, loadSites };
