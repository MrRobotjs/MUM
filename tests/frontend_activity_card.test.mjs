import assert from 'node:assert/strict';
import test from 'node:test';
import {loadFrontend} from './frontendLoader.mjs';

// Activity statistics, Tautulli-style: a card per statistic with only the
// statistics that have plays, server badges and a picker on the dashboard,
// the same cards fixed to one server on its Overview, and the servers that
// report nothing named.
async function load() {
  return loadFrontend(`
import React from 'react';import {renderToString} from 'react-dom/server';import {ActivityCard,ActivityStatistics} from './src/components/dashboard/ActivityCard';
export const render=()=>renderToString(React.createElement(ActivityCard));
export const renderFixed=()=>renderToString(React.createElement(ActivityStatistics,{fixedServer:{id:2,name:'Plex++'}}));
`, {mock: {
    filter: s => s === '@tanstack/react-router' || /lib\/dashboard$|hooks\/useAccountDisplay$/.test(s),
    module: s => s === '@tanstack/react-router' ? "import React from 'react';export const Link=p=>React.createElement('a',{href:p.to.replace(/[$](\\w+)/g,(_,k)=>p.params?.[k]??''),className:p.className},p.children);"
      : /lib\/dashboard$/.test(s) ? 'export const fetchActivityStats=async()=>null;export const useDashboardData=()=>globalThis.activityCard;'
      : "export const useAccountDisplay=()=>({formatRelative:v=>'AGO:'+v,formatTimestamp:v=>'AT:'+v});",
  }});
}

const item = (extra = {}) => ({server_id: 2, title: 'Popular', subtitle: null, plays: 2, seconds: 5400, people: 1, poster_url: null, played_at: null, user_uuid: null, library_id: null, library_type: null, avatar_url: null, user_name: null, link: null, server_ids: [], ...extra});
const stats = extra => ({days: 30, order: 'plays', server_id: null, totals: {plays: 12, seconds: 93600, people: 3, titles: 9},
  sections: [
    {kind: 'movies', items: [item({link: {library_id: 7, media_id: 70, episode_id: null}}), item({title: 'Second', plays: 1})]},
    {kind: 'popular_movies', items: [item({people: 2})]},
    {kind: 'audiobooks', items: [item({server_id: 4, title: 'A Book', subtitle: 'An Author', plays: 1, seconds: 1200})]},
    {kind: 'recent', items: [item({title: 'A Show', subtitle: 'Pilot', played_at: new Date(Date.now() - 11 * 60_000).toISOString(), user_name: 'Viewer', link: {library_id: 7, media_id: 71, episode_id: 72}}),
      item({title: 'Older', played_at: new Date(Date.now() - 3 * 3_600_000 - 60_000).toISOString(), user_name: 'Other'})]},
    {kind: 'users', items: [item({server_id: 0, title: 'viewer', plays: 5, user_uuid: '11111111-1111-4111-8111-111111111111', avatar_url: '/api/service-avatars/9?s=a&e=1&g=b', server_ids: [2, 4]})]},
    {kind: 'libraries', items: [item({title: 'Movies', subtitle: 'Plex++', library_id: 7, library_type: 'movie'})]},
  ],
  platforms: [{name: 'Roku', plays: 2, seconds: 600, server_ids: [2]}],
  servers: [{server_id: 2, name: 'Plex++', service_type: 'plex', imported_at: null}, {server_id: 4, name: 'Books', service_type: 'audiobookshelf', imported_at: null}],
  unreported: [{server_id: 3, name: 'Comics', service_type: 'kavita', imported_at: null}, {server_id: 5, name: 'Games', service_type: 'romm', imported_at: null}],
  imported: [{server_id: 4, name: 'Books', service_type: 'audiobookshelf', imported_at: '2026-11-17T00:00:00Z'}], ...extra});

test('activity statistics', async t => {
  const Original = globalThis.MessageChannel, channels = [];
  globalThis.MessageChannel = class extends Original { constructor() { super(); channels.push(this); } };
  t.after(() => { globalThis.MessageChannel = Original; for (const c of channels) { c.port1.close(); c.port2.close(); } delete globalThis.activityCard; });
  const m = await load();

  await t.test('dashboard: tiles, a card per statistic with plays, badges, picker and notes', () => {
    globalThis.activityCard = {loading: false, error: null, data: stats()};
    const html = m.render().replace(/<!-- -->/g, '');
    assert.match(html, /Plays<\/p><p[^>]*>12</);
    assert.match(html, /Time<\/p><p[^>]*>1 day 2 hrs</);
    for (const title of ['Most watched movies', 'Most popular movies', 'Most listened audiobooks', 'Recently played', 'Most active users', 'Most active libraries', 'Most active platforms']) assert.match(html, new RegExp(title));
    assert.doesNotMatch(html, /Most watched shows|Most played albums/);
    // Ranked rows with the figure; popular counts people; recent shows when.
    assert.match(html, /Most watched movies<\/strong><\/span><span class="dashboard-stat-metric">Plays<\/span>.*>1<\/span>.*Popular.*>2<\/span>.*>2<\/span>.*Second.*>1</s);
    assert.match(html, /Most popular movies<\/strong><\/span><span class="dashboard-stat-metric">Users<\/span>/);
    // Recently played: short times, under a "When" heading.
    assert.match(html, /A Show.*Pilot.*>11m ago</s);
    assert.match(html, /Older.*>3hrs ago</s);
    // Who played the highlighted title sits beside the card's title.
    assert.match(html, /Recently played<\/strong><span class="dashboard-stat-who">· Viewer<\/span><\/span><span class="dashboard-stat-metric">When</);
    assert.match(html, /href="\/admin\/users\/11111111-1111-4111-8111-111111111111"[^>]*>viewer/);
    assert.match(html, /href="\/admin\/servers\/2\/libraries\/7"[^>]*>Movies/);
    assert.match(html, /title="On Plex\+\+"/);
    // Catalogued titles open their pages; an episode its episode page.
    assert.match(html, /href="\/admin\/servers\/2\/libraries\/7\/70" class="dashboard-stat-link">Popular</);
    assert.match(html, /href="\/admin\/servers\/2\/libraries\/7\/71\/episodes\/72" class="dashboard-stat-link">A Show</);
    assert.doesNotMatch(html, /dashboard-stat-link">Second</);
    // Title, subtitle and the server sit together.
    assert.match(html, /dashboard-stat-name">.*A Show.*dashboard-stat-sub">· Pilot<\/span><span class="dashboard-stat-badges"[^>]*title="On Plex\+\+">/s);
    // A person on two servers: the most used one's badge and how many more.
    assert.match(html, />viewer<\/a><\/span><span class="dashboard-stat-badges"[^>]*title="On Plex\+\+ and Books">.*?\+1</s);
    assert.match(html, /Roku<\/span><span class="dashboard-stat-badges"[^>]*title="On Plex\+\+">/);
    // The server's icon and name; only the highlighted row's name is lit.
    assert.match(html, /class="dashboard-stat-badges" data-lit="true" style="--stat-server-color:var\(--color-plex\)"/);
    assert.match(html, /class="dashboard-stat-badges" style="--stat-server-color:var\(--color-plex\)" title="On Plex\+\+"><span class="dashboard-stat-server"><svg[^>]*dashboard-stat-server-icon/);
    assert.doesNotMatch(html, /Server tags|data-tag/);
    assert.match(html, /Last 30 days/);
    // The most active user's picture, in a circle.
    assert.match(html, /dashboard-stat-visual dashboard-stat-round"><img src="\/api\/service-avatars\/9[^"]*" alt="" class="dashboard-stat-avatar"/);
    // Rows are focusable so the picture can follow the keyboard too.
    assert.match(html, /<li class="dashboard-stat-row" data-active="true" tabindex="0"/);
    assert.match(html, /aria-label="Server"/);
    assert.match(html, /aria-pressed="true"[^>]*>Play count/);
    assert.match(html, /Audiobooks come from imported history: Books imported AGO:2026-11-17T00:00:00Z/);
    assert.match(html, /Comics \(Kavita\) and Games \(RomM\) don’t report activity to MUM yet\./);
  });

  await t.test('play duration ranks and labels by time', () => {
    globalThis.activityCard = {loading: false, error: null, data: stats({order: 'duration'})};
    const html = m.render().replace(/<!-- -->/g, '');
    assert.match(html, /Most watched movies<\/strong><\/span><span class="dashboard-stat-metric">Time · HH:MM<\/span>.*>1:30<\/span>.*>0:20<\/span>/s);
    // The Time tile keeps its words; Recently played keeps "When".
    assert.match(html, /Time<\/p><p[^>]*>1 day 2 hrs</);
    assert.match(html, /Recently played<\/strong>.*?dashboard-stat-metric">When</s);
  });

  await t.test('a server overview: fixed to the server, no picker, badges or unreported note', () => {
    globalThis.activityCard = {loading: false, error: null, data: stats({server_id: 2})};
    const html = m.renderFixed().replace(/<!-- -->/g, '');
    assert.match(html, /played on Plex\+\+\./);
    assert.doesNotMatch(html, /aria-label="Server"/);
    assert.doesNotMatch(html, /title="On /);
    assert.doesNotMatch(html, /report activity to MUM/);
  });

  await t.test('all time', () => {
    globalThis.activityCard = {loading: false, error: null, data: stats({days: 0, totals: {plays: 0, seconds: 0, people: 0, titles: 0}, sections: [], platforms: [], unreported: []})};
    assert.match(m.render().replace(/<!-- -->/g, ''), /Nothing played yet\./);
  });

  await t.test('a typed-in period, and pickers only as wide as their choice', () => {
    globalThis.activityCard = {loading: false, error: null, data: stats({days: 14})};
    const html = m.render().replace(/<!-- -->/g, '');
    assert.match(html, /Plays<\/p><p[^>]*>12<\/p><span class="dashboard-health-note">Last 14 days</);
    assert.match(html, /w-auto" aria-label="Server"/);
    assert.match(html, /w-auto" aria-label="Period"/);
    assert.doesNotMatch(html, /w-56/);
  });

  await t.test('nothing played', () => {
    globalThis.activityCard = {loading: false, error: null, data: stats({totals: {plays: 0, seconds: 0, people: 0, titles: 0}, sections: [], platforms: [], unreported: []})};
    assert.match(m.render().replace(/<!-- -->/g, ''), /Nothing played in the last 30 days\./);
  });
});
