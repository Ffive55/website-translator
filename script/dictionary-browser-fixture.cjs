'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
async function readFiles(root){
 const files={},index=JSON.parse(await fs.readFile(path.join(root,'dictionaries/index.json'),'utf8'));files['dictionaries/index.json']=JSON.stringify(index);
 for(const group of index.groups){files[group.manifest.path]=await fs.readFile(path.join(root,group.manifest.path),'utf8');const manifest=JSON.parse(files[group.manifest.path]);for(const data of Object.values(manifest.languages))for(const file of data.files)files[file.path]=await fs.readFile(path.join(root,file.path),'utf8');}return files;
}
function readOnlyMock(files){return `const actualFetch=globalThis.fetch.bind(globalThis);const dictionaryFiles=${JSON.stringify(files)};globalThis.fetch=async(url,options)=>{if(!String(url).startsWith('https://api.github.com/'))return actualFetch(url,options);const u=new URL(url);if(u.pathname.includes('/git/ref/'))return new Response(JSON.stringify({ref:'refs/heads/main',object:{sha:'a'.repeat(40),type:'commit'}}));const name=decodeURIComponent(u.pathname.split('/contents/')[1]||'');return new Response(dictionaryFiles[name]||'{}',{status:dictionaryFiles[name]?200:404});};\n`;}
module.exports={readFiles,readOnlyMock};
