import assert from 'node:assert/strict';
import test from 'node:test';
import {loadFrontend} from './frontendLoader.mjs';
const service=(tested)=>({id:'jellyfin',name:'Jellyfin',description:'Movies',tested_version:tested,enabled:true,server_count:1,capabilities:[],features:[]});
test('the tested server version is read when it looks like a version, otherwise left out',async()=>{
 const oldFetch=globalThis.fetch,oldWindow=globalThis.window;
 try{
  globalThis.window={location:{origin:'http://mum.test'}};
  const api=await loadFrontend("export * from './src/cache/mediaServicesCache';export {setAccessToken} from './src/store/authStore';");
  api.setAccessToken('session');
  for(const [tested,want] of [['12.4.0','12.4.0'],['1.43.5','1.43.5'],['',null],[undefined,null],['<b>1</b>',null],[5,null]]){
   globalThis.fetch=async()=>Response.json({data:[service(tested)]});
   const [jellyfin]=await api.fetchMediaServices('/api/providers');
   assert.equal(jellyfin.testedVersion,want,String(tested));
  }
 }finally{globalThis.fetch=oldFetch;globalThis.window=oldWindow}
});
