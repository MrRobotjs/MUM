import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const {build}=createRequire(new URL('../frontend/package.json',import.meta.url))('esbuild');
async function load(){
 const r=await build({stdin:{contents:"export {NavServerDetail} from './src/components/layout/NavServerDetail';",resolveDir:fileURLToPath(new URL('../frontend/',import.meta.url))},bundle:true,write:false,format:'esm',platform:'browser',jsx:'automatic',plugins:[{name:'sidebar-boundaries',setup(b){
  b.onResolve({filter:/^react\/jsx-runtime$|^@tanstack\/react-router$|^@fortawesome\/|components\/ui\/sidebar$|hooks\/useServers$/},a=>({path:a.path,namespace:'mock'}));
  b.onLoad({filter:/.*/,namespace:'mock'},a=>{const p=a.path;
   if(p==='react/jsx-runtime')return{contents:'export const jsx=(type,props,key)=>({type,props,key});export const jsxs=jsx;'};
   if(p==='@tanstack/react-router')return{contents:'export const Link="Link";export const useLocation=()=>({pathname:globalThis.serverSidebar.path});'};
   if(p.startsWith('@fortawesome/react'))return{contents:'export const FontAwesomeIcon="Icon";'};
   if(p.startsWith('@fortawesome/'))return{contents:'export const faCircleInfo="info",faDatabase="database",faUsers="users";'};
   if(p.endsWith('useServers'))return{contents:'export const useServerDetail=id=>{globalThis.serverSidebar.requested=id;return{server:globalThis.serverSidebar.server};};'};
   return{contents:['SidebarGroup','SidebarGroupLabel','SidebarMenu','SidebarMenuButton','SidebarMenuItem'].map(n=>`export const ${n}=${JSON.stringify(n)};`).join('')+'export const useSidebar=()=>({isMobile:false,setOpenMobile(){}});'};
  });}}]});
 return import('data:text/javascript;base64,'+Buffer.from(r.outputFiles[0].text).toString('base64')+'#'+Math.random());
}
const walk=n=>n&&typeof n==='object'?[n,...[n.props?.children].flat().flatMap(walk)]:[];
const text=n=>typeof n==='string'?n:[n?.props?.children].flat().filter(Boolean).map(text).join('');

test('server sidebar names the server and links its pages',async()=>{
 const m=await load();
 globalThis.serverSidebar={path:'/admin/servers/4/users',server:{id:4,server_nickname:'Plex++'}};
 let tree=m.NavServerDetail({serverId:4});
 assert.equal(globalThis.serverSidebar.requested,4);
 assert.equal(text(walk(tree).find(n=>n.type==='SidebarGroupLabel')),'Plex++');
 const links=walk(tree).filter(n=>n.type==='Link');
 assert.deepEqual(links.map(l=>[text(l),l.props.to,l.props.params.serverId,l.props.search]),[['Overview','/admin/servers/$serverId','4',undefined],['Users','/admin/servers/$serverId/users','4',undefined],['Libraries','/admin/servers/$serverId/libraries','4',undefined]]);
 assert.deepEqual(walk(tree).filter(n=>n.type==='SidebarMenuButton').map(b=>b.props.isActive),[false,true,false]);
 // The server's base page is Overview; the label falls back until the server loads.
 globalThis.serverSidebar={path:'/admin/servers/4/',server:null};
 tree=m.NavServerDetail({serverId:4});
 assert.equal(text(walk(tree).find(n=>n.type==='SidebarGroupLabel')),'Server 4');
 assert.deepEqual(walk(tree).filter(n=>n.type==='SidebarMenuButton').map(b=>b.props.isActive),[true,false,false]);
});
