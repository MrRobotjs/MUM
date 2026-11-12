import {useSyncExternalStore} from 'react';
import {useAuth} from '../contexts/AuthContext';
import {getAccessToken,getAuthSnapshot,subscribeToAuthStore} from '../store/authStore';
import useSWR from 'swr';
import { requestJson } from '../util/apiClient';

export type Library = {
  id: number;
  internal_id?: string | null;
  external_id: string;
  name: string;
  library_type?: string | null;
  item_count?: number | null;
  last_scanned?: string | null;
  server_id?: number;
  server?: {
    id: number;
    server_nickname: string;
    server_name?: string | null;
    service_type: string;
  };
  created_at?: string | null;
  updated_at?: string | null;
};

type LibrariesResponse = {
  data: Library[];
  meta: {
    request_id: string;
    total_count: number;
  };
};

type UseLibrariesOptions = {
  serverId?: number;
  libraryType?: string;
  search?: string;
  includeServer?: boolean;
};

export const useLibraries = (options: UseLibrariesOptions = {}) => {
  const params = new URLSearchParams();
  if (options.serverId) params.append('server_id', String(options.serverId));
  if (options.libraryType) params.append('library_type', options.libraryType);
  if (options.search) params.append('search', options.search);
  if (options.includeServer !== false) params.append('include_server', 'true');

  const url = `/api/libraries${params.toString() ? `?${params.toString()}` : ''}`;

  const {user,isAdministrator}=useAuth();
  const session=useSyncExternalStore(subscribeToAuthStore,getAuthSnapshot),token=session.accessToken;
  const actor=isAdministrator&&token?user?.uuid:undefined;
  const state=useSWR(actor?[url,actor,token]:null,async()=>{
    if(token!==getAccessToken())throw Error('Session changed. Refresh libraries.');
    const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),15000);
    try{
      const result=await requestJson<LibrariesResponse>(url,{signal:abort.signal,retryAuthentication:false});
      if(token!==getAccessToken()||!Array.isArray(result?.data)||result.data.some(lib=>!lib||!Number.isSafeInteger(lib.id)||lib.id<1||options.serverId!==undefined&&lib.server_id!==options.serverId))throw Error('Invalid library selection. Refresh.');
      return result;
    }finally{clearTimeout(timer);}
  },{keepPreviousData:false,shouldRetryOnError:false});
  return {libraries:actor&&!state.error?state.data?.data??[]:[],loading:state.isLoading,error:state.error,refresh:state.mutate};
};

export const useLibraryDetail = (libraryId?: number) => {
  const url = libraryId
    ? `/api/libraries/${libraryId}?include_server=true&include_items_count=true`
    : null;

  const { data, error, isLoading, mutate } = useSWR(url, (url: string) =>
    requestJson<{ data: any }>(url)
  );

  return {
    library: data?.data ?? null,
    loading: isLoading,
    error,
    refresh: mutate,
  };
};
