import test from 'node:test';
import assert from 'node:assert/strict';
import {loadFrontend} from './frontendLoader.mjs';

test('shared destinations retain route parameters and profile context', async () => {
 const {appLinks}=await loadFrontend("export {appLinks} from './src/router/appLinks';");
 assert.deepEqual(appLinks.server('plex++'),{to:'/admin/servers/$serverId',params:{serverId:'plex++'}});
 assert.deepEqual(appLinks.serverUser('plex++','user-uuid'),{to:'/admin/servers/$serverId/users/$uuid',params:{serverId:'plex++',uuid:'user-uuid'}});
 assert.deepEqual(appLinks.user('user-uuid'),{to:'/admin/users/$uuid',params:{uuid:'user-uuid'}});
 assert.deepEqual(appLinks.library('plex++',12),{to:'/admin/servers/$serverId/libraries/$libraryId',params:{serverId:'plex++',libraryId:'12'}});
 assert.deepEqual(appLinks.media('plex++',12,5),{to:'/admin/servers/$serverId/libraries/$libraryId/$mediaId',params:{serverId:'plex++',libraryId:'12',mediaId:'5'}});
 assert.deepEqual(appLinks.episode('plex++',12,5,3),{to:'/admin/servers/$serverId/libraries/$libraryId/$mediaId/episodes/$episodeId',params:{serverId:'plex++',libraryId:'12',mediaId:'5',episodeId:'3'}});
});

test('central destinations preserve profile URLs and sidebar paths', async () => {
 const m=await loadFrontend("export {buildUserProfilePath, serverRoutePath, appPaths, LOGIN_PATH, HOME_PATH, ACCOUNT_PATH} from './src/router/appLinks';");
 assert.equal(m.buildUserProfilePath({uuid:'abc',username:'  A B  ',server_nickname:'Plex++'}),'/admin/users/Plex++/A%20B');
 assert.equal(m.buildUserProfilePath({uuid:'abc',username:' ',server_nickname:'Plex++'}),'/admin/users/abc');
 assert.equal(m.serverRoutePath(m.appPaths.serverUsers,'plex++'),'/admin/servers/plex++/users');
 assert.deepEqual([m.LOGIN_PATH,m.HOME_PATH,m.ACCOUNT_PATH],['/login','/home','/account']);
});
