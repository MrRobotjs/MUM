import {useEffect, useState, useSyncExternalStore} from 'react';
import useSWR from 'swr';
import {useAuth} from '../contexts/AuthContext';
import {getAuthSnapshot,subscribeToAuthStore} from '../store/authStore';
import {fetchIdentityTimeline,type TimelineFilters,type TimelineRecords} from '../lib/identityTimeline';

// One person's play timeline on one server with Newer/Older paging. Changing
// the person, server, records, filters or session starts from the newest.
// Without a server the reply picks the one with the newest play.
export function useIdentityTimeline(target:string|undefined,server:string|undefined,records:TimelineRecords,filters:TimelineFilters,enabled=true){
  const {user,isAdministrator}=useAuth();
  const session=useSyncExternalStore(subscribeToAuthStore,getAuthSnapshot);
  const scope=isAdministrator?'all':'own';
  const actor=enabled&&target&&session.accessToken?user?.uuid:undefined;
  const types=filters.types.join(','),methods=filters.methods.join(',');
  const key=`${actor}|${session.accessToken}|${target}|${server??''}|${records}|${types}|${methods}`;
  const [navigation,setNavigation]=useState<{key:string;cursors:(string|undefined)[]}>({key,cursors:[undefined]});
  useEffect(()=>{setNavigation({key,cursors:[undefined]});},[key]);
  const cursors=navigation.key===key?navigation.cursors:[undefined];
  const before=cursors[cursors.length-1];
  const state=useSWR(actor&&target?['identity-timeline',actor,scope,target,server??'',records,types,methods,before??'']:null,
    ([,identity,selectedScope,selectedTarget,selectedServer,selectedRecords,selectedTypes,selectedMethods,selectedBefore]:[string,string,'own'|'all',string,string,TimelineRecords,string,string,string])=>
      fetchIdentityTimeline(identity,selectedTarget,selectedScope,{server:selectedServer||undefined,records:selectedRecords,
        filters:{types:selectedTypes?selectedTypes.split(',') as TimelineFilters['types']:[],methods:selectedMethods?selectedMethods.split(',') as TimelineFilters['methods']:[]},
        before:selectedBefore||undefined}),
    {refreshInterval:5000,keepPreviousData:false});
  const page=!state.error&&state.data&&state.data.actor_uuid===actor&&state.data.target_uuid===target&&state.data.records===records&&(!server||state.data.server_id===server)?state.data:undefined;
  const move=(next:(string|undefined)[])=>setNavigation({key,cursors:next});
  return {page,loading:state.isLoading||Boolean(actor&&!state.error&&!page),error:state.error as Error|undefined,refresh:state.mutate,
    hasPrevious:cursors.length>1,next:()=>{if(page?.next_before)move([...cursors,page.next_before]);},previous:()=>{if(cursors.length>1)move(cursors.slice(0,-1));}};
}
