import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';

test('per-server refresh settings expose independent intervals and startup options',()=>{
 const file=path=>readFileSync(new URL(`../frontend/src/${path}`,import.meta.url),'utf8');
 const view=file('components/settings/ServerRefreshSettings.tsx');
 for(const label of ['Users List Refresh Interval','Libraries List Refresh Interval','Refresh Users List on Startup','Refresh Libraries List on Startup','Include TV Episodes and Music Tracks'])assert.ok(view.includes(label),label);
 assert.match(view,/users_interval_hours/);assert.match(view,/libraries_interval_hours/);assert.doesNotMatch(view,/Enable scheduled synchronization/);
 assert.match(file('pages/AdminSettingsMediaServerEditPage.tsx'),/<ServerRefreshSettings serverId=/);
});
