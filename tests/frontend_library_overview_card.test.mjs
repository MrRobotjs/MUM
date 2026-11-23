import assert from 'node:assert/strict';
import test from 'node:test';
import {loadFrontend} from './frontendLoader.mjs';

// A library's Overview: tiles from the server's Libraries figures, the most
// played items, the newest items and the library's details.
async function load() {
  return loadFrontend(`
import React from 'react';import {renderToString} from 'react-dom/server';import {LibraryOverview} from './src/components/library/LibraryOverview';
export const render=library=>renderToString(React.createElement(LibraryOverview,{serverId:2,serverSlug:'plex/plex++',serviceLabel:'Plex',library}));
export {setAccessToken} from './src/store/authStore';
`, {mock: {
    filter: s => s === 'swr' || s === '@tanstack/react-router' || /contexts\/AuthContext$|hooks\/useAccountDisplay$/.test(s),
    module: s => s === 'swr' ? 'export default (key)=>({data:key?globalThis.overview[key[0]]:undefined,error:undefined,isLoading:false});'
      : s === '@tanstack/react-router' ? "import React from 'react';export const Link=p=>React.createElement('a',{href:'#'+p.params.mediaId,className:p.className},p.children);"
      : /AuthContext$/.test(s) ? "export const useAuth=()=>({user:{uuid:'admin'},isAdministrator:true});"
      : "export const useAccountDisplay=()=>({formatTimestamp:v=>'AT:'+v,formatRelative:v=>'AGO:'+v});",
  }});
}

const row = extra => ({id: 4, external_id: '2', name: 'TV Shows', library_type: 'show', item_count: 209, parent_count: 693, child_count: 11286, last_scanned: null, catalogue_synced: true,
  plays: 4979, watch_seconds: 3600, last_streamed_at: '2026-11-18T00:00:00Z', last_played: {title: 'A Pregnancy Test', parent_title: null, media_type: 'episode', source: 'mum', poster_url: null, link: null}, ...extra});
const library = {id: 4, name: 'TV Shows', external_id: '2', library_type: 'show', last_scanned: null, server: {server_nickname: 'Plex++', server_name: 'Plex++'},
  catalogue: {synced_at: '2026-11-17T00:00:00Z', item_count: 209}};

test('library overview', async t => {
  const Original = globalThis.MessageChannel, channels = [];
  globalThis.MessageChannel = class extends Original { constructor() { super(); channels.push(this); } };
  t.after(() => { globalThis.MessageChannel = Original; for (const c of channels) { c.port1.close(); c.port2.close(); } delete globalThis.overview; });
  const m = await load();
  m.setAccessToken('session');

  await t.test('tiles, most played, newest items and details', () => {
    globalThis.overview = {
      'library-overview-figures': {items: [row()]},
      'library-overview-most-played': [{item_id: 9, title: 'Georgie & Mandy', streams: 42, poster_url: null}],
      'library-overview-recent': [{id: 11, title: 'New Show', item_type: 'show', year: 2026, thumb: null, added_at: '2026-11-10T00:00:00Z'}],
    };
    const html = m.render(library).replace(/<!-- -->/g, '');
    assert.match(html, /Items<\/p><p[^>]*>209</);
    assert.match(html, /Episodes<\/p><p[^>]*>11,286</);
    assert.match(html, /693 seasons/);
    assert.match(html, /Plays<\/p><p[^>]*>4,979</);
    assert.match(html, /A Pregnancy Test/);
    assert.match(html, /href="#9"[^>]*>.*42 plays.*Georgie &amp; Mandy/s);
    // Both rows scroll with left and right buttons.
    assert.match(html, /aria-label="Scroll most played right"/);
    assert.match(html, /aria-label="Scroll recently added left"/);
    assert.match(html, /href="#11"[^>]*>.*Added AGO:2026-11-10.*New Show/s);
    assert.match(html, /Items in catalogue:<\/span><span[^>]*>209</);
  });

  await t.test('a movie library without plays or items yet', () => {
    globalThis.overview = {'library-overview-figures': {items: [row({library_type: 'movie', parent_count: null, child_count: null, plays: 0, last_streamed_at: null, last_played: null})]},
      'library-overview-most-played': [], 'library-overview-recent': []};
    const html = m.render({...library, library_type: 'movie', catalogue: {synced_at: null, item_count: null}}).replace(/<!-- -->/g, '');
    assert.doesNotMatch(html, /Episodes<\/p>/);
    assert.match(html, /No plays in the last 30 days/);
    assert.match(html, /No items yet\. Sync this library/);
    assert.match(html, /Not synced yet/);
    assert.match(html, /Last streamed<\/p><p[^>]*>Never</);
    assert.doesNotMatch(html, /aria-label="Scroll/, 'no buttons without posters');
  });
});
