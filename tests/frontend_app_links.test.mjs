import test from 'node:test';
import assert from 'node:assert/strict';
import {loadFrontend} from './frontendLoader.mjs';

test('shared destinations retain route parameters and profile context', async () => {
 const {appLinks}=await loadFrontend("export {appLinks} from './src/router/appLinks';");
 assert.deepEqual(appLinks.server('plex/plex++'),{to:'/admin/servers/$serverType/$serverId',params:{serverType:'plex',serverId:'plex++'}});
 assert.deepEqual(appLinks.serverUser('plex/plex++','Jane Doe'),{to:'/admin/servers/$serverType/$serverId/users/$username',params:{serverType:'plex',serverId:'plex++',username:'Jane Doe'}});
 assert.deepEqual(appLinks.user('user-uuid'),{to:'/admin/users/$uuid',params:{uuid:'user-uuid'}});
 assert.deepEqual(appLinks.library('plex/plex++',12),{to:'/admin/servers/$serverType/$serverId/libraries/$libraryId',params:{serverType:'plex',serverId:'plex++',libraryId:'12'}});
 assert.deepEqual(appLinks.media('plex/plex++',12,5),{to:'/admin/servers/$serverType/$serverId/libraries/$libraryId/$mediaId',params:{serverType:'plex',serverId:'plex++',libraryId:'12',mediaId:'5'}});
 assert.deepEqual(appLinks.episode('plex/plex++',12,5,3),{to:'/admin/servers/$serverType/$serverId/libraries/$libraryId/$mediaId/episodes/$episodeId',params:{serverType:'plex',serverId:'plex++',libraryId:'12',mediaId:'5',episodeId:'3'}});
});

test('central destinations preserve profile URLs and sidebar paths', async () => {
 const m=await loadFrontend("export {buildUserProfilePath, serverRoutePath, appPaths, LOGIN_PATH, HOME_PATH, ACCOUNT_PATH} from './src/router/appLinks';");
 assert.equal(m.buildUserProfilePath({uuid:'abc',username:'  A B  ',server_nickname:'Plex++'}),'/admin/users/abc');
 assert.equal(m.buildUserProfilePath({uuid:'abc',username:' ',server_nickname:'Plex++'}),'/admin/users/abc');
 assert.equal(m.serverRoutePath(m.appPaths.serverUsers,'plex/plex++'),'/admin/servers/plex/plex++/users');
 assert.deepEqual([m.LOGIN_PATH,m.HOME_PATH,m.ACCOUNT_PATH],['/login','/home','/account']);
});
