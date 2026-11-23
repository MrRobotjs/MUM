import assert from 'node:assert/strict';
import test from 'node:test';
import {loadFrontend} from './frontendLoader.mjs';

test('graph breakdowns expose the right charts and identify unrecorded resolution', async t => {
  const Original = globalThis.MessageChannel, channels = [];
  globalThis.MessageChannel = class extends Original { constructor() { super(); channels.push(this); } };
  t.after(() => { globalThis.MessageChannel = Original; for (const c of channels) { c.port1.close(); c.port2.close(); } });
  const mod = await loadFrontend(`
    import React from 'react'; import {renderToString} from 'react-dom/server';
    import {PlaybackBreakdowns} from './src/components/graphs/PlaybackBreakdowns';
    export const render = tab => renderToString(React.createElement(PlaybackBreakdowns,{days:30,serverId:'all',tab,separated:true}));
  `, {mock:{
    filter: s => /hooks\/useAccountDisplay$/.test(s) || /hooks\/useAdminApi$/.test(s) || /pages\/GraphsPage$/.test(s) || s === 'recharts',
    module: s => /useAccountDisplay$/.test(s) ? `export const useAccountDisplay=()=>({timeZone:'UTC',formatHour:n=>String(n)});`
      : /useAdminApi$/.test(s) ? `export const useAdminApi=p=>({loading:false,error:null,data:p.includes('play-history')?{data:{users:[]}}:{data:{hourly_media:[],daily_modes:[],users_media:[],users_modes:[],platforms_media:[],platforms_modes:[],concurrent_modes:[],source_resolution:[],stream_resolution:[],source_resolution_missing:0,stream_resolution_missing:0},meta:{unavailable:false}}});`
      : /GraphsPage$/.test(s) ? `import React from 'react';export const GRAPH_REFRESH_MS=15000;export const ChartCard=({title,children})=>React.createElement('section',null,title,children);export const renderGraphsTooltipCard=()=>null;`
      : `import React from 'react';const c=({children})=>React.createElement('div',null,children);export const Bar=c,BarChart=c,CartesianGrid=c,Legend=c,ResponsiveContainer=c,Tooltip=c,XAxis=c,YAxis=c;`
  }});
  const media = mod.render('media');
  assert.match(media, /Plays by Hour and Media Type/);
  assert.match(media, /Top Users by Media Type/);
  assert.doesNotMatch(media, /Daily Peak Concurrent Streams/);
  const streams = mod.render('stream');
  assert.match(streams, /Daily Peak Concurrent Streams/);
  assert.match(streams, /Users by Stream Type/);
  assert.match(streams, /Plays by Source Resolution/);
  assert.match(streams, /No resolution recorded for this period/);
  assert.match(streams, /combine all selected servers/);
  assert.match(media, /rounded-full[^"<>]*" style="background-color:/);
  assert.match(media, /uppercase tracking-wide transition-opacity/);
});
