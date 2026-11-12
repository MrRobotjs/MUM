import {useEffect,useSyncExternalStore} from 'react';
import useSWR from 'swr';
import {useAuth} from '../contexts/AuthContext';
import {getAccessToken,getAuthSnapshot,subscribeToAuthStore} from '../store/authStore';
import {fetchProfileAccountLinks} from '../lib/serviceAccounts';

export function useProfileAccountSnapshot(target?:string,enabled=true) {
  const auth=useAuth(),session=useSyncExternalStore(subscribeToAuthStore,getAuthSnapshot);
  const actor=enabled&&auth.isAdministrator&&session.accessToken?auth.user?.uuid:undefined;
  const state=useSWR(actor&&target?['profile-account-links',actor,target]:null,async([,identity,human]:[string,string,string])=>{
    const token=getAccessToken();return {page:await fetchProfileAccountLinks(identity,human),token};
  },{keepPreviousData:false,refreshInterval:5000});
  useEffect(()=>{if(actor&&target)void state.mutate().catch(()=>{});},[actor,target,session.accessToken,state.mutate]);
  const page=!state.error&&state.data?.token===session.accessToken&&state.data.page.actor_uuid===actor&&state.data.page.user_uuid===target?state.data.page:undefined;
  return {actor,session,state,page};
}
