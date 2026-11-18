import {useEffect, useState, useSyncExternalStore} from 'react';
import useSWR from 'swr';
import {useAuth} from '../contexts/AuthContext';
import {getAuthSnapshot,subscribeToAuthStore} from '../store/authStore';
import {fetchIdentityTimeline,type TimelineFilters,type TimelineRecords} from '../lib/identityTimeline';

// One person's play timeline on one server with Newer/Older paging. Changing
// the person, server, records, filters or session starts from the newest.
// Without a server the reply picks the one with the newest play.
// While a change loads, the previous page stays with `pending` set.
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
  const request=actor&&target?['identity-timeline',actor,scope,target,server??'',records,types,methods,before??''] as const:null;
  const tag=request?JSON.stringify(request):undefined;
  // Each reply carries the request it answers. The previous reply stays on
  // screen while the next one loads (filters, records, server or paging), so
  // the tab isn't replaced by a loading line; it is never shown for another
  // person or session.
  const state=useSWR(request,
    async ([,identity,selectedScope,selectedTarget,selectedServer,selectedRecords,selectedTypes,selectedMethods,selectedBefore]:readonly [string,string,'own'|'all',string,string,TimelineRecords,string,string,string])=>({tag:JSON.stringify([
      'identity-timeline',identity,selectedScope,selectedTarget,selectedServer,selectedRecords,selectedTypes,selectedMethods,selectedBefore]),
      page:await fetchIdentityTimeline(identity,selectedTarget,selectedScope,{server:selectedServer||undefined,records:selectedRecords,
        filters:{types:selectedTypes?selectedTypes.split(',') as TimelineFilters['types']:[],methods:selectedMethods?selectedMethods.split(',') as TimelineFilters['methods']:[]},
        before:selectedBefore||undefined})}),
    {refreshInterval:5000,keepPreviousData:true});
  const reply=state.data;
  const page=!state.error&&reply&&reply.page.actor_uuid===actor&&reply.page.target_uuid===target?reply.page:undefined;
  // True while the page shown answers an earlier request.
  const pending=Boolean(page)&&reply?.tag!==tag;
  const move=(next:(string|undefined)[])=>setNavigation({key,cursors:next});
  return {page,pending,loading:!page&&(state.isLoading||Boolean(actor&&!state.error)),error:state.error as Error|undefined,refresh:state.mutate,
    hasPrevious:cursors.length>1,next:()=>{if(page?.next_before)move([...cursors,page.next_before]);},previous:()=>{if(cursors.length>1)move(cursors.slice(0,-1));}};
}
