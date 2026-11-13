import {validSavedExpiry} from './humanExpiry';
import {isServiceType} from '../config/serviceTypes';
import {requestJson} from '../util/apiClient';
import {getAccessToken} from '../store/authStore';
export type ProfileCapabilities={resetPassword:false;editSettings:false;resync:false;manageLinks:false;overseerr:boolean};
export type UserRoleDetail = {
  name: string;
  color?: string | null;
  icon?: string | null;
  badge_style?: string | null;
  description?: string | null;
};

export type UserDetail = {
  uuid: string;
  username?: string | null;
  display_name?: string | null;
  email?: string | null;
  user_type: string;
  local_username?: string | null;
  external_username?: string | null;
  external_email?: string | null;
  external_user_id?: string | null;
  external_user_alt_id?: string | null;
  created_at?: string | null;
  last_login_at?: string | null;
  last_activity_at?: string | null;
  service_join_date?: string | null;
  access_expires_at?: string | null;
  is_active: boolean;
  notes?: string | null;
  avatar_url?: string | null;
  discord_avatar_url?: string | null;
  discord_username?: string | null;
  discord_user_id?: string | null;
  discord_email?: string | null;
  service_type?: string | null;
  service_types: string[];
  linked_service_count: number;
  server_nickname?: string | null;
  server_names: string[];
  linked_local_user?: {
    uuid: string;
    username?: string | null;
    display_name?: string | null;
    email?: string | null;
  } | null;
  libraries: string[];
  has_all_libraries: boolean;
  allow_downloads: boolean | null;
  allow_4k_transcode: boolean | null;
  is_purge_whitelisted: boolean | null;
  is_discord_bot_whitelisted: boolean | null;
  is_home_user: boolean | null;
  shares_back: boolean | null;
  has_password: boolean | null;
  used_invite: boolean | null;
  force_password_change: boolean | null;
  roles: {
    admin_roles: string[];
    user_roles: string[];
  };
  admin_roles_detail?: UserRoleDetail[];
  user_roles_detail: UserRoleDetail[];
  service_accounts?: Array<{
    uuid: string;
    service_type?: string | null;
    server_name?: string | null;
    external_username?: string | null;
    external_email?: string | null;
    linked_at?: string | null;
  }>;
  capabilities: ProfileCapabilities;
};

const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const text=(v:unknown,max=1024):v is string=>typeof v==='string'&&v.length<=max&&!/[\u0000-\u001f\u007f]/.test(v);
const positive=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0;
const strings=(v:unknown):v is string[]=>Array.isArray(v)&&v.length<=10000&&v.every(x=>text(x,1024))&&new Set(v).size===v.length;
export async function fetchProfileMetadata(actor:string,target:string,signal?:AbortSignal):Promise<UserDetail>{
 if(!uuid(actor)||!uuid(target)||signal?.aborted)throw Error('Invalid profile selection');
 const token=getAccessToken(),abort=new AbortController(),timer=setTimeout(()=>abort.abort(),15000),cancel=()=>abort.abort();signal?.addEventListener('abort',cancel,{once:true});
 try{
  const {data:p}=await requestJson<{data:Record<string,unknown>}>(`/api/users/${target}`,{retryAuthentication:false,signal:abort.signal});
  if(!token||token!==getAccessToken()||abort.signal.aborted||!p||p.uuid!==target||!positive(p.id)||(typeof p.user_type!=='string'||!['owner','local','service'].includes(p.user_type))||!text(p.username,255)||!text(p.display_name,255)||p.email!==null&&!text(p.email,320)||typeof p.is_active!=='boolean'||typeof p.created_at!=='string'||!Number.isFinite(Date.parse(p.created_at))||(typeof p.notes!=='string'||p.notes.length>16384||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(p.notes))||!text(p.server_nickname,255)||typeof p.service_type!=='string'||!Number.isSafeInteger(p.linked_service_count)||Number(p.linked_service_count)<0||!strings(p.admin_roles)||!strings(p.libraries)||typeof p.has_all_libraries!=='boolean'||!Array.isArray(p.user_roles)||p.user_roles.length>1000)throw Error('Invalid profile metadata');
  const service=p.user_type==='service';
  // Human rows carry local account expiry; service rows carry their own service expiry.
  if(!validSavedExpiry(p.access_expires_at))throw Error('Invalid account expiry');
  if(service?(!positive(p.server_id)||!isServiceType(p.service_type)):p.server_id!==null||p.service_type!=='')throw Error('Invalid profile service identity');
  // User and admin roles both carry their display settings (name, colour, icon, style).
  const visuals=(list:unknown):UserRoleDetail[]=>{
   if(!Array.isArray(list)||list.length>1000)throw Error('Invalid role visuals');
   const seen=new Set<string>();
   return list.map(raw=>{
    const r=raw as Record<string,unknown>;
    if(!r||!text(r.name,255)||!r.name||seen.has(r.name)||(r.color!==null&&!text(r.color,128))||(r.icon!==null&&!text(r.icon,128))||(typeof r.badge_style!=='string'||!['default','fill','outline'].includes(r.badge_style))||(r.description!==undefined&&r.description!==null&&!text(r.description,4096)))throw Error('Invalid role visuals');
    seen.add(r.name);return {name:r.name,color:r.color as string|null,icon:r.icon as string|null,badge_style:r.badge_style as string,...(typeof r.description==='string'?{description:r.description}:{})};
   });
  };
  const roles=visuals(p.user_roles);
  const adminRoles=visuals(p.admin_roles_detail);
  const adminNames=p.admin_roles as string[];
  if(adminRoles.length!==adminNames.length||adminRoles.some((r,i)=>r.name!==adminNames[i]))throw Error('Invalid admin role visuals');
  let parent:UserDetail['linked_local_user']=null;
  if(p.linked_local_user!==null){const q=p.linked_local_user as Record<string,unknown>;if(!service||!q||!uuid(q.uuid)||!text(q.username,255)||!text(q.display_name,255))throw Error('Invalid primary account');parent={uuid:q.uuid,username:q.username,display_name:q.display_name};}
  return {uuid:target,user_type:p.user_type as string,username:p.username||null,display_name:p.display_name||null,email:p.email||null,is_active:p.is_active,created_at:p.created_at,notes:p.notes,
   local_username:service?null:p.username||null,external_username:service?p.username||null:null,external_email:service?p.email||null:null,service_type:service?p.service_type:null,server_nickname:service?p.server_nickname:null,service_types:service?[p.service_type]:[],server_names:service&&p.server_nickname?[p.server_nickname]:[],linked_local_user:parent,libraries:p.libraries,has_all_libraries:p.has_all_libraries,
   linked_service_count:p.linked_service_count as number,roles:{admin_roles:p.admin_roles,user_roles:roles.map(r=>r.name)},admin_roles_detail:adminRoles,user_roles_detail:roles,
   allow_downloads:null,allow_4k_transcode:null,is_purge_whitelisted:null,is_discord_bot_whitelisted:null,is_home_user:null,shares_back:null,has_password:null,used_invite:null,force_password_change:null,
   last_login_at:null,last_activity_at:null,access_expires_at:p.access_expires_at,capabilities:{resetPassword:false,editSettings:false,resync:false,manageLinks:false,overseerr:service&&p.service_type==='plex'}};
 }finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
}

