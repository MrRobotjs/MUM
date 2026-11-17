import {useSyncExternalStore} from 'react';
import useSWR from 'swr';
import {useAuth} from '../contexts/AuthContext';
import {getAuthSnapshot,subscribeToAuthStore} from '../store/authStore';
import {fetchIdentityPlayTotals} from '../lib/identityPlayTotals';
import type {TimelineSource} from '../lib/identityTimeline';

// One person's play totals for the Profile tab, for one source of the
// History tab's picker, read again every half minute.
export function useIdentityPlayTotals(target:string|undefined,source:TimelineSource,enabled=true){
  const {user,isAdministrator}=useAuth();
  const session=useSyncExternalStore(subscribeToAuthStore,getAuthSnapshot);
  const scope=isAdministrator?'all':'own';
  const actor=enabled&&target&&session.accessToken?user?.uuid:undefined;
  const state=useSWR(actor&&target?['identity-plays',actor,scope,target,source,session.accessToken]:null,
    ([,identity,selectedScope,selectedTarget,selectedSource]:[string,string,'own'|'all',string,TimelineSource,string])=>fetchIdentityPlayTotals(identity,selectedTarget,selectedScope,selectedSource),
    {refreshInterval:30000,keepPreviousData:false});
  const totals=!state.error&&state.data&&state.data.actor_uuid===actor&&state.data.target_uuid===target&&state.data.scope===scope&&state.data.source===source?state.data:undefined;
  return {totals,loading:state.isLoading||Boolean(actor&&!state.error&&!totals),error:state.error as Error|undefined,refresh:state.mutate};
}
