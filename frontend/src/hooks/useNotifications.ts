import useSWR from 'swr';
import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {useAuth} from '../contexts/AuthContext';
import {getAccessToken,getAuthSnapshot,subscribeToAuthStore} from '../store/authStore';
import {watchNotificationInbox} from '../lib/notificationRealtime';
import {fetchNotifications,changeNotifications,NOTIFICATIONS_EVENT} from '../lib/notifications';
export type {Notification} from '../lib/notifications';
export const useNotifications=(filters?:{limit?:number;unreadOnly?:boolean;type?:string})=>{
 const{user,isAdministrator}=useAuth(),actor=isAdministrator?user?.uuid:undefined;
 const token=useSyncExternalStore(subscribeToAuthStore,getAuthSnapshot).accessToken;
 const state=useSWR(actor?['/api/notifications',actor]:null,([,owner]:[string,string])=>fetchNotifications(owner),{keepPreviousData:false});
 const [pending,setPending]=useState(false),[actionError,setActionError]=useState<string|null>(null),active=useRef(true),current=useRef(actor);current.current=actor;
 useEffect(()=>{active.current=true;return()=>{active.current=false}},[]);
 useEffect(()=>{setActionError(null);setPending(false)},[actor]);
 useEffect(()=>{if(actor&&token)return watchNotificationInbox(actor,()=>{if(current.current===actor)void state.mutate().catch(()=>{});});},[actor,token,state.mutate]);
 useEffect(()=>{const changed=(e:Event)=>{if((e as CustomEvent<{actor_uuid:string}>).detail?.actor_uuid===actor)void state.mutate().catch(()=>{});};window.addEventListener(NOTIFICATIONS_EVENT,changed);return()=>window.removeEventListener(NOTIFICATIONS_EVENT,changed);},[actor,state.mutate]);
 const snapshot=state.data?.actor_uuid===actor&&!state.error?state.data:undefined;
 const run=async(operation:'read'|'read_all'|'dismiss',ids:number[]=[])=>{
  if(!snapshot||pending||actionError)return;
  const owner=actor,token=getAccessToken();setPending(true);
  try{await changeNotifications(snapshot,operation,ids);if(active.current&&current.current===owner&&token===getAccessToken()){setActionError(null);await state.mutate();}}
  catch{if(active.current&&current.current===owner&&token===getAccessToken())setActionError('Change could not be confirmed. Refresh and inspect before another attempt.');}
  finally{if(active.current&&current.current===owner)setPending(false);}
 };
 return{notifications:(snapshot?.notifications??[]).filter(n=>(!filters?.unreadOnly||!n.read)&&(!filters?.type||n.notification_type===filters.type)).slice(0,filters?.limit??100),unreadCount:snapshot?.unread_count??0,total:snapshot?.total??0,loading:state.isLoading,pending,error:state.error||actionError||(!actor?'Administrator access is required.':null),refresh:async()=>{setActionError(null);await state.mutate();},markAsRead:async(id:number)=>run('read',[id]),markAllAsRead:async()=>run('read_all'),dismissNotification:async(id:number)=>run('dismiss',[id])};
};
