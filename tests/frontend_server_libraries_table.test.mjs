import assert from 'node:assert/strict';
import test from 'node:test';
import {loadFrontend} from './frontendLoader.mjs';

// A server's Libraries table sorts in the browser (a server has few
// libraries): it shows the server's libraries A–Z by default, with the
// columns the chosen records can fill.
async function load() {
  return loadFrontend(`
import React from 'react';import {renderToString} from 'react-dom/server';import {ServerLibrariesCard} from './src/components/servers/ServerLibrariesCard';
export const render=(serviceType='plex')=>renderToString(React.createElement(ServerLibrariesCard,{serverId:2,serviceType,onSync(){},syncing:false,syncDisabled:false}));
export {setAccessToken} from './src/store/authStore';
`, {mock: {
    filter: s => s === 'swr' || s === '@tanstack/react-router' || /contexts\/AuthContext$|hooks\/useAccountDisplay$/.test(s),
    module: s => s === 'swr' ? 'export default (key)=>{globalThis.librariesTable.key=key;return {data:globalThis.librariesTable.data,isLoading:false,mutate:async()=>{}};};'
      : s === '@tanstack/react-router' ? 'export const Link=p=>p.children;'
      : /AuthContext$/.test(s) ? "export const useAuth=()=>({user:{uuid:'admin'},isAdministrator:true});"
      : "export const useAccountDisplay=()=>({formatTimestamp:v=>'AT:'+v,formatRelative:v=>'AGO:'+v});",
  }});
}

const library = (id, name, extra = {}) => ({id, external_id: String(id), name, library_type: 'movie', item_count: 10, parent_count: null, child_count: null, last_scanned: null, catalogue_synced: true,
  plays: 1, watch_seconds: 60, last_streamed_at: null, last_played: null, ...extra});
const page = (extra = {}) => ({server_id: 2, server_name: 'Plex++', service_type: 'plex', live: true, records: 'all',
  items: [library(1, 'TV Shows', {library_type: 'show', parent_count: 693, child_count: 11286}), library(2, 'anime', {item_count: null}), library(3, 'Movies')], ...extra});
const headers = html => [...html.matchAll(/<th[^>]*>.*?<\/th>/g)].map(h => h[0].replace(/<[^>]+>/g, '').replace(/<!-- -->/g, ''));
const names = html => [...html.matchAll(/<tbody.*?<\/tbody>/gs)].flatMap(b => [...b[0].matchAll(/<tr[^>]*><td[^>]*>.*?<\/td><td[^>]*>(.*?)<\/td>/g)].map(r => r[1].replace(/<[^>]+>/g, '')));

test('server libraries table', async t => {
  const Original = globalThis.MessageChannel, channels = [];
  globalThis.MessageChannel = class extends Original { constructor() { super(); channels.push(this); } };
  const before = globalThis.localStorage;
  const store = new Map();
  globalThis.localStorage = {getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v))};
  t.after(() => { globalThis.MessageChannel = Original; for (const c of channels) { c.port1.close(); c.port2.close(); } globalThis.localStorage = before; delete globalThis.librariesTable; });
  const m = await load();
  m.setAccessToken('session');

  await t.test('every column, libraries A–Z, and the records it asked for', () => {
    globalThis.librariesTable = {data: page()};
    const html = m.render();
    assert.deepEqual(headers(html), ['', 'Library', 'Type', 'Items', 'Seasons / Albums', 'Episodes / Tracks', 'Last Streamed', 'Last Played', 'Plays', 'Watch Time']);
    // A type icon per library, and catalogue counts where known.
    assert.match(html, /data-icon="tv"/);
    assert.match(html, /data-icon="film"/);
    assert.match(html, /11,286/);
    assert.deepEqual(names(html), ['anime', 'Movies', 'TV Shows']);
    assert.match(html, /<th[^>]*aria-sort="ascending"[^>]*>.*?Library/);
    assert.match(html, /3 libraries • 20 items on Plex\+\+/);
    const [, , , server, records] = globalThis.librariesTable.key;
    assert.deepEqual({server, records}, {server: 2, records: 'all'});
  });

  await t.test('the last play shows what was played as an icon', () => {
    globalThis.librariesTable = {data: page({items: [library(4, 'Music', {library_type: 'artist', last_played: {title: 'Miss Me', parent_title: 'Drake', media_type: 'track', source: 'plex', poster_url: null, link: null}})]})};
    const html = m.render();
    assert.equal((html.match(/data-icon="music"/g) ?? []).length, 2, 'the library type and the track');
    assert.match(html, /Miss Me/);
  });

  await t.test('no watch time where MUM has no recordings', () => {
    globalThis.librariesTable = {data: page({live: false, service_type: 'audiobookshelf'})};
    assert.ok(!headers(m.render('audiobookshelf')).includes('Watch Time'));
  });

  await t.test('remembered hidden columns, never the library column', () => {
    store.set('mum.server-libraries.columns', JSON.stringify(['plays', 'library']));
    globalThis.librariesTable = {data: page()};
    const shown = headers(m.render());
    assert.ok(!shown.includes('Plays'));
    assert.equal(shown[1], 'Library');
    store.delete('mum.server-libraries.columns');
  });

  await t.test('an empty server asks for a sync', () => {
    globalThis.librariesTable = {data: page({items: []})};
    assert.match(m.render(), /No libraries yet\. Sync libraries/);
  });
});
