import {requestJson} from '../util/apiClient';
import {getAccessToken} from '../store/authStore';
import {fetchActivityCurrent,observationProgress,observationPosition} from './activityHistory';
import type {ActiveSession,ActiveSessionsResponse,StreamDisplaySettings} from '../types/streaming';
export type LiveStreamsData=ActiveSessionsResponse & {read_at:string;unavailable_sources:string[];received_at:number};
const tickSeconds=(ticks:string|null)=>ticks===null?undefined:Number(BigInt(ticks)/10000000n);
export async function fetchLiveStreams(actor:string,token:string,signal?:AbortSignal):Promise<LiveStreamsData>{
 signal=AbortSignal.any(signal?[signal,AbortSignal.timeout(15000)]:[AbortSignal.timeout(15000)]);
 const current=()=>{if(getAccessToken()!==token||signal?.aborted)throw Error('Streaming session changed.');};current();
 const sources=await requestJson<{data:{id:number;server_nickname:string}[]}>('/api/servers',{retryAuthentication:false,signal});current();
 if(!Array.isArray(sources.data))throw Error('Invalid streaming sources.');
 const sessions:ActiveSession[]=[],seen=new Set<string>();let cursor: string|undefined;let stamp='';let readAt='';let unavailable:string[]=[];
 for(let n=0;n<10;n++){
  const page=await fetchActivityCurrent(actor,'all',undefined,cursor,signal);current();
  const identity=JSON.stringify(page.servers.map(s=>[s.server_id,s.provider,s.observed_at,s.freshness,s.pending,s.observation_source]));
  if(stamp&&stamp!==identity)throw Error('Streaming observations changed while paging. Refresh.');stamp=identity;readAt=page.read_at;
  unavailable=page.servers.filter(s=>s.freshness!=='fresh').map(s=>sources.data.find(v=>String(v.id)===s.server_id)?.server_nickname??`Server ${s.server_id}`);
  for(const row of page.items){if(seen.has(row.id))throw Error('Duplicate streaming observation.');seen.add(row.id);
   const source=page.servers.find(s=>s.server_id===row.server_id);if(source?.freshness!=='fresh')continue;
   const session:ActiveSession={session_key:`${row.server_id}:${row.id}`,user:row.service_username??row.owner_name??'Unknown user',mum_user_uuid:row.owner_uuid,media_title:row.title,media_type:row.media_type.toLowerCase(),library_name:'Unknown library',service_type:source.provider,server_name:sources.data.find(v=>String(v.id)===row.server_id)?.server_nickname??`Server ${row.server_id}`,state:row.paused?'paused':'playing',progress:observationProgress(row.position_ticks,row.duration_ticks)??0,current_time:observationPosition(row.position_ticks),duration:observationPosition(row.duration_ticks),quality_detail:'Unknown',stream_detail:'Unknown',location_detail:'Unknown',source:source.observation_source??'http'};
   // How old the position was when the server answered; both times are server clock.
   session.position_seconds=tickSeconds(row.position_ticks);session.duration_seconds=tickSeconds(row.duration_ticks);session.observed_age_ms=Math.max(0,Date.parse(page.read_at)-Date.parse(row.last_observed_at));
   Object.assign(session,row.display);
   sessions.push(session);
  }
  if(!page.next_before){const by_server:Record<string,ActiveSession[]>=Object.create(null),by_service:Record<string,ActiveSession[]>=Object.create(null);for(const row of sessions){(by_server[row.server_name]??=[]).push(row);(by_service[row.service_type]??=[]).push(row);}return{sessions,total_count:sessions.length,by_server,by_service,read_at:readAt,unavailable_sources:unavailable,received_at:Date.now()};}cursor=page.next_before;
 }
 throw Error('Streaming observation limit exceeded.');
}

export function readStreamDisplayDefaults(actor?:string):StreamDisplaySettings {
 const fallback:StreamDisplaySettings={default_card_style:'detailed',default_grouping:'merged'};
 if(!actor)return fallback;
 try{const value=JSON.parse(window.localStorage.getItem(`streamDisplaySettings:${actor}`)??'null');return{default_card_style:['detailed','compact'].includes(value?.default_card_style)?value.default_card_style:fallback.default_card_style,default_grouping:['merged','categorized','service'].includes(value?.default_grouping)?value.default_grouping:fallback.default_grouping};}catch{return fallback;}
}

// A server can repeat the same position on many snapshots while another
// session triggers refreshes. Keep an independent estimate for each session
// rather than treating each repeated value as a new playback observation.
export type PlaybackBaseline={received_at:number;seconds:Map<string,number>;reported:Map<string,number>;states:Map<string,string>};
const playing=(s:ActiveSession)=>s.state==='playing'&&s.position_seconds!==undefined;
export function playbackBaseline(data:LiveStreamsData,previous?:PlaybackBaseline):PlaybackBaseline{
 const seconds=new Map<string,number>(),reported=new Map<string,number>(),states=new Map<string,string>();
 for(const s of data.sessions){if(s.position_seconds===undefined)continue;
  let value=s.position_seconds+(s.state==='playing'?(s.observed_age_ms??0)/1000:0);const before=previous?.seconds.get(s.session_key);
  if(playing(s)&&before!==undefined&&previous?.states.get(s.session_key)==='playing'){
   const predicted=before+Math.max(0,data.received_at-previous.received_at)/1000;
   const lastReported=previous.reported.get(s.session_key);
   if(lastReported===s.position_seconds||(lastReported!==undefined&&s.position_seconds>=lastReported&&predicted>value&&predicted-value<=12))value=predicted;
  }
  if(s.duration_seconds!==undefined&&s.duration_seconds>0)value=Math.min(value,s.duration_seconds);
  seconds.set(s.session_key,value);reported.set(s.session_key,s.position_seconds);states.set(s.session_key,s.state);}
 return{received_at:data.received_at,seconds,reported,states};
}
const clock=(total:number)=>{const t=Math.floor(total);return `${Math.floor(t/3600)}:${String(Math.floor(t%3600/60)).padStart(2,'0')}:${String(t%60).padStart(2,'0')}`;};
export function advanceLiveStreams(data:LiveStreamsData,baseline:PlaybackBaseline,now:number):LiveStreamsData{
 const elapsed=Math.max(0,(now-baseline.received_at)/1000);
 const sessions=data.sessions.map(s=>{const base=baseline.seconds.get(s.session_key);if(!playing(s)||base===undefined)return s;
  const value=s.duration_seconds?Math.min(base+elapsed,s.duration_seconds):base+elapsed;
  return{...s,current_time:clock(value),progress:s.duration_seconds?Math.round(value/s.duration_seconds*10000)/100:s.progress};});
 const by_server:Record<string,ActiveSession[]>=Object.create(null),by_service:Record<string,ActiveSession[]>=Object.create(null);
 for(const row of sessions){(by_server[row.server_name]??=[]).push(row);(by_service[row.service_type]??=[]).push(row);}
 return{...data,sessions,by_server,by_service};
}
