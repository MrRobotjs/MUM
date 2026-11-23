import test from 'node:test';
import assert from 'node:assert/strict';
import {loadFrontend} from './frontendLoader.mjs';

test('server URL nicknames allow plus and detect invalid names', async () => {
 const m=await loadFrontend("export {serverNicknameSlug,serverNicknameIssue,findServerBySlug,serverSettingsSlug,findServerBySettingsSlug,serverProfileMatches} from './src/lib/serverNickname';");
 assert.equal(m.serverNicknameSlug(' Hello  World '),'hello-world');
 assert.equal(m.serverNicknameSlug('Plex++'),'plex++');
 assert.equal(m.serverNicknameSlug('hello-world'),m.serverNicknameSlug('hello world'));
 assert.equal(m.serverNicknameIssue('Plex++'),'');
 for(const name of ['a/b','a?b','+++','a%b']) assert.notEqual(m.serverNicknameIssue(name),'');
 const servers=[{id:5,server_nickname:'Plex++'},{id:7,server_nickname:'42'}];
 assert.equal(m.findServerBySlug(servers,'plex++').id,5);
 assert.equal(m.findServerBySlug(servers,'42').id,7);
 assert.equal(m.findServerBySlug([{server_nickname:'hello world'},{server_nickname:'hello-world'}],'hello-world'),undefined);
 const conflicts=[{id:1,server_nickname:'hello world'},{id:2,server_nickname:'hello-world'},{id:3,server_nickname:'Legacy/name'}];
 assert.equal(m.serverSettingsSlug(conflicts,conflicts[1]),'~2');
 assert.equal(m.findServerBySettingsSlug(conflicts,'~2').id,2);
 assert.equal(m.findServerBySettingsSlug(conflicts,m.serverSettingsSlug(conflicts,conflicts[2])).id,3);
 assert.equal(m.serverProfileMatches({id:5},{user_type:'service',server_id:5}),true);
 assert.equal(m.serverProfileMatches({id:5},{user_type:'service',server_id:7}),false);
 assert.equal(m.serverProfileMatches({id:5},{user_type:'local',server_id:null}),false);
 assert.equal(m.serverProfileMatches(undefined,{user_type:'service',server_id:5}),false);
});

test('provider and nickname jointly select exactly one server', async () => {
 const {findServerByTypeSlug}=await loadFrontend("export {findServerByTypeSlug} from './src/lib/serverNickname';");
 const servers=[{id:1,service_type:'plex',server_nickname:'Media Server'},{id:2,service_type:'jellyfin',server_nickname:'media-server'}];
 assert.equal(findServerByTypeSlug(servers,'plex','media-server')?.id,1);
 assert.equal(findServerByTypeSlug(servers,'jellyfin','media-server')?.id,2);
 assert.equal(findServerByTypeSlug(servers,'emby','media-server'),undefined);
 assert.equal(findServerByTypeSlug([...servers,{id:3,service_type:'plex',server_nickname:'Media-Server'}],'plex','media-server'),undefined);
});

test('server route resolver scopes duplicate nicknames and settings to provider', async () => {
 globalThis.__serverRoutes={servers:[{id:1,service_type:'plex',server_nickname:'Media Server'},{id:2,service_type:'jellyfin',server_nickname:'media-server'}],loading:false};
 const m=await loadFrontend("export {useServerRoutes} from './src/lib/serverRoutes';",{mock:{filter:/hooks\/useServers$/,module:()=>"export const useServers=()=>globalThis.__serverRoutes;"}});
 const routes=m.useServerRoutes();assert.equal(routes.serverFor('plex/media-server').id,1);assert.equal(routes.serverFor('jellyfin/media-server').id,2);
 assert.equal(routes.slugFor(2),'jellyfin/media-server');assert.equal(routes.settingsSlug(globalThis.__serverRoutes.servers[1]),'media-server');
 assert.equal(routes.settingsServerFor('media-server','plex').id,1);assert.equal(routes.settingsServerFor('media-server','jellyfin').id,2);
 delete globalThis.__serverRoutes;
});
