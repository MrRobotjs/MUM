import {useSyncExternalStore} from 'react';
import {useAuth} from '../contexts/AuthContext';
import {getAccessToken,getAuthSnapshot,subscribeToAuthStore} from '../store/authStore';
import useSWR from 'swr';
import { requestJson } from '../util/apiClient';

export type Server = {
  id: number;
  server_nickname: string;
  server_name: string | null;
  service_type: string;
  url: string;
  public_url: string | null;
  jellyfin_owner_user_id?: string | null;
  is_active: boolean;
  provider_enabled?: boolean;
  effective_active?: boolean;
  created_at: string;
  updated_at: string;
  last_status?: boolean | null;
  last_status_check?: string | null;
  last_version?: string | null;
  last_sync_at?: string | null;
  overseerr_enabled?: boolean;
  has_overseerr_api_key?: boolean;
  overseerr_url?: string | null;
  websocket_refresh_interval?: number;
};

type ServersResponse = {
  data: Server[];
  meta: {
    request_id: string;
    total_count: number;
  };
};

type UseServersOptions = {
  includeStatus?: boolean;
  activeOnly?: boolean;
  serviceType?: string;
};

export const useServers = (options: UseServersOptions = {}) => {
  const params = new URLSearchParams();
  if (options.includeStatus) params.append('include_status', 'true');
  if (options.activeOnly) params.append('active_only', 'true');
  if (options.serviceType) params.append('service_type', options.serviceType);

  const url = `/api/servers${params.toString() ? `?${params.toString()}` : ''}`;

  const { data, error, isLoading, mutate } = useSWR<ServersResponse>(
    url,
    (url: string) => requestJson<ServersResponse>(url)
  );

  return {
    servers: data?.data ?? [],
    loading: isLoading,
    error,
    refresh: mutate,
  };
};

export const useServerDetail = (serverId?: number) => {
  const {user,isAdministrator}=useAuth();
  const session=useSyncExternalStore(subscribeToAuthStore,getAuthSnapshot),token=session.accessToken;
  const actor=isAdministrator&&token?user?.uuid:undefined;
  const url=Number.isSafeInteger(serverId)&&Number(serverId)>0?`/api/servers/${serverId}`:null;
  const read=async()=>{
    if(token!==getAccessToken())throw Error('Session changed. Refresh the server.');
    const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),15000);
    try{
      const {data}=await requestJson<{data:Server & {revision:number}}>(url!,{signal:abort.signal,retryAuthentication:false});
      if(token!==getAccessToken()||!data||data.id!==serverId||!Number.isSafeInteger(data.revision)||data.revision<0)throw Error('Invalid server detail. Refresh.');
      return data;
    }finally{clearTimeout(timer);}
  };
  const state=useSWR(actor&&url?[url,actor,token]:null,read,{keepPreviousData:false,shouldRetryOnError:false});
  // A background re-read (a health announcement): a fresh server replaces the
  // shown one, a failure keeps it. SWR receives the read as data rather than
  // revalidating, so a passing failure never becomes the page's error.
  const refreshQuietly=async()=>{
    if(!actor||!url||!state.data)return;
    await state.mutate(read(),{revalidate:false}).then(()=>undefined,()=>undefined);
  };
  return {server:actor&&!state.error&&state.data?.id===serverId?state.data:null,loading:state.isLoading,error:state.error,refresh:state.mutate,refreshQuietly};
};
