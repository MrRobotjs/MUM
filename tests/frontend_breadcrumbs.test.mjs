import test from 'node:test';
import assert from 'node:assert/strict';
import {loadFrontend} from './frontendLoader.mjs';
test('shared breadcrumbs retain admin episode links and root pages',async()=>{
 const {generateBreadcrumbs:b}=await loadFrontend("export * from './src/components/layout/breadcrumbs';");
 assert.deepEqual(b('/home'),[{label:'Home',href:'/home'}]);
 assert.deepEqual(b('/account'),[{label:'Account',href:'/account'}]);
 assert.deepEqual(b('/admin/settings/general'),[{label:'Settings',href:'/admin/settings'},{label:'General',href:'/admin/settings/general'}]);
 assert.deepEqual(b('/admin/servers/3')[0],{label:'Media Servers',href:'/admin/servers'});
 assert.deepEqual(b('/admin/servers/3/libraries/9/1/episodes/2')[5],{label:'Episodes',href:'/admin/servers/3/libraries/9/1',search:{tab:'episodes'}});
});
