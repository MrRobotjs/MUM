import assert from 'node:assert/strict';
import test from 'node:test';
import {loadFrontend} from './frontendLoader.mjs';

// The Media Servers page: a card per server, sorted by name, with its live
// status, figures and links to the pages its type has.
async function load() {
  return loadFrontend(`
import React from 'react';import {renderToString} from 'react-dom/server';import {ServersPage} from './src/pages/ServersPage';
export const render=()=>renderToString(React.createElement(ServersPage));
`, {mock: {
    filter: s => s === '@tanstack/react-router' || /lib\/dashboard$|lib\/realtimeSocket$|hooks\/(useServers|useLibraries|useUserTotal|useAccountDisplay)$/.test(s),
    module: s => s === '@tanstack/react-router' ? "import React from 'react';export const Link=p=>React.createElement('a',{href:p.to.replace('$serverId',p.params?.serverId??''),className:p.className},p.children);export const useLocation=()=>({pathname:'/'});export const useNavigate=()=>()=>{};"
      : /lib\/dashboard$/.test(s) ? 'export const fetchServerHealth=async()=>null;export const useDashboardData=()=>globalThis.serversPage.health;'
      : /realtimeSocket$/.test(s) ? 'export const subscribeToChannel=()=>()=>{};'
      : /useServers$/.test(s) ? 'export const useServers=()=>({servers:globalThis.serversPage.servers});'
      : /useLibraries$/.test(s) ? 'export const useLibraries=()=>({libraries:globalThis.serversPage.libraries});'
      : /useUserTotal$/.test(s) ? "export const USER_TOTAL_KEY_PREFIX='/api/users?page=1&page_size=1';export const useUserTotal=({serverId})=>globalThis.serversPage.users[serverId]??null;"
      : "export const useAccountDisplay=()=>({formatRelative:v=>'AGO:'+v,formatTimestamp:v=>'AT:'+v});",
  }});
}

test('media servers page', async t => {
  const Original = globalThis.MessageChannel, channels = [];
  globalThis.MessageChannel = class extends Original { constructor() { super(); channels.push(this); } };
  t.after(() => { globalThis.MessageChannel = Original; for (const c of channels) { c.port1.close(); c.port2.close(); } delete globalThis.serversPage; });
  const m = await load();

  await t.test('a card per server with status, figures and its pages', () => {
    globalThis.serversPage = {
      health: {loading: false, error: null, mutate: async () => {}, data: {meta: {generated_at: 'now'}, data: {
        summary: {total_servers: 2, online: 1, offline: 1, disabled: 0, unchecked: 0},
        servers: [{id: 2, name: 'Plex++', service_type: 'plex', status: 'online', version: '1.42.2', checked_at: '2026-11-18T00:00:00Z'},
          {id: 4, name: 'Audiobooks', service_type: 'audiobookshelf', status: 'offline', checked_at: null}]}}},
      servers: [{id: 2, last_sync_at: '2026-11-18T01:00:00Z'}, {id: 4, last_sync_at: null}],
      libraries: [{id: 1, server_id: 2, item_count: 1278}, {id: 2, server_id: 2, item_count: null, catalogue: {synced_at: 'x', item_count: 209}}],
      users: {2: 56, 4: 0},
    };
    const html = m.render().replace(/<!-- -->/g, '');
    // Sorted by name: Audiobooks before Plex++.
    assert.ok(html.indexOf('Audiobooks') < html.indexOf('Plex++'));
    assert.match(html, /1 online/);
    assert.match(html, /1 offline/);
    assert.match(html, /data-status="online">Online/);
    assert.match(html, /Plex 1\.42\.2 · checked AGO:2026-11-18T00:00:00Z/);
    assert.match(html, /56 users · 2 libraries · 1,487 items\s*· synced AGO:2026-11-18T01:00:00Z/);
    assert.match(html, /0 users · 0 libraries · 0 items\s*· never synced/);
    assert.match(html, /not checked yet/);
    // Plex has Graphs and Resources; Audiobookshelf has neither.
    assert.match(html, /href="\/admin\/servers\/2\/resources"/);
    assert.match(html, /href="\/admin\/servers\/2\/graphs"/);
    assert.doesNotMatch(html, /href="\/admin\/servers\/4\/graphs"/);
    assert.match(html, /href="\/admin\/settings\/media-servers"[^>]*>.*Add server/s);
  });

  await t.test('no servers yet', () => {
    globalThis.serversPage = {health: {loading: false, error: null, mutate: async () => {}, data: {meta: {generated_at: 'now'}, data: {summary: {total_servers: 0, online: 0, offline: 0, disabled: 0, unchecked: 0}, servers: []}}},
      servers: [], libraries: [], users: {}};
    assert.match(m.render(), /No media servers yet/);
  });
});
