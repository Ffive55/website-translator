'use strict';const {randomUUID}=require('node:crypto');
function fixture(count=100){const deviceId=randomUUID(),siteId='https://history.example.com';const create={schemaVersion:1,deviceId,seq:1,opId:deviceId+'-1',deps:[],siteId,generation:1,kind:'create',payload:{origin:siteId,name:'History',group:'example.com',builtinId:null}};const ops=[create];for(let i=0;i<count;i++)ops.push({...create,seq:i+2,opId:deviceId+'-'+(i+2),deps:[ops.at(-1).opId],kind:'entry',payload:{sourceText:'Label '+i,context:'main/button/text',path:'/',sourceLanguage:null,targetLanguage:'zh-Hans',category:'ui',action:'translate',translation:'译文 '+i,origin:'ai'}});return {schemaVersion:1,deviceId,seq:count+1,ops};}

module.exports={fixture};
