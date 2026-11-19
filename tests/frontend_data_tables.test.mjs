import assert from 'node:assert/strict';
import test from 'node:test';
import {loadFrontend} from './frontendLoader.mjs';

// MUM's tables share one TanStack Table setup (components/table/DataTable).
// These render each converted table to HTML and check what the page passes in
// is what the table shows.
async function load() {
  return loadFrontend(`
import React from 'react';import {renderToString} from 'react-dom/server';
import {InvitesTable} from './src/components/invites/InvitesTable';
import {UsersTable} from './src/components/users/UsersTable';
import {ActivityTable} from './src/components/library/ActivityTable';
import {useRememberedColumns} from './src/components/table/DataTable';
export const invites=props=>renderToString(React.createElement(InvitesTable,props));
export const users=props=>renderToString(React.createElement(UsersTable,props));
export const activity=props=>renderToString(React.createElement(ActivityTable,props));
export const remembered=(key,scope,fixed,change)=>{let out,handler;const Probe=()=>{const [state,onChange]=useRememberedColumns(key,scope,fixed);out=state;handler=onChange;return null;};renderToString(React.createElement(Probe));if(change)handler(change);return out;};
`, {mock: {
    filter: s => s === '@tanstack/react-router' || /hooks\/useAccountDisplay$|users\/UserDebugModal$|users\/UserAvatar$|contexts(\/AlertContext)?$/.test(s),
    module: s => s === '@tanstack/react-router' ? 'export const useNavigate=()=>()=>{};export const Link=p=>p.children;'
      : /UserDebugModal$/.test(s) ? 'export const UserDebugModal=()=>null;'
      : /contexts(\/AlertContext)?$/.test(s) ? 'export const useAlerts=()=>({success(){},error(){}});'
      : /UserAvatar$/.test(s) ? "import React from 'react';export const UserAvatar=p=>React.createElement('span',{className:'avatar'},p.user.uuid);"
      : "export const useAccountDisplay=()=>({formatTimestamp:(v,style,fallback)=>v?'AT:'+v:(fallback??'')});",
  }});
}

const headers = html => [...html.matchAll(/<th[^>]*>(.*?)<\/th>/g)].map(h => h[1].replace(/<[^>]+>/g, '').replace(/<!-- -->/g, ''));
const rows = html => [...html.matchAll(/<tr[^>]*>.*?<\/tr>/g)].slice(1).map(r => r[0]);

const allColumns = {name: true, email: true, serviceJoinDate: false, lastKnownIp: false, totalPlays: true, totalDuration: false, type: false, roles: false, libraries: false,
  lastStreamed: false, mumAddedDate: false, lastPlayed: false, lastPlatform: false, lastPlayer: false, linked: false, lastLogin: false, actions: true};
const user = (uuid, name, extra = {}) => ({uuid, username: name, display_name: name, email: `${name}@example.test`, user_type: 'service', is_active: true, admin_roles: [], user_roles: [],
  linked_service_count: 0, total_plays: 7, ...extra});

test('shared data tables', async t => {
  const Original = globalThis.MessageChannel, channels = [];
  globalThis.MessageChannel = class extends Original { constructor() { super(); channels.push(this); } };
  const before = globalThis.localStorage;
  const store = new Map();
  globalThis.localStorage = {getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v))};
  t.after(() => { globalThis.MessageChannel = Original; for (const c of channels) { c.port1.close(); c.port2.close(); } globalThis.localStorage = before; });
  const m = await load();

  await t.test('invites: headers, rows and the page’s selection', () => {
    const invite = (id, token, extra = {}) => ({id, token, current_uses: 1, max_uses: 5, is_active: true, ...extra});
    const html = m.invites({invites: [invite(1, 'aaa'), invite(2, 'bbb', {custom_path: 'friends', is_archived: true})], selectedIds: new Set([2]), onToggleSelect() {}, onSelectAll() {}, onEdit() {}});
    assert.deepEqual(headers(html).slice(1), ['Token / Path', 'Expires', 'Uses', 'Status', '']);
    const [first, second] = rows(html);
    assert.match(first, /aaa/); assert.match(first, /data-state="unchecked"/); assert.match(first, />Active</);
    assert.match(second, /friends/); assert.match(second, /data-state="checked"/); assert.match(second, />Archived</);
    assert.match(second, /title="Archived invites cannot be edited"/);
    assert.match(m.invites({invites: [], selectedIds: new Set(), onToggleSelect() {}, onSelectAll() {}}), /No invites found\./);
  });

  await t.test('users: the page’s columns and selection', () => {
    const list = [user('u1', 'alpha'), user('u2', 'beta')];
    const plain = m.users({users: list, columns: allColumns});
    assert.deepEqual(headers(plain), ['', 'User', 'Email', 'Total Plays', 'Actions']);
    assert.doesNotMatch(plain, /data-state="(un)?checked"/);
    const selecting = m.users({users: list, columns: {...allColumns, email: false}, selectedUserIds: new Set(['u2']), onToggleSelection() {}, onToggleSelectAll() {}, selectAllState: 'some'});
    assert.deepEqual(headers(selecting).slice(1), ['', 'User', 'Total Plays', 'Actions']);
    const [first, second] = rows(selecting);
    assert.doesNotMatch(first, /bg-primary\/10/);
    assert.match(second, /bg-primary\/10/);
    assert.match(second, /beta/);
    const loading = m.users({users: [], columns: allColumns, loading: true});
    assert.equal(rows(loading).length, 5);
    assert.equal((rows(loading)[0].match(/<td/g) ?? []).length, 5);
    assert.match(m.users({users: [], columns: allColumns}), /colSpan="5"[^>]*>No users match the current filters\./);
  });

  await t.test('activity: the History tab layout, one row per play', () => {
    const html = m.activity({days: 7, onDaysChange() {}, page: 1, totalPages: 1, onPageChange() {}, loading: false, emptyMessage: 'Nothing here',
      rows: [{id: 9, media_title: 'Arrival', user_display_name: 'alpha', user_uuid: 'u1', started_at: '2026-11-01T00:00:00Z', duration_seconds: 3720, platform: 'Roku', product: 'Plex for Roku', player: 'TV'},
        {id: 10, media_title: 'Pilot', grandparent_title: 'A Show', user_display_name: 'beta', started_at: '2026-11-02T00:00:00Z', duration_seconds: 60}]});
    assert.deepEqual(headers(html), ['Poster', 'Media Title', 'User', 'Date', 'Started', 'Duration', 'Platform', 'Product', 'Player']);
    const [first, second] = rows(html);
    assert.match(first, /Arrival/); assert.match(first, /62 mins/); assert.match(first, /Roku/); assert.match(first, /Plex for Roku/);
    assert.match(second, /A Show/); assert.match(second, /1 min</); assert.match(second, /title="Not recorded"/);
    assert.match(html, /Recent activity/);
    assert.match(m.activity({days: 7, onDaysChange() {}, page: 1, totalPages: 1, onPageChange() {}, loading: false, rows: [], emptyMessage: 'Nothing here'}), /Nothing here/);
  });

  await t.test('remembered columns: per scope, never the fixed ones', () => {
    store.set('cols', JSON.stringify({plex: ['ip', 'title'], emby: ['product']}));
    assert.deepEqual(m.remembered('cols', 'plex', ['title']), {ip: false});
    assert.deepEqual(m.remembered('cols', 'emby', ['title']), {product: false});
    m.remembered('cols', 'plex', ['title'], {ip: true, paused: false, title: false});
    assert.deepEqual(JSON.parse(store.get('cols')), {plex: ['paused'], emby: ['product']});
    store.set('flat', JSON.stringify(['email', 'user', 7]));
    assert.deepEqual(m.remembered('flat', undefined, ['user']), {email: false});
    store.set('broken', '{not json');
    assert.deepEqual(m.remembered('broken', undefined, []), {});
  });
});
