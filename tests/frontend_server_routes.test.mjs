import test from 'node:test';
import assert from 'node:assert/strict';
import {loadFrontend} from './frontendLoader.mjs';

test('server URL nicknames allow plus and detect invalid names', async () => {
 const m=await loadFrontend("export {serverNicknameSlug,serverNicknameIssue,findServerBySlug,serverSettingsSlug,findServerBySettingsSlug} from './src/lib/serverNickname';");
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
});
