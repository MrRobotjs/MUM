import {useServers} from '../hooks/useServers';

import {serverNicknameSlug,findServerBySlug,serverSettingsSlug,findServerBySettingsSlug} from './serverNickname';
export function useServerRoutes() {
 const {servers,loading,error,refresh}=useServers();
 const slugFor=(id:number|string)=>{const server=servers.find(s=>String(s.id)===String(id));return server?serverNicknameSlug(server.server_nickname):undefined;};
 const serverFor=(slug:string)=>findServerBySlug(servers,slug);
 // Older names can normalize to the same key or contain characters that new
 // nicknames no longer accept. Settings keeps those servers individually
 // editable until an administrator chooses an unambiguous name.
 const settingsSlug=(server:{id:number;server_nickname:string})=>{
  return serverSettingsSlug(servers,server);
 };
 const settingsServerFor=(slug:string)=>findServerBySettingsSlug(servers,slug);
 return {servers,loading,error,refresh,slugFor,serverFor,settingsSlug,settingsServerFor};
}
