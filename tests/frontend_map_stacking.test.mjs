import assert from 'node:assert/strict';
import test from 'node:test';
import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const chrome='C:/Program Files/Google/Chrome/Application/chrome.exe';
test('saving a map key keeps the real desktop dialog and mobile sheet above Leaflet',{
 skip:!existsSync(chrome)?'Local Chrome is required for this isolated browser check':false,
},()=>{
 const result=spawnSync(process.execPath,[fileURLToPath(new URL('../migration-documentation/check_map_dialog_stacking.mjs',import.meta.url))],{encoding:'utf8',timeout:65000,windowsHide:true});
 assert.equal(result.status,0,result.stdout+result.stderr);
 const views=JSON.parse(result.stdout.trim());
 assert.equal(views.length,2);
 for(const view of views){assert.equal(view.passed,true,view.name);assert.equal(view.points,25);}
 assert.equal(views[0].dialog,'dialog-content');
 assert.equal(views[1].dialog,'sheet-content');
});
