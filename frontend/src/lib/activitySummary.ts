import {requestJson} from '../util/apiClient';
import {getAccessToken} from '../store/authStore';
import {activityID,type ActivityScope,type ActivityServerStatus} from './activityHistory';
export type ObservationCounts={recorded_observations:string;ended_observations:string;retained_current_observations:string;fresh_current_observations:string};
export type ObservationSummary=ObservationCounts&{actor_uuid:string;scope:ActivityScope;read_at:string;servers:(ActivityServerStatus&ObservationCounts)[];target_uuid?:string};
const keys=['recorded_observations','ended_observations','retained_current_observations','fresh_current_observations'] as const;
const count=(v:unknown):v is string=>typeof v==='string'&&/^(0|[1-9][0-9]{0,18})$/.test(v)&&BigInt(v)<=9223372036854775807n;
function counts(p:ObservationCounts):ObservationCounts{
  if(!p||keys.some(k=>!count(p[k]))||BigInt(p.ended_observations)>BigInt(p.recorded_observations)||BigInt(p.retained_current_observations)>BigInt(p.recorded_observations)-BigInt(p.ended_observations)||BigInt(p.fresh_current_observations)>BigInt(p.retained_current_observations))throw Error('Invalid observation counts');
  return {recorded_observations:p.recorded_observations,ended_observations:p.ended_observations,retained_current_observations:p.retained_current_observations,fresh_current_observations:p.fresh_current_observations};
}
async function readActivitySummary(actor:string,scope:ActivityScope='own',signal?:AbortSignal,target?:string):Promise<ObservationSummary>{
  if(!['own','all'].includes(scope)||signal?.aborted)throw Error('Invalid summary scope');
  const token=getAccessToken(),abort=new AbortController(),timer=setTimeout(()=>abort.abort(),15000),cancel=()=>abort.abort();signal?.addEventListener('abort',cancel,{once:true});
  try{
    const {data:p}=await requestJson<{data:ObservationSummary}>(`/api/activity/${target?`identities/${target}/`:""}summary?scope=${scope}`,{retryAuthentication:false,signal:abort.signal});
    if(!token||token!==getAccessToken()||abort.signal.aborted||p?.actor_uuid!==actor||p.scope!==scope||p.target_uuid!==target||typeof p.read_at!=='string'||!Number.isFinite(Date.parse(p.read_at))||!Array.isArray(p.servers)||p.servers.length>1000)throw Error('Summary unavailable');
    const total=counts(p),seen=new Set<string>(),sums=[0n,0n,0n,0n];
    const servers=p.servers.map(s=>{
      if(!s||!activityID(s.server_id)||seen.has(s.server_id)||!['jellyfin','emby','plex'].includes(s.provider)||s.observed_at!==null&&(typeof s.observed_at!=='string'||!Number.isFinite(Date.parse(s.observed_at)))||s.age_seconds!==null&&(!Number.isSafeInteger(s.age_seconds)||s.age_seconds<0)||(s.observed_at===null)!==(s.age_seconds===null)||!['never','fresh','stale','invalidated','failed','disabled'].includes(s.freshness)||!['none','running','expired'].includes(s.pending)||!['never','fresh','failed'].includes(s.last_result))throw Error('Invalid summary source');
      const c=counts(s);if(s.freshness!=='fresh'&&c.fresh_current_observations!=='0')throw Error('Unfresh source counted fresh');
      seen.add(s.server_id);keys.forEach((k,i)=>sums[i]+=BigInt(c[k]));
      return {...c,server_id:s.server_id,provider:s.provider,observed_at:s.observed_at,age_seconds:s.age_seconds,freshness:s.freshness,pending:s.pending,last_result:s.last_result};
    });
    if(keys.some((k,i)=>sums[i]!==BigInt(total[k])))throw Error('Inconsistent summary total');
    return {...total,actor_uuid:actor,scope,read_at:p.read_at,servers,...(target?{target_uuid:target}:{})};
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
}

export const fetchActivitySummary=(actor:string,scope:ActivityScope='own',signal?:AbortSignal)=>readActivitySummary(actor,scope,signal);
export function fetchIdentitySummary(actor:string,target:string,scope:ActivityScope='own',signal?:AbortSignal){
  if(typeof target!=='string'||! /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(target))return Promise.reject(Error('Invalid target identity'));
  return readActivitySummary(actor,scope,signal,target);
}
