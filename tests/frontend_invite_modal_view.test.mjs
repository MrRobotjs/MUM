import assert from 'node:assert/strict';
import test from 'node:test';
import {loadFrontend} from './frontendLoader.mjs';

// Renders the invite dialog without a browser: React is replaced by a small
// hook harness and UI components by their names, so the tree can be inspected.
function load(){
 return loadFrontend("export {InviteModal} from './src/components/invites/InviteModal';export {setAccessToken} from './src/store/authStore';",{mock:{filter:/^react(?:\/jsx-runtime)?$|\/ui\/|^@\/components$|store\/mediaQueryStore$|@fortawesome\/react-fontawesome/,module:path=>(({path:p})=>{
  if(p==='react/jsx-runtime')return{contents:'export const jsx=(type,props,key)=>({type,props,key});export const jsxs=jsx;export const Fragment="fragment";'};
  if(p==='react')return{contents:'export const useState=(v)=>globalThis.inviteView.state(v);export const useEffect=(f,d)=>globalThis.inviteView.effect(f,d);export const useMemo=(f)=>f();'};
  if(p.endsWith('mediaQueryStore'))return{contents:'export const useMediaQuery=()=>globalThis.inviteDesktop===true;'};
  if(p==='@/components')return{contents:'export const ServiceIcon="ServiceIcon";'};
  const names=p.endsWith('/collapsible')?['Collapsible','CollapsibleContent','CollapsibleTrigger']:p.endsWith('react-fontawesome')?['FontAwesomeIcon']:p.endsWith('/responsive-dialog')?['ResponsiveDialog']:[p.split('/').at(-1).replace(/^./,x=>x.toUpperCase())];
  return{contents:names.map(n=>`export const ${n}=${JSON.stringify(n)};`).join('')};
 })({path}).contents}});
}
function nodes(n){return n==null?[]:Array.isArray(n)?n.flatMap(nodes):typeof n==='object'?[n,...nodes(n.props?.children),...nodes(n.props?.footer)]:[n];}
function harness(Component,props){const slots=[],effects=[];let cursor=0,dirty=true,tree;const equal=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]));const h={state(v){const i=cursor++;if(!(i in slots))slots[i]=typeof v==='function'?v():v;return[slots[i],next=>{const value=typeof next==='function'?next(slots[i]):next;if(!Object.is(value,slots[i])){slots[i]=value;dirty=true;}}];},effect(f,deps){const i=cursor++;if(!equal(slots[i]?.deps,deps)){effects.push(()=>{slots[i]?.cleanup?.();slots[i]={deps,cleanup:f()};});}},async flush(){for(let i=0;i<30;i++){await new Promise(r=>setImmediate(r));if(dirty){dirty=false;cursor=0;globalThis.inviteView=h;tree=Component(props);for(const f of effects.splice(0))f();}else if(i>2)break;}return tree;},cleanup(){for(const slot of slots)slot?.cleanup?.();}};return h;}
function environment(t){const keys=['window','document','fetch','inviteView','inviteDesktop'];const old=Object.fromEntries(keys.map(k=>[k,globalThis[k]]));t.after(()=>Object.assign(globalThis,old));globalThis.window={location:{origin:'http://mum.test'}};globalThis.document={visibilityState:'visible'};globalThis.fetch=async()=>Response.json({data:[]});}
const text=(tree,value)=>nodes(tree).some(n=>typeof n==='string'&&n.includes(value));

// On a desktop the form is split into sections in a sidebar with a live
// summary; Servers & libraries opens first and is marked while no server is
// chosen, other sections keep the same fields, and a refused save says why.
test('desktop invite form uses section sidebar and shows why it cannot save',async t=>{environment(t);globalThis.inviteDesktop=true;const m=await load();m.setAccessToken('session');
 let submitted=0;const h=harness(m.InviteModal,{open:true,onClose(){},onSubmit(){submitted++;}});t.after(()=>h.cleanup());let tree=await h.flush();
 const nav=nodes(tree).find(n=>n.props?.['aria-label']==='Invite sections');assert.ok(nav,'sidebar');
 const buttons=nodes(nav).filter(n=>n.type==='button');assert.deepEqual(buttons.map(b=>nodes(b).find(x=>typeof x==='string')),['Link','Servers & libraries','Limits','Discord','Protection']);
 const current=buttons.filter(b=>b.props['aria-current']==='true');assert.equal(current.length,1);assert.ok(nodes(current[0]).includes('Servers & libraries'));
 assert.ok(nodes(buttons[1]).some(n=>n.props?.title==='Needs attention'),'servers marked while none chosen');
 for(const label of ['Servers','Libraries','Expires','Max Uses'])assert.ok(text(tree,label),`summary ${label}`);
 buttons[2].props.onClick();tree=await h.flush();
 for(const field of ['Invite Expiration','Maximum Uses','Membership Expiration'])assert.ok(text(tree,field),`limits ${field}`);
 assert.ok(!text(tree,'Custom Path'),'one section at a time');
 const save=nodes(tree).find(n=>n.type==='Button'&&n.key==='submit');await save.props.onClick();tree=await h.flush();
 assert.equal(submitted,0);assert.ok(nodes(tree).some(n=>n.props?.role==='alert'&&nodes(n).some(x=>typeof x==='string'&&x.includes('select at least one server'))),'save refusal shown');
});

// Tablets and phones keep one scrolling form with every section stacked.
test('stacked invite form keeps every section in one scroll',async t=>{environment(t);const m=await load();m.setAccessToken('session');
 const h=harness(m.InviteModal,{open:true,onClose(){},onSubmit(){}});t.after(()=>h.cleanup());const tree=await h.flush();
 assert.ok(!nodes(tree).some(n=>n.props?.['aria-label']==='Invite sections'));
 for(const field of ['Custom Path','Servers & libraries','Invite Expiration','Maximum Uses','Advanced Options'])assert.ok(text(tree,field),field);
});
