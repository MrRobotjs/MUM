/** The current profile is the only child shown under a server's Users item. */
export function serverUserNav(usersPath:string, pathname:string, expanded:boolean) {
 const segment=pathname.startsWith(`${usersPath}/`)?pathname.slice(usersPath.length+1):'';
 let username='';
 if(segment&&!segment.includes('/')) { try { username=decodeURIComponent(segment) } catch { username=segment } }
 return {username,usersActive:pathname===usersPath||Boolean(username)&&!expanded,iconActive:Boolean(username)};
}
