import {requestJson} from '../util/apiClient';import {getAccessToken} from '../store/authStore';
import {writeLocalCounter} from '../util/preferences';
export type AccountPreferences={user_uuid:string;profile_revision:number;sync_enabled:boolean;preferences:{stream_counter:boolean}};
export function preferenceRecord(value:unknown,user:string):AccountPreferences{
 const p=value as AccountPreferences;
 if(!p || p.user_uuid!==user || !Number.isSafeInteger(p.profile_revision) || p.profile_revision<1 || typeof p.sync_enabled!=='boolean' || !p.preferences || typeof p.preferences.stream_counter!=='boolean')throw Error('Invalid own-preference response');
 return {user_uuid:p.user_uuid,profile_revision:p.profile_revision,sync_enabled:p.sync_enabled,preferences:{stream_counter:p.preferences.stream_counter}};
}
export async function fetchOwnPreferences(user:string,signal?:AbortSignal){const{data}=await requestJson<{data:unknown}>('/api/account/preferences',{signal,retryAuthentication:!signal});return preferenceRecord(data,user);}
export async function confirmPreferenceState(current:AccountPreferences,signal?:AbortSignal){
 const token=getAccessToken();const fresh=await fetchOwnPreferences(current.user_uuid,signal);
 if(signal?.aborted || !token || token!==getAccessToken() || fresh.profile_revision!==current.profile_revision || fresh.sync_enabled!==current.sync_enabled || fresh.preferences.stream_counter!==current.preferences.stream_counter)throw Error('Your account or preferences changed. Refresh before saving.');
 return token;
}
const saving=new Set<string>();
export async function saveDevicePreference(current:AccountPreferences,counter:boolean){
 const original=preferenceRecord(current,current.user_uuid);
 if(original.sync_enabled || typeof counter!=='boolean' || saving.has(original.user_uuid))throw Error('Refresh preferences or wait for the current save.');
 saving.add(original.user_uuid);
 const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),15000);
 try{await confirmPreferenceState(original,abort.signal);writeLocalCounter(original.user_uuid,counter);}finally{clearTimeout(timer);saving.delete(original.user_uuid);}
}
export async function saveOwnPreferences(current:AccountPreferences,sync:boolean,counter:boolean){
 const original=preferenceRecord(current,current.user_uuid);
 if(typeof sync!=='boolean' || typeof counter!=='boolean')throw Error('Unsupported preference value');
 if(saving.has(original.user_uuid))throw Error('Preferences are already being saved.');
 saving.add(original.user_uuid);
 const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),15000);
 try{
  const token=await confirmPreferenceState(original,abort.signal);
  const {data}=await requestJson<{data:unknown}>('/api/account/preferences',{method:'PUT',signal:abort.signal,retryAuthentication:false,body:JSON.stringify({expected_user_uuid:original.user_uuid,profile_revision:original.profile_revision,sync_enabled:sync,preferences:{stream_counter:counter}})});
  const result=preferenceRecord(data,original.user_uuid);
  if(abort.signal.aborted || token!==getAccessToken() || result.profile_revision!==original.profile_revision+1 || result.sync_enabled!==sync || result.preferences.stream_counter!==counter)throw Error('Unconfirmed preference result');
  return result;
 }catch{throw Error('Preference save could not be confirmed. Refresh before another attempt. No request was replayed.');}
 finally{clearTimeout(timer);saving.delete(original.user_uuid);}
}
