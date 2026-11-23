// The URL key mirrors the nickname normalization enforced by the server.
export const serverNicknameSlug=(name:string)=>name.trim().split(/ +/).join('-').toLowerCase();
export const serverNicknameIssue=(name:string)=>/^[A-Za-z0-9 _+-]+$/.test(name.trim()) && /[A-Za-z0-9]/.test(name) ? '' : 'Use letters, numbers, spaces, hyphens, underscores or plus signs, including at least one letter or number.';
export const serverProfileMatches=(server:{id:number}|undefined, user:{user_type:string;server_id:number|null})=>Boolean(server && user.user_type==='service' && user.server_id===server.id);
export function findServerBySlug<T extends {server_nickname:string}>(servers:readonly T[], slug:string):T|undefined {
 const matches=servers.filter(server=>serverNicknameSlug(server.server_nickname)===slug);
 return matches.length===1?matches[0]:undefined;
}
export function serverSettingsSlug<T extends {id:number;server_nickname:string}>(servers:readonly T[], server:T):string {
 const slug=serverNicknameSlug(server.server_nickname);
 return !serverNicknameIssue(server.server_nickname) && findServerBySlug(servers,slug)?.id===server.id ? slug : `~${server.id}`;
}
export function findServerBySettingsSlug<T extends {id:number;server_nickname:string}>(servers:readonly T[],slug:string):T|undefined {
 if (!/^~[1-9]\d*$/.test(slug)) return findServerBySlug(servers,slug);
 const server=servers.find(item=>String(item.id)===slug.slice(1));
 return server && serverSettingsSlug(servers,server)===slug ? server : undefined;
}

// Resolve provider-qualified URLs only when they identify exactly one server.
export function findServerByTypeSlug<T extends {service_type:string;server_nickname:string}>(servers:readonly T[], type:string, slug:string):T|undefined {
 const matches=servers.filter(server=>server.service_type===type && serverNicknameSlug(server.server_nickname)===slug);
 return matches.length===1?matches[0]:undefined;
}
