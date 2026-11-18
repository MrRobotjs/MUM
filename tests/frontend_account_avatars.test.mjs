import assert from 'node:assert/strict';
import test from 'node:test';
import {loadFrontend} from './frontendLoader.mjs';

// Pictures beside linked accounts: every link must be MUM's own signed
// picture route; anything else is refused, and a missing picture is null.
async function load() {
  return loadFrontend("export * from './src/lib/accountAvatar';export {parseServiceLinks} from './src/lib/serviceSignIn';export {parseAccountDiscord} from './src/lib/discordSignIn';export {fetchProfileAccountLinks} from './src/lib/serviceAccounts';export {setAccessToken} from './src/store/authStore';");
}

const service = '/api/service-avatars/12?s=session&e=1700000000&g=signature';
const discord = '/api/discord-avatars/3?s=session&e=1700000000&g=signature';

test('account avatars', async t => {
  const before = {fetch: globalThis.fetch, window: globalThis.window};
  t.after(() => { globalThis.fetch = before.fetch; globalThis.window = before.window; });
  globalThis.window = {location: {origin: 'http://mum.test'}};

  await t.test('only MUM picture links are accepted', async () => {
    const m = await load();
    assert.equal(m.avatarLink(undefined, 'service'), null);
    assert.equal(m.avatarLink(service, 'service'), service);
    assert.equal(m.avatarLink(discord, 'discord'), discord);
    for (const [bad, route] of [[discord, 'service'], [service, 'discord'], ['https://cdn.discordapp.com/avatars/1/a.png', 'discord'], ['/api/service-avatars/0?s=x', 'service'],
      ['/api/service-avatars/12', 'service'], [`${service}#x`, 'service'], [`/api/service-avatars/12?${'a'.repeat(2100)}`, 'service'], [null, 'service'], [7, 'service']]) {
      assert.throws(() => m.avatarLink(bad, route), /picture/, String(bad));
    }
    assert.equal(m.accountInitial(' alice'), 'A');
    assert.equal(m.accountInitial(''), '?');
  });

  await t.test('linked server accounts keep their picture', async () => {
    const m = await load();
    const link = {service_uuid: '0b0b0b0b-0000-4000-8000-000000000001', server_id: 7, server_name: 'Living Room', server_type: 'jellyfin', username: 'alice', can_unlink: true};
    assert.equal(m.parseServiceLinks({links: [{...link, avatar_url: service}], servers: [], service_sign_in: true}).links[0].avatarUrl, service);
    assert.equal(m.parseServiceLinks({links: [link], servers: [], service_sign_in: true}).links[0].avatarUrl, null);
    assert.throws(() => m.parseServiceLinks({links: [{...link, avatar_url: 'http://evil.test/a.png'}], servers: [], service_sign_in: true}), /picture/);
  });

  await t.test('the Discord account keeps its picture only while linked', async () => {
    const m = await load();
    const linked = {available: true, linked: true, username: 'chris_r', sign_in: false};
    assert.equal(m.parseAccountDiscord({...linked, avatar_url: discord}).avatarUrl, discord);
    assert.equal(m.parseAccountDiscord(linked).avatarUrl, null);
    assert.throws(() => m.parseAccountDiscord({...linked, avatar_url: service}), /picture/);
    assert.throws(() => m.parseAccountDiscord({available: true, linked: false, username: null, sign_in: false, avatar_url: discord}), /Unexpected|picture/);
  });

  await t.test("an administrator sees a person's linked accounts with pictures", async () => {
    const m = await load();
    m.setAccessToken('session');
    const id = n => `12345678-1234-1234-1234-${String(n).padStart(12, '0')}`;
    const account = {uuid: id(3), external_username: 'Fixture', external_email: '', service_type: 'jellyfin', server_name: 'Fixture server', avatar_url: service};
    const page = {actor_uuid: id(1), user_uuid: id(2), role_revision: '1', link_revision: '1', profile_revision: '1', can_link: true, can_unlink: true, linked_accounts: [account], available_accounts: []};
    globalThis.fetch = async () => Response.json({data: page});
    assert.equal((await m.fetchProfileAccountLinks(id(1), id(2))).linked_accounts[0].avatar_url, service);
    globalThis.fetch = async () => Response.json({data: {...page, linked_accounts: [{...account, avatar_url: discord}]}});
    await assert.rejects(m.fetchProfileAccountLinks(id(1), id(2)));
  });
});
