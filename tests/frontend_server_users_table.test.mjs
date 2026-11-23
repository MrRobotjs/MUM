import assert from 'node:assert/strict';
import test from 'node:test';
import {loadFrontend} from './frontendLoader.mjs';

// A server's Users table is a TanStack table run in manual mode: it renders
// the server's page with the chosen columns and asks the server for the
// sorting and page it holds.
async function load() {
  return loadFrontend(`
import React from 'react';import {renderToString} from 'react-dom/server';import {ServerUsersCard} from './src/components/servers/ServerUsersCard';
export const render=()=>renderToString(React.createElement(ServerUsersCard,{serverId:2,serverSlug:'plex/plex++',serviceType:'plex',onSync(){},syncing:false,syncDisabled:false}));
export {serverAccountSort} from './src/lib/serverAccounts';export {setAccessToken} from './src/store/authStore';
`, {mock: {
    filter: s => s === 'swr' || s === '@tanstack/react-router' || /contexts\/AuthContext$|hooks\/useAccountDisplay$|users\/AccountAvatar$/.test(s),
    module: s => s === 'swr' ? 'export default (key)=>{globalThis.usersTable.key=key;return {data:globalThis.usersTable.data,isLoading:false,mutate:async()=>{}};};'
      : s === '@tanstack/react-router' ? `import React from 'react';export const Link=p=>React.createElement('a',{href:p.to.replace('$serverType',p.params?.serverType??'').replace('$serverId',p.params?.serverId??'').replace('$username',p.params?.username??'')+(p.search?.id?'?id='+p.search.id:'')},p.children);`
      : /AuthContext$/.test(s) ? "export const useAuth=()=>({user:{uuid:'admin'},isAdministrator:true});"
      : /AccountAvatar$/.test(s) ? "import React from 'react';export const AvatarName=p=>React.createElement('span',null,p.name);"
      : "export const useAccountDisplay=()=>({formatTimestamp:v=>'AT:'+v,formatRelative:v=>'AGO:'+v});",
  }});
}

const account = (uuid, username) => ({uuid, username, email: `${username}@example.test`, is_active: true, access_expires_at: null, plays: 3, watch_seconds: 600,
  last_streamed_at: null, last_played: null, last_ip: '10.0.0.1', last_platform: 'Roku', last_player: 'TV', linked_profile: null, libraries: [], has_all_libraries: true, avatar_url: null});
const page = (extra = {}) => ({server_id: 2, server_name: 'Plex++', service_type: 'plex', live: true, records: 'all', page: 1, page_size: 25, total_items: 2, total_pages: 1,
  items: [account('11111111-1111-4111-8111-111111111111', 'alpha'), account('22222222-2222-4222-8222-222222222222', 'beta')], ...extra});
const headers = html => [...html.matchAll(/<th[^>]*>.*?<\/th>/g)].map(h => h[0].replace(/<[^>]+>/g, '').replace(/<!-- -->/g, ''));

test('server users table', async t => {
  const Original = globalThis.MessageChannel, channels = [];
  globalThis.MessageChannel = class extends Original { constructor() { super(); channels.push(this); } };
  const before = globalThis.localStorage;
  t.after(() => { globalThis.MessageChannel = Original; for (const c of channels) { c.port1.close(); c.port2.close(); } globalThis.localStorage = before; delete globalThis.usersTable; });
  const m = await load();
  m.setAccessToken('session');
  const storage = hidden => { globalThis.localStorage = {getItem: k => k === 'mum.server-users.columns' ? JSON.stringify(hidden) : null, setItem() {}}; };

  await t.test('renders every column, sorted by user, and asks for that sort and page', () => {
    storage([]);
    globalThis.usersTable = {data: page()};
    const html = m.render();
    assert.deepEqual(headers(html), ['User', 'Username', 'Email', 'Last Streamed', 'Last Played', 'Last Known IP', 'Last Platform', 'Last Player', 'Plays', 'Watch Time', 'Libraries', 'Access Expires']);
    assert.match(html, /<th[^>]*aria-sort="ascending"[^>]*>.*?User/);
    assert.match(html, /alpha@example\.test.*beta@example\.test/s);
    assert.match(html, /href="\/admin\/servers\/plex\/plex\+\+\/users\/alpha"/);
    assert.match(html, /10\.0\.0\.1/);
    const [, , , server, records, search, sort, number, size] = globalThis.usersTable.key;
    assert.deepEqual({server, records, search, sort, number, size}, {server: 2, records: 'all', search: '', sort: 'username_asc', number: 1, size: 25});
  });

  await t.test('only duplicate usernames include an account ID', () => {
    storage([]); const row=account('11111111-1111-4111-8111-111111111111','alpha');
    globalThis.usersTable={data:page({items:[{...row,duplicate_username:true}]})};
    assert.match(m.render(), /users\/alpha\?id=11111111-1111-4111-8111-111111111111/);
    assert.match(m.render().replace(/<!-- -->/g, ''), /ID: 11111111-1111-4111-8111-111111111111/);
    globalThis.usersTable={data:page({items:[{...row,duplicate_username:false}]})};
    assert.doesNotMatch(m.render(), /users\/alpha\?id=/);
  });

  await t.test('hides the columns only MUM fills when the server isn’t recorded live', () => {
    storage([]);
    globalThis.usersTable = {data: page({live: false})};
    const shown = headers(m.render());
    for (const column of ['Last Known IP', 'Last Platform', 'Last Player', 'Watch Time']) assert.ok(!shown.includes(column), column);
    assert.ok(shown.includes('Plays'));
  });

  await t.test('keeps the columns the viewer hid, never the user column', () => {
    storage(['email', 'plays', 'user']);
    globalThis.usersTable = {data: page()};
    const shown = headers(m.render());
    assert.ok(!shown.includes('Email') && !shown.includes('Plays'));
    assert.equal(shown[0], 'User');
  });

  await t.test('pages from the server’s total', () => {
    storage([]);
    globalThis.usersTable = {data: page({total_items: 60, total_pages: 3})};
    assert.match(m.render(), /Page <!-- -->1<!-- --> of <!-- -->3/);
  });

  await t.test('maps a table sort to the server’s sort', () => {
    assert.equal(m.serverAccountSort(undefined), 'username_asc');
    assert.equal(m.serverAccountSort({id: 'user', desc: true}), 'username_desc');
    assert.equal(m.serverAccountSort({id: 'lastStreamed', desc: true}), 'last_streamed_desc');
    assert.equal(m.serverAccountSort({id: 'lastIp', desc: false}), 'last_ip_asc');
    assert.equal(m.serverAccountSort({id: 'toString', desc: false}), 'username_asc');
  });
});
