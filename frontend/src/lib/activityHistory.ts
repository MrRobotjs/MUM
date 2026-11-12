import {requestJson} from '../util/apiClient';
import {getAccessToken} from '../store/authStore';
import {readActivityDisplay,type ActivityStreamDisplay} from './activityDisplay';

export type ActivityScope = 'own' | 'all';
export type ActivityHistoryRow = {
  display?:ActivityStreamDisplay;
  id: string; server_id: string; service_uuid: string; owner_uuid?: string;
  item_id: string; media_type: string; title: string; first_observed_at: string;
  owner_name?: string; service_username?: string;
  last_observed_at: string; ended_observation_at: string | null; end_reason: string | null;
  paused: boolean; position_ticks: string | null; duration_ticks: string | null;
  // History presentation kept with each play (history rows only).
  parent_title?: string; library_name?: string; client?: string;
  play_method?: 'direct_play'|'direct_stream'|'transcode'; poster_url?: string;
};
export type ActivityServerStatus = {server_id: string; provider: string; observed_at: string | null;
  observation_source?:'http'|'ws';age_seconds: number | null; freshness: string; pending: string; last_result: string};
export type ActivityHistoryPage = {actor_uuid: string; scope: ActivityScope; read_at: string;
  items: ActivityHistoryRow[]; servers: ActivityServerStatus[]; next_before: string | null; target_uuid?:string};
export const activityID = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,18}$/.test(v) && BigInt(v) <= 9223372036854775807n;
const ticks = (v: unknown): v is string | null => v === null || typeof v === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(v) && BigInt(v) <= 9223372036854775807n;
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const date = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && v.trim() === v && !/[\u0000-\u001f\u007f]/.test(v);

async function readActivityPage(kind: 'history'|'current', actor: string, scope: ActivityScope, server?: string, before?: string, signal?: AbortSignal, target?:string): Promise<ActivityHistoryPage> {
  if (!uuid(actor) || target !== undefined && !uuid(target) || !['own', 'all'].includes(scope) || server !== undefined && !activityID(server) || before !== undefined && !activityID(before) || signal?.aborted) throw Error('Invalid history selection.');
  const token = getAccessToken(), query = new URLSearchParams({scope});
  if (server) query.set('server', server); if (before) query.set('before', before);
  const {data: p} = await requestJson<{data: ActivityHistoryPage}>(`/api/activity/${target?`identities/${target}/`:""}${kind}?${query}`, {signal, retryAuthentication: false});
  if (!token || token !== getAccessToken() || signal?.aborted || p?.actor_uuid !== actor || p.scope !== scope || p.target_uuid !== target || !date(p.read_at) || !Array.isArray(p.items) || p.items.length > 100 || !Array.isArray(p.servers) || p.servers.length > 1000 || p.next_before !== null && !activityID(p.next_before)) throw Error('History is unavailable. Refresh.');
  const servers: ActivityServerStatus[] = [], known = new Set<string>();
  for (const s of p.servers) {
    if (!s || s.observation_source!==undefined&&!['http','ws'].includes(s.observation_source) || !activityID(s.server_id) || known.has(s.server_id) || server && s.server_id !== server || !['jellyfin', 'emby', 'plex'].includes(s.provider) || s.observed_at !== null && !date(s.observed_at) || s.age_seconds !== null && (!Number.isSafeInteger(s.age_seconds) || s.age_seconds < 0) || (s.observed_at === null) !== (s.age_seconds === null) || !['never','fresh','stale','invalidated','failed','disabled'].includes(s.freshness) || !['none','running','expired'].includes(s.pending) || !['never','fresh','failed'].includes(s.last_result)) throw Error('Invalid history freshness.');
    known.add(s.server_id); servers.push({observation_source:s.observation_source??'http',server_id:s.server_id,provider:s.provider,observed_at:s.observed_at,age_seconds:s.age_seconds,freshness:s.freshness,pending:s.pending,last_result:s.last_result});
  }
  const items: ActivityHistoryRow[] = []; let previous = before ? BigInt(before) : 9223372036854775808n;
  for (const row of p.items) {
    if (!row || kind === 'current' && (row.ended_observation_at !== null || row.end_reason !== null) || !activityID(row.id) || BigInt(row.id) >= previous || !known.has(row.server_id) || server && row.server_id !== server || !uuid(row.service_uuid) || scope === 'own' && row.owner_uuid !== undefined || row.owner_uuid !== undefined && !uuid(row.owner_uuid) || !text(row.item_id,256) || !text(row.title,1024) || !['Movie','Episode','Audio','Video','MusicVideo','Trailer'].includes(row.media_type) || !date(row.first_observed_at) || !date(row.last_observed_at) || Date.parse(row.first_observed_at) > Date.parse(row.last_observed_at) || Date.parse(row.last_observed_at) > Date.parse(p.read_at) + 1000 || row.ended_observation_at !== null && (!date(row.ended_observation_at) || Date.parse(row.ended_observation_at) < Date.parse(row.last_observed_at)) || (row.ended_observation_at === null) !== (row.end_reason === null) || row.end_reason !== null && !['not_observed','item_changed','identity_changed','ownership_changed'].includes(row.end_reason) || typeof row.paused !== 'boolean' || !ticks(row.position_ticks) || !ticks(row.duration_ticks) || row.position_ticks !== null && row.duration_ticks !== null && BigInt(row.position_ticks) > BigInt(row.duration_ticks)) throw Error('Invalid history observation.');
    previous = BigInt(row.id);
    if (row.owner_name !== undefined && (scope !== 'all' || !text(row.owner_name, 255)) || row.service_username !== undefined && (scope !== 'all' || !text(row.service_username, 255))) throw Error('Invalid history record.');
    if(row.display!==undefined&&(scope!=='all'||kind!=='current'))throw Error('Private stream details outside administrative current view.');
    const presentation:Pick<ActivityHistoryRow,'parent_title'|'library_name'|'client'|'play_method'|'poster_url'>={};
    for(const key of ['parent_title','library_name','client'] as const){const v=row[key];if(v!==undefined){if(kind!=='history'||!text(v,1024))throw Error('Invalid history record.');presentation[key]=v;}}
    if(row.play_method!==undefined){if(kind!=='history'||!['direct_play','direct_stream','transcode'].includes(row.play_method))throw Error('Invalid history record.');presentation.play_method=row.play_method;}
    // Posters are signed administrator links to this exact row.
    if(row.poster_url!==undefined){if(kind!=='history'||scope!=='all'||typeof row.poster_url!=='string'||row.poster_url.length>2048||!row.poster_url.startsWith(`/api/activity/history-images/${row.id}?`)||/[#\s]/.test(row.poster_url))throw Error('Invalid history poster.');presentation.poster_url=row.poster_url;}
    items.push({...(row.display!==undefined?{display:readActivityDisplay(row.display)}:{}),id:row.id,server_id:row.server_id,service_uuid:row.service_uuid,...(row.owner_uuid ? {owner_uuid:row.owner_uuid} : {}),...(row.owner_name ? {owner_name:row.owner_name} : {}),...(row.service_username ? {service_username:row.service_username} : {}),item_id:row.item_id,media_type:row.media_type,title:row.title,first_observed_at:row.first_observed_at,last_observed_at:row.last_observed_at,ended_observation_at:row.ended_observation_at,end_reason:row.end_reason,paused:row.paused,position_ticks:row.position_ticks,duration_ticks:row.duration_ticks,...presentation});
  }
  if (p.next_before !== null && (items.length !== 100 || p.next_before !== items[99].id)) throw Error('Invalid history cursor.');
  return {actor_uuid:actor,scope,read_at:p.read_at,items,servers,next_before:p.next_before,...(target?{target_uuid:target}:{})};
}

export async function fetchActivityHistory(actor:string,scope:ActivityScope='own',server?:string,before?:string,signal?:AbortSignal):Promise<ActivityHistoryPage>{
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),15000);
  const cancel=()=>abort.abort();if(signal?.aborted)abort.abort();signal?.addEventListener('abort',cancel,{once:true});
  try{return await readActivityPage('history',actor,scope,server,before,abort.signal);}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
}

export async function fetchActivityCurrent(actor:string,scope:ActivityScope='own',server?:string,before?:string,signal?:AbortSignal):Promise<ActivityHistoryPage>{
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),15000);
  const cancel=()=>abort.abort();if(signal?.aborted)abort.abort();signal?.addEventListener('abort',cancel,{once:true});
  try{return await readActivityPage('current',actor,scope,server,before,abort.signal);}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
}

// Administrator (all) scope rows carry display names; own scope keeps identifiers only.
export function observationAccountLabels(row:{owner_uuid?:string;owner_name?:string;service_uuid:string;service_username?:string},scope:ActivityScope):{owner:string;account:string}{
  if(scope==='own')return {owner:'Your linked account',account:row.service_uuid};
  return {owner:row.owner_name??row.owner_uuid??'No primary owner recorded',account:row.service_username??row.service_uuid};
}
export function observationPosition(ticks:string|null):string{
  if(ticks===null)return 'Unknown';
  const seconds=BigInt(ticks)/10000000n,hours=seconds/3600n,minutes=seconds%3600n/60n,remainder=seconds%60n;
  return `${hours}:${String(minutes).padStart(2,'0')}:${String(remainder).padStart(2,'0')}`;
}

export function observationProgress(position:string|null,duration:string|null):number|null{
  if(position===null||duration===null||BigInt(duration)===0n)return null;
  return Number(BigInt(position)*10000n/BigInt(duration))/100;
}

export async function fetchIdentityHistory(actor:string,target:string,scope:ActivityScope='own',before?:string,signal?:AbortSignal):Promise<ActivityHistoryPage>{
  if(!uuid(target))throw Error('Invalid target identity');
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),15000),cancel=()=>abort.abort();
  if(signal?.aborted)abort.abort();signal?.addEventListener('abort',cancel,{once:true});
  try{return await readActivityPage('history',actor,scope,undefined,before,abort.signal,target);}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
}

export async function fetchIdentityCurrent(actor:string,target:string,scope:ActivityScope='own',before?:string,signal?:AbortSignal):Promise<ActivityHistoryPage>{
  if(!uuid(target))throw Error('Invalid target identity');
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),15000),cancel=()=>abort.abort();
  if(signal?.aborted)abort.abort();signal?.addEventListener('abort',cancel,{once:true});
  try{return await readActivityPage('current',actor,scope,undefined,before,abort.signal,target);}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
}
