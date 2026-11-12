import {useEffect,useSyncExternalStore} from 'react';
import useSWR from 'swr';
import {useAuth} from '../contexts/AuthContext';
import {getAccessToken,getAuthSnapshot,subscribeToAuthStore} from '../store/authStore';
import {fetchActivitySummary,fetchIdentitySummary} from '../lib/activitySummary';
import type {ActivityScope} from '../lib/activityHistory';
import {watchActivity} from '../lib/activityRealtime';
export function useStreamingSummary(scope:ActivityScope='own',enabled=true,target?:string){
  const {user,isAdministrator}=useAuth();const session=useSyncExternalStore(subscribeToAuthStore,getAuthSnapshot);
  const actor=enabled&&session.accessToken&&(scope==='own'||isAdministrator)?user?.uuid:undefined;
  const state=useSWR(actor?['/api/activity/summary',actor,scope,target??'']:null,async([,identity,selected,selectedTarget]:[string,string,ActivityScope,string])=>{const token=getAccessToken();return {summary:await (selectedTarget?fetchIdentitySummary(identity,selectedTarget,selected):fetchActivitySummary(identity,selected)),token};},{refreshInterval:5000,keepPreviousData:false});
  useEffect(()=>{if(actor)void state.mutate().catch(()=>{});},[actor,session.accessToken,state.mutate]);
  useEffect(()=>{if(actor&&session.accessToken)return watchActivity(actor,scope,()=>{void state.mutate().catch(()=>{});});},[actor,session.accessToken,scope,state.mutate]);
  const summary=!state.error&&state.data?.token===session.accessToken&&state.data.summary.actor_uuid===actor&&state.data.summary.scope===scope&&state.data.summary.target_uuid===target?state.data.summary:undefined;
  return {summary,loading:state.isLoading||Boolean(actor&&!state.error&&!summary),error:state.error,refresh:state.mutate};
}
