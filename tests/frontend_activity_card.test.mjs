import assert from 'node:assert/strict';
import test from 'node:test';
import {loadFrontend} from './frontendLoader.mjs';

// The dashboard's Activity card shows only the sections with plays, says when
// audiobook figures were imported, and names servers that report nothing.
async function load() {
  return loadFrontend(`
import React from 'react';import {renderToString} from 'react-dom/server';import {ActivityCard} from './src/components/dashboard/ActivityCard';
export const render=()=>renderToString(React.createElement(ActivityCard));
`, {mock: {
    filter: s => /lib\/dashboard$|hooks\/useAccountDisplay$/.test(s),
    module: s => /lib\/dashboard$/.test(s) ? 'export const fetchActivityStats=async()=>null;export const useDashboardData=()=>globalThis.activityCard;'
      : "export const useAccountDisplay=()=>({formatRelative:v=>'AGO:'+v,formatTimestamp:v=>'AT:'+v});",
  }});
}

const stats = extra => ({days: 7, totals: {plays: 12, seconds: 93600, people: 3, titles: 9},
  sections: [{kind: 'movies', items: [{server_id: 2, title: 'Popular', subtitle: null, plays: 2, seconds: 5400, poster_url: null}]},
    {kind: 'audiobooks', items: [{server_id: 4, title: 'A Book', subtitle: 'An Author', plays: 1, seconds: 1200, poster_url: null}]}],
  platforms: [{name: 'Roku', plays: 2}], server_id: null,
  servers: [{server_id: 2, name: 'Plex++', service_type: 'plex', imported_at: null}, {server_id: 4, name: 'Books', service_type: 'audiobookshelf', imported_at: null}],
  unreported: [{server_id: 3, name: 'Comics', service_type: 'kavita', imported_at: null}, {server_id: 5, name: 'Games', service_type: 'romm', imported_at: null}],
  imported: [{server_id: 4, name: 'Books', service_type: 'audiobookshelf', imported_at: '2026-11-17T00:00:00Z'}], ...extra});

test('dashboard activity card', async t => {
  const Original = globalThis.MessageChannel, channels = [];
  globalThis.MessageChannel = class extends Original { constructor() { super(); channels.push(this); } };
  t.after(() => { globalThis.MessageChannel = Original; for (const c of channels) { c.port1.close(); c.port2.close(); } delete globalThis.activityCard; });
  const m = await load();

  await t.test('tiles, sections with plays, platforms and the servers that report nothing', () => {
    globalThis.activityCard = {loading: false, error: null, data: stats()};
    const html = m.render().replace(/<!-- -->/g, '');
    assert.match(html, />Activity</);
    assert.match(html, /Plays<\/p><p[^>]*>12</);
    assert.match(html, /Time<\/p><p[^>]*>1 day 2 hrs</);
    assert.match(html, /Most watched movies/);
    assert.match(html, /Most listened audiobooks/);
    assert.doesNotMatch(html, /Most watched shows|Most played music/);
    assert.match(html, /An Author/);
    assert.match(html, /From imported history: Books imported AGO:2026-11-17T00:00:00Z/);
    assert.match(html, /Top platforms.*Roku.*2 plays/s);
    assert.match(html, /Comics \(Kavita\) and Games \(RomM\) don’t report activity to MUM yet\./);
    // Two servers report: a server picker, and each title's server as a badge.
    assert.match(html, /aria-label="Server"/);
    assert.match(html, /title="On Plex\+\+"[^>]*>.*Plex\+\+<\/span>/s);
    assert.match(html, /title="On Books"/);
  });

  await t.test('one reporting server: no picker and no badges', () => {
    globalThis.activityCard = {loading: false, error: null, data: stats({servers: [{server_id: 2, name: 'Plex++', service_type: 'plex', imported_at: null}],
      sections: [{kind: 'movies', items: [{server_id: 2, title: 'Popular', subtitle: null, plays: 2, seconds: 5400, poster_url: null}]}]})};
    const html = m.render();
    assert.doesNotMatch(html, /aria-label="Server"/);
    assert.doesNotMatch(html, /title="On Plex/);
  });

  await t.test('nothing played', () => {
    globalThis.activityCard = {loading: false, error: null, data: stats({totals: {plays: 0, seconds: 0, people: 0, titles: 0}, sections: [], platforms: [], unreported: []})};
    const html = m.render().replace(/<!-- -->/g, '');
    assert.match(html, /Nothing played in the last 7 days\./);
    assert.doesNotMatch(html, /report activity/);
  });
});
