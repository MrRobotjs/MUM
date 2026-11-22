import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';

test('Info settings has a route, navigation and real monitoring status', () => {
  const read = path => readFileSync(new URL(`../frontend/src/${path}`, import.meta.url), 'utf8');
  const nav = read('components/layout/NavSettings.tsx');
  assert.ok(nav.indexOf("title: 'Info'") < nav.indexOf("title: 'General'"));
  assert.match(read('router/AppRouter.tsx'), /settings\/info/);
  const info = read('pages/AdminSettingsInfoPage.tsx');
  assert.match(info, /MUM Configuration/);
  assert.match(info, /Scheduled Tasks/);
  assert.match(info, /useActivityMonitoring/);
  assert.match(info, /Check for active sessions/);
  const hook = read('hooks/useScheduledTasks.ts');
  assert.match(hook, /Refresh users list/);
  assert.match(hook, /Refresh libraries list/);
  assert.doesNotMatch(info, /Shared users and libraries schedule/);
  assert.match(info, /getServiceBadgeClass\(task\.provider\)/);
  assert.doesNotMatch(info, /<TableHead>Channels<\/TableHead>/);
  assert.doesNotMatch(info, /<TableHead>Type<\/TableHead>/);
  assert.match(info, /Provider subscription/);
  assert.match(info, /socketMonitoringStatus\(task\)/);
  assert.match(info, /<TaskState state=\{isSocketConnected\(task\)\?'active':'inactive'\} label="WebSocket"/);
  assert.match(info, /<TaskState state=\{scheduledTaskState\(task\.state\)\}/);
  assert.doesNotMatch(info, /<CardTitle>Activity Monitoring<\/CardTitle>/);
  assert.doesNotMatch(read('pages/AdminSettingsAdvancedPage.tsx'), /MUM Configuration/);
});
