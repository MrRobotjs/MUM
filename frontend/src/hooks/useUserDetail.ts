import {useEffect,useSyncExternalStore} from 'react';
import useSWR from 'swr';
import {useAuth} from '../contexts/AuthContext';
import {getAccessToken,getAuthSnapshot,subscribeToAuthStore} from '../store/authStore';
import {fetchProfileMetadata} from '../lib/profileMetadata';
export type {UserDetail,UserRoleDetail} from '../lib/profileMetadata';
export function useUserDetail(target?:string){
 const {user,isAdministrator}=useAuth();const session=useSyncExternalStore(subscribeToAuthStore,getAuthSnapshot);
 const actor=isAdministrator&&session.accessToken?user?.uuid:undefined;
 const state=useSWR(actor&&target?['/api/users',actor,target]:null,async([,identity,selected]:[string,string,string])=>{const token=getAccessToken();return {user:await fetchProfileMetadata(identity,selected),token};},{keepPreviousData:false,refreshInterval:5000});
 useEffect(()=>{if(actor&&target)void state.mutate().catch(()=>{});},[actor,target,session.accessToken,state.mutate]);
 const profile=!state.error&&state.data?.token===session.accessToken&&actor&&state.data.user.uuid===target?state.data.user:null;
 return {user:profile,loading:state.isLoading||Boolean(actor&&target&&!state.error&&!profile),error:state.error||(!actor?Error('Administrator access is required.'):undefined),refresh:state.mutate};
}
