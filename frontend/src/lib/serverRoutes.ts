import {useServers} from '../hooks/useServers';

import {serverNicknameSlug,findServerByTypeSlug,serverSettingsSlug,findServerBySettingsSlug} from './serverNickname';
export function useServerRoutes() {
 const {servers,loading,error,refresh}=useServers();
 const slugFor=(id:number|string)=>{const server=servers.find(s=>String(s.id)===String(id));return server?`${server.service_type}/${serverNicknameSlug(server.server_nickname)}`:undefined;};
 const serverFor=(address:string)=>{const [type,slug]=address.split("/");return findServerByTypeSlug(servers,type,slug);};
 // Older names can normalize to the same key or contain characters that new
 // nicknames no longer accept. Settings keeps those servers individually
 // editable until an administrator chooses an unambiguous name.
 const settingsSlug=(server:{id:number;server_nickname:string;service_type?:string})=>{
  return serverSettingsSlug(servers.filter(s=>s.service_type===server.service_type),server);
 };
 const settingsServerFor=(slug:string,type:string)=>findServerBySettingsSlug(servers.filter(s=>s.service_type===type),slug);
 return {servers,loading,error,refresh,slugFor,serverFor,settingsSlug,settingsServerFor};
}
