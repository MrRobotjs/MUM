import {useEffect, useState, useSyncExternalStore} from 'react';
import useSWR from 'swr';
import {useAuth} from '../contexts/AuthContext';
import {getAuthSnapshot,subscribeToAuthStore} from '../store/authStore';
import {fetchServerTimeline,type TimelineFilters,type TimelineRecords} from '../lib/identityTimeline';
import {watchHistory} from '../lib/historyRealtime';
import {getRealtimeState,onConnectionChange} from '../lib/realtimeSocket';

const subscribeConnection=(changed:()=>void)=>onConnectionChange(()=>changed());
const readConnection=()=>getRealtimeState().connected;

// Everyone's plays on one server with Newer/Older paging, for a server's
// History tab and the History page. Changing the server, person, records,
// filters or session starts from the newest. Without a server the reply picks
// the one with the newest play. While a change loads, the previous page stays
// with `pending` set.
export function useServerTimeline(server:string|undefined,user:string|undefined,records:TimelineRecords,filters:TimelineFilters,enabled=true){
  const {user:me,isAdministrator}=useAuth();
  const session=useSyncExternalStore(subscribeToAuthStore,getAuthSnapshot);
  const connected=useSyncExternalStore(subscribeConnection,readConnection,()=>false);
  const actor=enabled&&isAdministrator&&session.accessToken?me?.uuid:undefined;
  const types=filters.types.join(','),methods=filters.methods.join(',');
  const key=`${actor}|${session.accessToken}|${server??''}|${user??''}|${records}|${types}|${methods}`;
  const [navigation,setNavigation]=useState<{key:string;cursors:(string|undefined)[]}>({key,cursors:[undefined]});
  useEffect(()=>{setNavigation({key,cursors:[undefined]});},[key]);
  const cursors=navigation.key===key?navigation.cursors:[undefined];
  const before=cursors[cursors.length-1];
  const request=actor?['server-timeline',actor,server??'',user??'',records,types,methods,before??''] as const:null;
  const tag=request?JSON.stringify(request):undefined;
  const state=useSWR(request,
    async ([,identity,selectedServer,selectedUser,selectedRecords,selectedTypes,selectedMethods,selectedBefore]:readonly [string,string,string,string,TimelineRecords,string,string,string])=>({tag:JSON.stringify([
      'server-timeline',identity,selectedServer,selectedUser,selectedRecords,selectedTypes,selectedMethods,selectedBefore]),
      page:await fetchServerTimeline(identity,{server:selectedServer||undefined,user:selectedUser||undefined,records:selectedRecords,
        filters:{types:selectedTypes?selectedTypes.split(',') as TimelineFilters['types']:[],methods:selectedMethods?selectedMethods.split(',') as TimelineFilters['methods']:[]},
        before:selectedBefore||undefined})}),
    {refreshInterval:connected?0:30000,keepPreviousData:true});
  useEffect(()=>{if(actor&&session.accessToken)return watchHistory(actor,'all',()=>{void state.mutate().catch(()=>{});});},[actor,session.accessToken,state.mutate]);
  const reply=state.data;
  // A page is never shown for another session.
  const page=!state.error&&reply&&reply.page.actor_uuid===actor?reply.page:undefined;
  const pending=Boolean(page)&&reply?.tag!==tag;
  const move=(next:(string|undefined)[])=>setNavigation({key,cursors:next});
  return {page,pending,loading:!page&&(state.isLoading||Boolean(actor&&!state.error)),error:state.error as Error|undefined,refresh:state.mutate,
    hasPrevious:cursors.length>1,next:()=>{if(page?.next_before)move([...cursors,page.next_before]);},previous:()=>{if(cursors.length>1)move(cursors.slice(0,-1));}};
}
