import assert from 'node:assert/strict';
import test from 'node:test';
import {loadFrontend} from './frontendLoader.mjs';

test('history renders library and source in distinct columns for both views', async t => {
  const Original = globalThis.MessageChannel, channels = [];
  globalThis.MessageChannel = class extends Original { constructor() { super(); channels.push(this); } };
  t.after(() => { globalThis.MessageChannel = Original; for (const c of channels) { c.port1.close(); c.port2.close(); } });
  const m = await loadFrontend(`
import React from 'react'; import {renderToString} from 'react-dom/server';
import {HistoryTable, initialHistoryView} from './src/components/history/HistoryTable';
export function render(kind, source) {
 const item={id:'1',server_id:'1',source,title:'A movie',library_name:'Movies',person_uuid:'u',person_name:'Viewer',played_at:'2026-01-01',parent_title:null,position_ticks:null,paused_seconds:null,watched_seconds:null,stopped_at:null};
 const page={server_id:'1',servers:[{server_id:'1',name:'Plex',service_type:'plex',live:true,history:true}],categories:[],items:[item],next_before:null,people:[]};
 return renderToString(React.createElement(HistoryTable,{history:{page,pending:false,loading:false,refresh:async()=>{},hasPrevious:false,previous(){},next(){}},mode:kind==='person'?{kind,target:'u'}:{kind,pickServer:true},view:initialHistoryView,onViewChange(){},admin:false,description:'History'}));
}` , {mock:{filter:s=>s==='@tanstack/react-router'||/hooks\/useAccountDisplay$|contexts\/AlertContext$/.test(s),module:s=>s==='@tanstack/react-router'?"import React from 'react';export const Link=p=>React.createElement('a',null,p.children);":/AlertContext$/.test(s)?'export const useAlerts=()=>({success(){},error(){}});':"export const useAccountDisplay=()=>({formatTimestamp:()=>'-'});"}});
  for (const kind of ['person','server']) {
    const html=m.render(kind,'plex');
    assert.match(html, />Library<\/th>/); assert.match(html, />History Source<\/th>/);
    assert.match(html, /<td[^>]*><span><svg[^>]*>.*?<\/svg>Movies<\/span><\/td>/s);
    assert.match(html.replace(/<!-- -->/g, ''), /<td[^>]*>.*?Plex history<\/span><\/td>/s);
    assert.match(m.render(kind,'mum'), />Recorded by MUM<\/span>/);
  }
});
