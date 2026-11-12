import {useSyncExternalStore} from 'react';
import useSWR from 'swr';
import {useAuth} from '../contexts/AuthContext';
import {getAccessToken,getAuthSnapshot,subscribeToAuthStore} from '../store/authStore';
import {fetchProviderFeatures} from '../lib/providerFeatures';

export function useProviderFeatures(){
 const {user,isAdministrator}=useAuth();
 const session=useSyncExternalStore(subscribeToAuthStore,getAuthSnapshot),token=session.accessToken;
 const actor=isAdministrator&&token?user?.uuid:undefined;
 const state=useSWR(actor?['/api/providers',actor,token]:null,async()=>{
  if(token!==getAccessToken())throw Error('Session changed. Refresh.');
  return fetchProviderFeatures();
 },{keepPreviousData:false,shouldRetryOnError:false,refreshInterval:5000});
 return {data:actor&&!state.error?state.data:undefined,error:state.error,loading:state.isLoading,refresh:state.mutate};
}
