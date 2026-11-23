import assert from 'node:assert/strict';
import test from 'node:test';
import {loadFrontend} from './frontendLoader.mjs';

test('dashboard invite statuses use the same meanings as invite cards', async () => {
  const {inviteSummaryStatus} = await loadFrontend("export {inviteSummaryStatus} from './src/lib/inviteStatus';");
  assert.deepEqual(inviteSummaryStatus({is_active:true}), {label:'Active', variant:'success'});
  assert.deepEqual(inviteSummaryStatus({is_active:false}), {label:'Disabled', variant:'secondary'});
  assert.deepEqual(inviteSummaryStatus({is_active:true,is_paused:true}), {label:'Paused', variant:'secondary'});
  assert.deepEqual(inviteSummaryStatus({is_active:true,is_expired:true}), {label:'Expired', variant:'statusError'});
  assert.deepEqual(inviteSummaryStatus({is_active:true,has_reached_max_uses:true}), {label:'Used up', variant:'warning'});
  assert.deepEqual(inviteSummaryStatus({is_active:false,is_expired:true}), {label:'Expired', variant:'statusError'});
});
