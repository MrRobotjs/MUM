import {useEffect, useState, useSyncExternalStore} from 'react';
import useSWR from 'swr';
import {useAuth} from '../contexts/AuthContext';
import {getAuthSnapshot,subscribeToAuthStore} from '../store/authStore';
import {fetchIdentityTimeline,type TimelineSource} from '../lib/identityTimeline';

// One person's play timeline (MUM and imported Plex plays) with Newer/Older
// paging. Changing the person, the source or the session starts from the newest.
export function useIdentityTimeline(target:string|undefined,source:TimelineSource,enabled=true){
  const {user,isAdministrator}=useAuth();
  const session=useSyncExternalStore(subscribeToAuthStore,getAuthSnapshot);
  const scope=isAdministrator?'all':'own';
  const actor=enabled&&target&&session.accessToken?user?.uuid:undefined;
  const key=`${actor}|${session.accessToken}|${target}|${source}`;
  const [navigation,setNavigation]=useState<{key:string;cursors:(string|undefined)[]}>({key,cursors:[undefined]});
  useEffect(()=>{setNavigation({key,cursors:[undefined]});},[key]);
  const cursors=navigation.key===key?navigation.cursors:[undefined];
  const before=cursors[cursors.length-1];
  const state=useSWR(actor&&target?['identity-timeline',actor,scope,target,source,before??'']:null,
    ([,identity,selectedScope,selectedTarget,selectedSource,selectedBefore]:[string,string,'own'|'all',string,TimelineSource,string])=>
      fetchIdentityTimeline(identity,selectedTarget,selectedScope,selectedSource,selectedBefore||undefined),
    {refreshInterval:5000,keepPreviousData:false});
  const page=!state.error&&state.data&&state.data.actor_uuid===actor&&state.data.target_uuid===target&&state.data.source===source?state.data:undefined;
  const move=(next:(string|undefined)[])=>setNavigation({key,cursors:next});
  return {page,loading:state.isLoading||Boolean(actor&&!state.error&&!page),error:state.error as Error|undefined,refresh:state.mutate,
    hasPrevious:cursors.length>1,next:()=>{if(page?.next_before)move([...cursors,page.next_before]);},previous:()=>{if(cursors.length>1)move(cursors.slice(0,-1));}};
}
