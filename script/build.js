#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { buildSites } = require('./build-sites');
const { buildChangelog } = require('./build-changelog');
const normalize = value => value.replace(/\r\n/g, '\n');

const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'chrome', 'src');
const selectedBrowser=process.argv.includes('--browser')?process.argv[process.argv.indexOf('--browser')+1]:null;
if(selectedBrowser && !['chrome','edge','firefox'].includes(selectedBrowser))throw new Error('Unknown browser');
const BROWSERS=selectedBrowser?[selectedBrowser]:['chrome','edge','firefox'];
const TARGETS = [
  path.join(ROOT, 'chrome', 'content.js'),
  path.join(ROOT, 'edge', 'content.js'),
  path.join(ROOT, 'firefox', 'content.js')
].filter(target=>!selectedBrowser || path.basename(path.dirname(target))===selectedBrowser);

const MODULES = [
  'core/constants.js',
  'core/text-filter.js',
  'core/dom-observer.js',
  'features/ui-localization.js',
  'entry.js'
];

function assemble() {
  const parts = [];
  parts.push("(function (window, document, undefined) {\n    'use strict';\n\n");

  for (const rel of MODULES) {
    const modPath = path.join(SRC_DIR, rel);
    if (!fs.existsSync(modPath)) {
      throw new Error(`Module file not found: ${modPath}`);
    }
    let code = normalize(fs.readFileSync(modPath, 'utf8'));
    // Strip module header docblock if present
    code = code.replace(/^\/\*\*[\s\S]*?\*\/\n\n?/, '').trimEnd();

    parts.push(`    // ==========================================================================\n    // [Module] ${rel}\n    // ==========================================================================\n\n`);
    parts.push(code + '\n\n');
  }

  parts.push('})(window, document);\n');
  return parts.join('');
}

function main() {
  const args = process.argv.slice(2);
  const isCheckMode = args.includes('--check');

  console.log(`[build] Assembling ${MODULES.length} modules from chrome/src/...`);
  const output = assemble();

  // Syntax validation
  try {
    new vm.Script(output, { filename: 'chrome/content.js' });
  } catch (err) {
    console.error('[build] Syntax validation failed:', err.message);
    process.exit(1);
  }

  const lineCount = output.split('\n').length;
  const byteCount = Buffer.byteLength(output, 'utf8');

  if (isCheckMode) {
    let hasMismatch = false;
    for (const target of TARGETS) {
      const rel = path.relative(ROOT, target);
      if (!fs.existsSync(target)) {
        console.error(`[build --check] Missing target file: ${rel}`);
        hasMismatch = true;
        continue;
      }
      const existing = normalize(fs.readFileSync(target, 'utf8'));
      if (existing !== output) {
        console.error(`[build --check] Target ${rel} is out of sync with chrome/src/`);
        hasMismatch = true;
      }
    }
    if (hasMismatch) {
      console.error('[build --check] FAILED: Run "node script/build.js" to recompile and sync targets.');
      process.exit(1);
    }
    console.log(`[build --check] OK: All ${TARGETS.length} browser builds are in sync with chrome/src/ (${lineCount} lines, ${(byteCount / 1024).toFixed(1)} KB).`);
    buildSites(true,BROWSERS);
    buildChangelog(true,BROWSERS);
    return;
  }

  // Write mode
  for (const target of TARGETS) {
    const rel = path.relative(ROOT, target);
    if(!fs.existsSync(target) || normalize(fs.readFileSync(target,'utf8'))!==output) {
      for(let attempt=0;;attempt++)try{fs.writeFileSync(target,output,'utf8');break;}catch(error){
        if(attempt>=5 || !['EBUSY','EPERM','UNKNOWN'].includes(error.code))throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);
      }
    }
    console.log(`[build] Synchronized -> ${rel}`);
  }

  console.log(`[build] Done: Compiled ${MODULES.length} modules into ${lineCount} lines (${(byteCount / 1024).toFixed(1)} KB).`);
  buildSites(false,BROWSERS);
  buildChangelog(false,BROWSERS);
}

main();
