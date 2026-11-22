import {useEffect, useRef, useState, useSyncExternalStore} from 'react';
import useSWR from 'swr';
import {requestJson} from '../../util/apiClient';
import {getAccessToken,getAuthSnapshot,subscribeToAuthStore} from '../../store/authStore';
import {Card,CardContent,CardDescription,CardHeader,CardTitle} from '../ui/card';
import {Button} from '../ui/button';
import {Checkbox} from '../ui/checkbox';
import {Input} from '../ui/input';
import {Label} from '../ui/label';

type Settings={revision:number;server_revision:number;users_interval_hours:number;libraries_interval_hours:number;users_on_startup:boolean;libraries_on_startup:boolean;include_episodes_and_tracks:boolean};
function validSettings(v:Settings):boolean { return Boolean(v && Number.isSafeInteger(v.revision) && v.revision>0 && Number.isSafeInteger(v.server_revision) && v.server_revision>=0 && Number.isSafeInteger(v.users_interval_hours) && v.users_interval_hours>=1 && v.users_interval_hours<=8760 && Number.isSafeInteger(v.libraries_interval_hours) && v.libraries_interval_hours>=1 && v.libraries_interval_hours<=8760 && typeof v.users_on_startup==='boolean' && typeof v.libraries_on_startup==='boolean' && typeof v.include_episodes_and_tracks==='boolean'); }
export function ServerRefreshSettings({serverId}:{serverId:number}) {
 const token=useSyncExternalStore(subscribeToAuthStore,getAuthSnapshot).accessToken, url=`/api/servers/${serverId}/refresh-settings`, key=token?[url,token] as const:null;
 const {data,error,isLoading,mutate}=useSWR(key,async ([path,expected])=>{const {data}=await requestJson<{data:Settings}>(path,{retryAuthentication:false});if(getAccessToken()!==expected || !validSettings(data))throw Error('Refresh settings unavailable');return data},{keepPreviousData:false});
 const [draft,setDraft]=useState<Settings|null>(null),[pending,setPending]=useState(false),[message,setMessage]=useState(''),[uncertain,setUncertain]=useState(false);
 const admitted=useRef(false), active=useRef(true), identity=useRef(`${token}:${serverId}`); identity.current=`${token}:${serverId}`;
 useEffect(()=>{active.current=true;return()=>{active.current=false}},[]);
 useEffect(()=>{setDraft(data??null);setMessage('')},[data,serverId,token]);
 useEffect(()=>{setPending(false);setUncertain(false)},[serverId,token]);
 async function save(){
  if(!draft||!key||uncertain||admitted.current||!Number.isSafeInteger(draft.users_interval_hours)||!Number.isSafeInteger(draft.libraries_interval_hours)||draft.users_interval_hours<1||draft.users_interval_hours>8760||draft.libraries_interval_hours<1||draft.libraries_interval_hours>8760)return;
  const start=identity.current;admitted.current=true;setPending(true);setMessage('');
  try{await requestJson(url,{method:'PUT',retryAuthentication:false,body:JSON.stringify(draft)});if(active.current&&identity.current===start&&getAccessToken()===token){await mutate();if(active.current&&identity.current===start&&getAccessToken()===token)setMessage('Refresh settings saved.')}}
  catch{if(active.current&&identity.current===start&&getAccessToken()===token){setUncertain(true);setMessage('Could not confirm the save. Refresh the page and inspect the settings before trying again.');}}
  finally{admitted.current=false;if(active.current&&identity.current===start&&getAccessToken()===token)setPending(false)}
 }
 return <Card><CardHeader><CardTitle>Automatic synchronization</CardTitle><CardDescription>Refresh users and libraries independently while MUM is running.</CardDescription></CardHeader><CardContent className="space-y-4">
 {error?<p>Refresh settings are unavailable.</p>:isLoading||!data||!draft?<p>Loading refresh settings...</p>:<>
 <div className="space-y-2"><Label htmlFor="users-refresh-hours">Users List Refresh Interval (hours)</Label><Input id="users-refresh-hours" type="number" min={1} max={8760} value={draft.users_interval_hours} disabled={pending} onChange={e=>setDraft({...draft,users_interval_hours:Number(e.target.value)})}/></div>
 <div className="space-y-2"><Label htmlFor="libraries-refresh-hours">Libraries List Refresh Interval (hours)</Label><Input id="libraries-refresh-hours" type="number" min={1} max={8760} value={draft.libraries_interval_hours} disabled={pending} onChange={e=>setDraft({...draft,libraries_interval_hours:Number(e.target.value)})}/></div>
 {([['users_on_startup','Refresh Users List on Startup'],['libraries_on_startup','Refresh Libraries List on Startup'],['include_episodes_and_tracks','Include TV Episodes and Music Tracks']] as const).map(([field,label])=><div className="flex items-center gap-2" key={field}><Checkbox id={field} checked={draft[field]} disabled={pending} onCheckedChange={value=>setDraft({...draft,[field]:value===true})}/><Label htmlFor={field}>{label}</Label></div>)}
 <p className="text-sm text-muted-foreground">Episode and track refresh applies to supported TV and music libraries. Both lists are refreshed automatically while the server is active.</p>
 {message&&<p role="status" className="text-sm text-muted-foreground">{message}</p>}
 <Button type="button" onClick={()=>void save()} disabled={pending||uncertain||!Number.isSafeInteger(draft.users_interval_hours)||!Number.isSafeInteger(draft.libraries_interval_hours)||draft.users_interval_hours<1||draft.users_interval_hours>8760||draft.libraries_interval_hours<1||draft.libraries_interval_hours>8760}>{pending?'Saving...':'Save refresh settings'}</Button>
 </>}
 </CardContent></Card>;
}
