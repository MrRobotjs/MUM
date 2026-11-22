import assert from 'node:assert/strict';
import test from 'node:test';
import {loadFrontend} from './frontendLoader.mjs';

// A server account card shows when its owner last signed in to MUM and the
// owner's other server accounts; "Linked to" names the owner only when the
// owner has its own card (a MUM username).
async function load() {
  return loadFrontend(`
import React from 'react';import {renderToString} from 'react-dom/server';import {UserCard} from './src/components/users/UserCard';
export const render=(user,onEdit)=>renderToString(React.createElement(UserCard,{user,onEdit}));
`, {mock: {
    filter: s => /hooks\/useAccountDisplay$/.test(s) || s === '@tanstack/react-router' || /contexts(\/AlertContext)?$/.test(s),
    module: s => s === '@tanstack/react-router' ? 'export const useNavigate=()=>()=>{};'
      : /contexts/.test(s) ?'export const useAlerts=()=>({success(){},error(){}});'
      : "export const useAccountDisplay=()=>({current:null,formatTimestamp:(v,style)=>style==='date'?'DATE:'+v.slice(0,10):'FULL:'+v});",
  }});
}

const base = {uuid: '11111111-1111-4111-8111-111111111111', user_type: 'service', username: 'Jelly', display_name: 'Jelly', is_active: true,
  admin_roles: [], user_roles: [], linked_service_count: 0, service_type: 'jellyfin', server_nickname: 'Jelly++', server_id: 1, libraries: [], has_all_libraries: false};

test('server account cards show MUM sign-in and linked accounts', async t => {
  // React keeps MessageChannels open after rendering; close them so the run ends.
  const Original = globalThis.MessageChannel, channels = [];
  globalThis.MessageChannel = class extends Original { constructor() { super(); channels.push(this); } };
  t.after(() => { globalThis.MessageChannel = Original; for (const c of channels) { c.port1.close(); c.port2.close(); } });
  const m = await load();
  await t.test('only service cards expose editing between info and profile', () => {
    const html = m.render(base, () => {});
    assert.match(html, /title="Show Raw User Data"[\s\S]*title="Edit User"[\s\S]*title="View User Profile"/);
    assert.doesNotMatch(m.render({...base, user_type: 'local'}, () => {}), /title="Edit User"/);
    assert.doesNotMatch(m.render(base), /title="Edit User"/);
  });
  await t.test('signed-in owner with another server account', () => {
    const html = m.render({...base, mum_last_login_at: '2026-11-15T10:00:00Z',
      linked_local_user: {uuid: '22222222-2222-4222-8222-222222222222', username: '', display_name: 'Jelly'},
      linked_accounts: [{uuid: '33333333-3333-4333-8333-333333333333', service_type: 'plex', server_nickname: 'Plex++', username: 'jelly_plex'}]});
    assert.match(html, /title="This person has signed in to MUM"[^>]*>[\s\S]*?Jelly<\/span>/);
    assert.match(html, /Signed in:.*DATE:2026-11-15/);
    assert.match(html, />jelly_plex</);
    assert.match(html, /on Plex\+\+/);
    assert.doesNotMatch(html, /Linked to/, 'an owner without its own card is not named');
  });
  await t.test('owner with a MUM username is named', () => {
    const html = m.render({...base, linked_local_user: {uuid: '22222222-2222-4222-8222-222222222222', username: 'jelly-mum', display_name: 'jelly-mum'}, linked_accounts: []});
    assert.match(html, /Linked to/);
    assert.match(html, />jelly-mum</);
    assert.doesNotMatch(html, /MUM account|Signed in:/);
  });
  await t.test('signed-in badge uses the MUM username, not display name', () => {
    const html = m.render({...base, mum_last_login_at: '2026-11-15T10:00:00Z', linked_local_user: {uuid: '22222222-2222-4222-8222-222222222222', username: 'admin', display_name: 'Administrator'}});
    assert.match(html, /title="This person has signed in to MUM"[^>]*>[\s\S]*?admin<\/span>/);
  });
  await t.test('unowned account has neither', () => {
    const html = m.render({...base, linked_local_user: null, mum_last_login_at: null, linked_accounts: []});
    assert.doesNotMatch(html, /MUM account|Signed in:|Linked to/);
  });
});
