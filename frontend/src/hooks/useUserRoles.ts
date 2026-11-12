import useSWR from 'swr';
import {useState,useSyncExternalStore} from 'react';
import {useAuth} from '../contexts/AuthContext';
import {getAuthSnapshot,subscribeToAuthStore} from '../store/authStore';
import {readUserRoleCatalog,roleCatalogBusy,roleCatalogNeedsRead,subscribeRoleCatalog,roleCatalogStatus,type UserRole} from '../lib/userRoleCatalog';
export type {UserRole} from '../lib/userRoleCatalog';
const emptyRoles:readonly UserRole[]=[];
export const useUserRoles=()=>{
 const [readEpoch,setReadEpoch]=useState(0);
 const {user,isAdministrator}=useAuth(),session=useSyncExternalStore(subscribeToAuthStore,getAuthSnapshot);
 const actor=isAdministrator&&session.accessToken?user?.uuid:undefined;
 useSyncExternalStore(subscribeRoleCatalog,roleCatalogStatus);
 const state=useSWR(actor?['/api/user-role-catalog',actor,session.accessToken]:null,([,id]:[string,string,string])=>readUserRoleCatalog(id),{keepPreviousData:false});
 const needsRead=!!actor&&roleCatalogNeedsRead(actor),busy=!!actor&&roleCatalogBusy(actor);
 const catalog=!needsRead&&!state.error&&state.data?.actor_uuid===actor?state.data:undefined;
 return {actor,sessionToken:session.accessToken,readEpoch,catalog,roles:catalog?.roles??emptyRoles,loading:state.isLoading,busy,needsRead,error:state.error??(needsRead?new Error('Read saved roles before another change.'):undefined),refresh:async()=>{if(!actor)return;const fresh=await readUserRoleCatalog(actor,true);await state.mutate(fresh,{revalidate:false});setReadEpoch(value=>value+1);}};
};
