import test from 'node:test';
import assert from 'node:assert/strict';
import {loadFrontend} from './frontendLoader.mjs';
test('next run time uses the account calendar day and clock preference',async()=>{
 const {formatNextRunTime}=await loadFrontend("export {formatNextRunTime} from './src/lib/scheduledTaskDisplay';");
 const denver={mode:'named',time_zone:'America/Denver',time_format:'12'};
 assert.equal(formatNextRunTime('2026-11-24T06:30:00Z','2026-11-24T05:00:00Z',denver,'en-US'),'11:30:00 PM');
 assert.match(formatNextRunTime('2026-11-24T07:30:00Z','2026-11-24T05:00:00Z',denver,'en-US'),/Nov 24, 2026/);
 assert.equal(formatNextRunTime('2026-11-24T07:30:00Z','2026-11-24T05:00:00Z',{mode:'utc',time_zone:null,time_format:'24'},'en-US'),'07:30:00');
 assert.match(formatNextRunTime('2026-03-09T06:15:00Z','2026-03-09T05:45:00Z',denver,'en-US'),/Mar 9, 2026/);
 assert.equal(formatNextRunTime(null,'2026-11-24T05:00:00Z',denver,'en-US'),'—');
 assert.equal(formatNextRunTime('invalid','2026-11-24T05:00:00Z',denver,'en-US'),'—');
});
