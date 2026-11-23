import test from 'node:test';
import assert from 'node:assert/strict';
import {loadFrontend} from './frontendLoader.mjs';
test('ambiguous usernames offer distinct account links',async t=>{
 const Original=globalThis.MessageChannel, channels=[];globalThis.MessageChannel=class extends Original{constructor(){super();channels.push(this)}};t.after(()=>{globalThis.MessageChannel=Original;for(const c of channels){c.port1.close();c.port2.close()}});
 const m=await loadFrontend(`import React from 'react';import {renderToString} from 'react-dom/server';import {ServerAccountChoices} from './src/components/users/ServerAccountChoices';export const render=()=>renderToString(React.createElement(ServerAccountChoices,{server:'plex/plex++',username:'alex',matches:[{uuid:'11111111-1111-4111-8111-111111111111',username:'alex',email:'one@example.test',external_id:'1'},{uuid:'22222222-2222-4222-8222-222222222222',username:'alex',email:'two@example.test',external_id:'2'}]}));`,{mock:{filter:/^@tanstack\/react-router$/,module:()=>`import React from 'react';export const Link=p=>React.createElement('a',{href:p.to.replace('$serverType',p.params.serverType).replace('$serverId',p.params.serverId).replace('$username',p.params.username)+'?id='+p.search.id},p.children);`}});
 const html=m.render();assert.match(html,/Choose an account/);assert.match(html,/one@example.test/);assert.match(html,/two@example.test/);assert.match(html,/users\/alex\?id=11111111-1111-4111-8111-111111111111/);assert.match(html,/users\/alex\?id=22222222-2222-4222-8222-222222222222/);
});
