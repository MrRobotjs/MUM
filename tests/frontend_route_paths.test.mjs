import test from 'node:test';
import assert from 'node:assert/strict';
import {loadFrontend} from './frontendLoader.mjs';
test('canonical return paths and guard precedence', async()=>{
 const m=await loadFrontend("export * from './src/router/routePaths'; export {resolvePath} from '@tanstack/react-router';");
 for(const p of ['/x/..//evil.test/a','/x/%2e%2e//evil.test/a','/x/..//admin/users','//evil.test','https://evil.test','/\\evil.test','/ok\\bad','/ok\nbad','/%5c%5cevil.test','/%0a','/%zz','/login','/login/','/%6cogin','/a/../login?x=1','/login%2f','/account?x=%0a','/account#%5c','/login#x','/login?x=1',null,42,'/'+'x'.repeat(2048)]) assert.equal(m.safeNextPath(p),null,String(p));
 for(const p of ['/x/..//evil.test/a','/x/%2e%2e//evil.test/a','/x/..//admin/users']) assert.equal(m.postLoginPath(p,false),'/home');
 for(const p of ['/admin/../account?tab=profile#name','/account?next=https://example.test#ok','/home']) assert.equal(new URL(m.safeNextPath(p),'https://mum.invalid').origin,'https://mum.invalid');
 assert.equal(m.safeNextPath('/admin/../account?tab=profile#name'),'/account?tab=profile#name');
 assert.equal(m.safeNextPath('/account?next=https://example.test#ok'),'/account?next=https://example.test#ok');
 for(const p of ['/admin','/admin/users','/%61dmin/users','/x/../admin/users?x=1']) { assert.equal(m.isAdminPath(p),true,p);assert.equal(m.postLoginPath(p,false),'/home'); }
 for(const p of ['/administrator','/home?next=/admin','/account#/admin']) assert.equal(m.isAdminPath(p),false);
 assert.equal(m.resolvePath('/', '/login/'),'/login');
 assert.equal(m.postLoginPath('/admin/users',true),'/admin/users');assert.equal(m.postLoginPath(undefined,true),'/home');
 const base={loading:false,unauthorized:false,failed:false,signedIn:true,hasAdminAccess:false};
 for(const [state,require,want] of [[base,'signed-in','allow'],[base,'admin','home'],[{...base,hasAdminAccess:true},'admin','allow'],[{...base,loading:true,unauthorized:true},'admin','loading'],[{...base,unauthorized:true,failed:true},'admin','login'],[{...base,failed:true,signedIn:false},'admin','error'],[{...base,failed:true},'admin','error'],[{...base,signedIn:false},'admin','login']])assert.equal(m.guardDecision(state,require),want);
});





