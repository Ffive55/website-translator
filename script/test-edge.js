'use strict';
const {spawnSync}=require('node:child_process'),path=require('node:path');
for(const args of [['script/build-dictionaries.cjs','--check'],['script/build.js','--browser','edge','--check'],['chrome/tests/upstream-regressions.test.mjs'],['script/test-upstream-sync.js'],['--test','tests/*.test.cjs']]){
  const r=spawnSync(process.execPath,args,{cwd:path.resolve(__dirname,'..'),env:{...process.env,WT_BROWSER:'edge'},stdio:'inherit',windowsHide:true});
  if(r.error)throw r.error;if(r.status!==0)process.exit(r.status || 1);
}
