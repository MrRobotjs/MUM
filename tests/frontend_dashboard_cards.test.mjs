import assert from 'node:assert/strict';
import test from 'node:test';
import {loadFrontend} from './frontendLoader.mjs';

// The dashboard's Invites card (four non-overlapping tiles and the newest
// invites) and the Admin log (formerly "Recent Activity").
async function load() {
  return loadFrontend(`
import React from 'react';import {renderToString} from 'react-dom/server';
import {InvitesSummaryCard} from './src/components/dashboard/InvitesSummaryCard';
import {AdminLogCard,adminEventIcon} from './src/components/dashboard/AdminLogCard';
export const invites=()=>renderToString(React.createElement(InvitesSummaryCard));
export const log=()=>renderToString(React.createElement(AdminLogCard));
export {adminEventIcon};
`, {mock: {
    filter: s => s === '@tanstack/react-router' || /lib\/dashboard$|hooks\/useAccountDisplay$|hooks\/useInviteSummary$/.test(s),
    module: s => s === '@tanstack/react-router' ? "import React from 'react';export const Link=p=>React.createElement('a',{href:p.to,className:p.className},p.children);"
      : /lib\/dashboard$/.test(s) ? 'export const fetchRecentEvents=async()=>null;export const useDashboardData=()=>globalThis.dashboardCards.log;'
      : /useInviteSummary$/.test(s) ? 'export const useInviteSummary=()=>globalThis.dashboardCards.invites;'
      : "export const useAccountDisplay=()=>({formatRelative:v=>'AGO:'+v,formatTimestamp:v=>'AT:'+v});",
  }});
}

test('dashboard invites and admin log', async t => {
  const Original = globalThis.MessageChannel, channels = [];
  globalThis.MessageChannel = class extends Original { constructor() { super(); channels.push(this); } };
  t.after(() => { globalThis.MessageChannel = Original; for (const c of channels) { c.port1.close(); c.port2.close(); } delete globalThis.dashboardCards; });
  const m = await load();

  await t.test('invites: four tiles and the newest invites with uses and status', () => {
    globalThis.dashboardCards = {invites: {loading: false, error: null, summary: {counts: {total: 10, usable: 4, paused: 1, active: 6, inactive: 4, expired: 2, maxed: 3},
      recent_invites: [{id: 1, token: 'abc', custom_path: 'friends', created_at: '2026-11-16T00:00:00Z', current_uses: 3, max_uses: 10, is_active: true},
        {id: 2, token: 'def', custom_path: null, created_at: null, current_uses: 5, max_uses: 5, is_active: true, has_reached_max_uses: true}]}}};
    const html = m.invites().replace(/<!-- -->/g, '');
    for (const [label, value] of [['Usable', '4'], ['Paused', '1'], ['Expired', '2'], ['Used up', '3']]) assert.match(html, new RegExp(`${label}</p><p[^>]*>${value}<`));
    assert.doesNotMatch(html, />Total</);
    assert.match(html, /friends.*Created AGO:2026-11-16T00:00:00Z · 3 \/ 10 uses.*Active/s);
    assert.match(html, /def.*5 \/ 5 uses.*Used up/s);
    assert.match(html, /href="\/admin\/invites"[^>]*>Manage invites/);
    assert.doesNotMatch(html, /not available yet/);
  });

  await t.test('admin log: messages with an icon per area and the time', () => {
    globalThis.dashboardCards = {log: {loading: false, error: null, mutate: async () => {}, data: {data: [
      {id: 3, timestamp: '2026-11-18T00:00:00Z', event_type: 'server.save', message: 'A media server was saved'},
      {id: 2, timestamp: '2026-11-17T00:00:00Z', event_type: 'invitation.create', message: 'An invitation was created'}]}}};
    const html = m.log().replace(/<!-- -->/g, '');
    assert.match(html, />Admin log</);
    assert.doesNotMatch(html, /Recent Activity/);
    assert.match(html, /data-icon="server".*A media server was saved.*AGO:2026-11-18T00:00:00Z/s);
    assert.match(html, /data-icon="ticket".*An invitation was created/s);
    assert.equal(m.adminEventIcon('service.remote_access.disable').iconName, 'shield-halved');
    assert.equal(m.adminEventIcon('something.else').iconName, 'circle-info');
    globalThis.dashboardCards = {log: {loading: false, error: null, mutate: async () => {}, data: {data: []}}};
    assert.match(m.log(), /No changes recorded yet\./);
  });
});
