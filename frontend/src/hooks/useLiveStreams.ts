import {useEffect,useSyncExternalStore} from 'react';
import useSWR from 'swr';
import {useAuth} from '../contexts/AuthContext';
import {getAccessToken,getAuthSnapshot,subscribeToAuthStore} from '../store/authStore';
import {fetchLiveStreams} from '../lib/liveStreams';
import {onConnectionChange,getRealtimeState} from '../lib/realtimeSocket';
import {watchActivity} from '../lib/activityRealtime';
const subscribeConnection=(changed:()=>void)=>onConnectionChange(()=>changed());
const readConnection=()=>getRealtimeState().connected;
export function useLiveStreams(){
 const connected=useSyncExternalStore(subscribeConnection,readConnection,()=>false);
 const {user,isAdministrator}=useAuth();const auth=useSyncExternalStore(subscribeToAuthStore,getAuthSnapshot,getAuthSnapshot),token=auth.accessToken;
 const actor=isAdministrator?user?.uuid:undefined;
 const state=useSWR(actor&&token?['current-streams',actor,token]:null,async([,id,session]:string[])=>{const data=await fetchLiveStreams(id,session);return{data,token:session};},{refreshInterval:connected?0:5000,keepPreviousData:false,shouldRetryOnError:false});
 useEffect(()=>{if(actor&&token)return watchActivity(actor,'all',()=>{void state.mutate().catch(()=>{});});},[actor,token,state.mutate]);
 return{actor,isConnected:Boolean(actor&&token&&connected),scopeKey:`${actor??"anonymous"}:${token??""}`,data:actor&&!state.error&&state.data?.token===token&&token===getAccessToken()?state.data.data:undefined,loading:state.isLoading,error:state.error,refresh:state.mutate};
}
