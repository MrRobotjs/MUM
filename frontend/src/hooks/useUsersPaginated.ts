import {useSyncExternalStore} from 'react';
import {useAuth} from '../contexts/AuthContext';
import {getAccessToken,getAuthSnapshot,subscribeToAuthStore} from '../store/authStore';
import {userListRoleFilter} from '../lib/userRoleCatalog';
import useSWR from 'swr';
import { requestJson } from '../util/apiClient';

type UsersFilters = {
  search?: string;
  userType?: string;
  role?: string;
  serverId?: string;
  filterType?: string;
  searchEmail?: string;
  searchUsername?: string;
  searchNotes?: string;
  sort?: string;
  page?: number;
  pageSize?: number;
};

type UsersResponse = {
  data: Array<{
    uuid: string;
    server_id?: number;
    username?: string;
    email?: string;
    external_email?: string;
    user_type: string;
    display_name?: string;
    avatar_url?: string | null;
    created_at?: string;
    last_streamed_at?: string | null;
    service_join_date?: string | null;
    last_login_at?: string;
    last_platform?: string | null;
    last_player?: string | null;
    last_known_ip?: string | null;
    total_plays?: number;
    total_duration?: number;
    last_played?: {
      media_title?: string | null;
      original_media_title?: string | null;
      media_type?: string | null;
      grandparent_title?: string | null;
      parent_title?: string | null;
      rating_key?: string | null;
      server_id?: number | null;
      thumb_url?: string | null;
      started_at?: string | null;
    } | null;
    is_active: boolean;
    admin_roles: string[];
    /** Admin roles with their display settings, in the Admin Roles order. */
    admin_roles_detail?: Array<{
      name: string;
      color?: string | null;
      description?: string | null;
      icon?: string | null;
      badge_style?: string | null;
    }>;
    user_roles: Array<{
      name: string;
      color?: string | null;
      description?: string | null;
      icon?: string | null;
      badge_style?: string | null;
    }>;
    linked_service_count: number;
    service_type?: string;
    server_nickname?: string;
    libraries?: string[];
    has_all_libraries?: boolean;
    access_expires_at?: string | null;
    linked_local_user?: {
      uuid: string;
      username?: string | null;
      display_name?: string | null;
    } | null;
    notes?: string | null;
  }>;
  meta: {
    pagination: {
      page: number;
      page_size: number;
      total_items: number;
      total_pages: number;
    };
  };
};

export const useUsersPaginated = (filters: UsersFilters = {}) => {
  const page = filters.page || 1;
  const pageSize = filters.pageSize || 50;

  const params = new URLSearchParams({
    page: String(page),
    page_size: String(pageSize)
  });

  if (filters.search) params.set('search', filters.search);
  if (filters.userType) params.set('user_type', filters.userType);
  const roleFilter=userListRoleFilter(filters.role??'');
  if(roleFilter)params.set(roleFilter.parameter,roleFilter.id);
  // Include extended filters supported by our v2 implementation
  if (filters.serverId && filters.serverId !== 'all') params.set('server_id', filters.serverId);
  if (filters.filterType) params.set('filter_type', filters.filterType);
  if (filters.searchEmail) params.set('search_email', filters.searchEmail);
  if (filters.searchUsername) params.set('search_username', filters.searchUsername);
  if (filters.searchNotes) params.set('search_notes', filters.searchNotes);
  if (filters.sort) params.set('sort', filters.sort);

  const url=`/api/users?${params.toString()}`;
  const {user,isAdministrator}=useAuth();
  const session=useSyncExternalStore(subscribeToAuthStore,getAuthSnapshot),token=session.accessToken;
  const actor=isAdministrator&&token?user?.uuid:undefined;
  const state=useSWR(actor?[url,actor,token]:null,async()=>{
    if(token!==getAccessToken())throw Error('Session changed. Refresh users.');
    const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),15000);
    try{
      const result=await requestJson<UsersResponse>(url,{signal:abort.signal,retryAuthentication:false});
      if(token!==getAccessToken()||!Array.isArray(result?.data)||result.data.some(u=>!u||typeof u.uuid!=='string'||filters.serverId&&filters.serverId!=='all'&&String(u.server_id)!==filters.serverId)||!result.meta?.pagination)throw Error('Invalid user selection. Refresh.');
      return result;
    }finally{clearTimeout(timer);}
  },{revalidateOnFocus:false,keepPreviousData:false,shouldRetryOnError:false});
  return {users:actor&&!state.error?state.data?.data??[]:[],pagination:actor&&!state.error?state.data?.meta.pagination:undefined,error:state.error,loading:state.isLoading,mutate:state.mutate};
};
