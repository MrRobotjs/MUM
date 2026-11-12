import {useEffect, useState, useSyncExternalStore} from 'react';
import useSWR from 'swr';
import {useAuth} from '../contexts/AuthContext';
import {getAccessToken,getAuthSnapshot,subscribeToAuthStore} from '../store/authStore';
import {fetchActivityCurrent,fetchActivityHistory,fetchIdentityCurrent,fetchIdentityHistory,type ActivityScope} from '../lib/activityHistory';
import {watchActivity} from '../lib/activityRealtime';

function useActivityObservations(kind:'history'|'current',scope: ActivityScope, server?: string,target?:string,enabled=true) {
  const {user,isAdministrator} = useAuth();
  const session=useSyncExternalStore(subscribeToAuthStore,getAuthSnapshot);
  const actor=enabled && session.accessToken && (scope==='own'||isAdministrator) ? user?.uuid : undefined;
  const [navigation,setNavigation]=useState<{actor?:string;token:string|null;scope:ActivityScope;server?:string;target?:string;cursors:(string|undefined)[]}>({token:null,scope:'own',cursors:[undefined]});
  useEffect(()=>{setNavigation({actor,token:session.accessToken,scope,server,target,cursors:[undefined]});},[actor,session.accessToken,scope,server,kind,target]);
  const cursors=navigation.actor===actor&&navigation.token===session.accessToken&&navigation.scope===scope&&navigation.server===server&&navigation.target===target?navigation.cursors:[undefined];
  const before=cursors[cursors.length-1];
  const state=useSWR(actor?[`/api/activity/${kind}`,actor,scope,server??'',before??'',target??'']:null,async ([,identity,selectedScope,selectedServer,selectedBefore,selectedTarget]:[string,string,ActivityScope,string,string,string])=>{
    const token=getAccessToken(); const page=selectedTarget?await (kind==='history'?fetchIdentityHistory:fetchIdentityCurrent)(identity,selectedTarget,selectedScope,selectedBefore||undefined):await (kind==='history'?fetchActivityHistory:fetchActivityCurrent)(identity,selectedScope,selectedServer||undefined,selectedBefore||undefined); return {page,token,kind};
  },{refreshInterval:5000,keepPreviousData:false});
  useEffect(()=>{if(actor)void state.mutate().catch(()=>{});},[actor,session.accessToken,state.mutate]);
  useEffect(()=>{if(actor&&session.accessToken)return watchActivity(actor,scope,()=>{void state.mutate().catch(()=>{});});},[actor,session.accessToken,scope,state.mutate]);
  const page=!state.error&&state.data?.kind===kind&&state.data.token===session.accessToken&&state.data.page.actor_uuid===actor&&state.data.page.scope===scope&&state.data.page.target_uuid===target?state.data.page:undefined;
  const move=(next:(string|undefined)[])=>setNavigation({actor,token:session.accessToken,scope,server,target,cursors:next});
  return {page,loading:state.isLoading||Boolean(actor&&!state.error&&!page),error:state.error||(!actor?Error('Sign in with the required activity scope.'):undefined),refresh:state.mutate,
    hasPrevious:cursors.length>1,next:()=>{if(page?.next_before)move([...cursors,page.next_before]);},previous:()=>{if(cursors.length>1)move(cursors.slice(0,-1));},latest:()=>move([undefined])};
}

export const useActivityHistory=(scope:ActivityScope,server?:string,target?:string,enabled=true)=>useActivityObservations('history',scope,server,target,enabled);
export const useActivityCurrent=(scope:ActivityScope,server?:string,target?:string,enabled=true)=>useActivityObservations('current',scope,server,target,enabled);
