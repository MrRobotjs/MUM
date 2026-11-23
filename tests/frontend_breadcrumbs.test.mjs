import test from 'node:test';
import assert from 'node:assert/strict';
import {loadFrontend} from './frontendLoader.mjs';
test('shared breadcrumbs retain admin episode links and root pages',async()=>{
 const {generateBreadcrumbs:b}=await loadFrontend("export * from './src/components/layout/breadcrumbs';");
 assert.deepEqual(b('/home'),[{label:'Home',href:'/home'}]);
 assert.deepEqual(b('/account'),[{label:'Account',href:'/account'}]);
 assert.deepEqual(b('/admin/settings/general'),[{label:'Settings',href:'/admin/settings'},{label:'General',href:'/admin/settings/general'}]);
 assert.deepEqual(b('/admin/servers/plex/3')[0],{label:'Media Servers',href:'/admin/servers'});
 assert.deepEqual(b('/admin/servers/plex/3/libraries/9/1/episodes/2')[6],{label:'Episodes',href:'/admin/servers/plex/3/libraries/9/1',search:{tab:'episodes'}});
 const user=b('/admin/servers/plex/plex++/users/11111111-1111-4111-8111-111111111111');
 assert.equal(user[1].href,'/admin/servers');
 assert.deepEqual(user[3],{label:'Users',href:'/admin/servers/plex/plex++/users'});
});
