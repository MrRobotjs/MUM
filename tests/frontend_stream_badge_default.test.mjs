import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';

test('account preferences do not offer stream badge or sync controls',()=>{
 const page=readFileSync(new URL('../frontend/src/pages/AccountPage.tsx',import.meta.url),'utf8');
 assert.doesNotMatch(page,/UserPreferencesCard/);
 assert.match(page,/<AccountDisplayCard/);
});
