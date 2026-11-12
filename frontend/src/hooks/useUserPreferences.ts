import {useState,useEffect,useCallback,useRef} from 'react';import useSWR from 'swr';
import {getAccessToken} from '../store/authStore';
import {useAuth} from '../contexts/AuthContext';
import {fetchOwnPreferences,saveDevicePreference,saveOwnPreferences} from '../lib/accountPreferences';
import {PREFERENCE_EVENT,localPreferenceKey,readLocalCounter,writeLocalCounter,emitPreferenceChange,type PreferenceChangeDetail} from '../util/preferences';

// Actor-keyed SWR shares server snapshots across sidebar, modal and account card.
// Device values are scoped too; old browser-global keys are never imported.
export function useUserPreferences(){
 const {user}=useAuth();const owner=user?.uuid??null;
 const generation=useRef(0),activeOwner=useRef(owner);activeOwner.current=owner;
 const {data,error,isLoading,mutate}=useSWR(owner?['/api/account/preferences',owner]:null,([,id]:[string,string])=>fetchOwnPreferences(id),{keepPreviousData:false});
 const [local,setLocal]=useState<{owner:string|null;value:boolean}>({owner:null,value:false});
 const [saving,setSaving]=useState(false),[actionError,setActionError]=useState<Error|null>(null);
 useEffect(()=>{
  generation.current++;
  setActionError(null);setSaving(false);setLocal({owner,value:owner?readLocalCounter(owner):false});
  const changed=(event:Event)=>{const detail=(event as CustomEvent<PreferenceChangeDetail>).detail;if(owner && detail?.user_uuid===owner && detail.key==='stream_counter' && typeof detail.value==='boolean')setLocal({owner,value:detail.value});};
  const stored=(event:StorageEvent)=>{if(owner && (event.key===null || event.key===localPreferenceKey(owner)))setLocal({owner,value:readLocalCounter(owner)});};
  window.addEventListener(PREFERENCE_EVENT,changed);window.addEventListener('storage',stored);
  return()=>{generation.current++;window.removeEventListener(PREFERENCE_EVENT,changed);window.removeEventListener('storage',stored);};
 },[owner]);
 const current=data?.user_uuid===owner?data:undefined;
 const getPreference=useCallback((key:'stream_counter',fallback=false):boolean=>{if(key!=='stream_counter' || !owner || !current || error)return fallback;return current.sync_enabled?current.preferences.stream_counter:local.owner===owner?local.value:readLocalCounter(owner);},[owner,current,error,local]);
 const refresh=useCallback(async()=>{const run=generation.current;setActionError(null);try{await mutate();if(owner && run===generation.current && activeOwner.current===owner)setLocal({owner,value:readLocalCounter(owner)});}catch(e){if(run===generation.current && activeOwner.current===owner)setActionError(e as Error);}},[mutate,owner]);
 const setPreference=useCallback(async(key:'stream_counter',value:boolean)=>{
  if(key!=='stream_counter' || typeof value!=='boolean' || !owner || !current || error || saving)throw Error('Refresh the current preferences before saving.');
  const run=generation.current,token=getAccessToken();const scoped=()=>run===generation.current && activeOwner.current===owner;const valid=()=>scoped() && token===getAccessToken();
  setSaving(true);setActionError(null);
  try{
   if(current.sync_enabled){const result=await saveOwnPreferences(current,true,value);await mutate(result,false);if(!valid())throw Error('Session changed');try{writeLocalCounter(owner,value);}catch{/* Server is authoritative when synchronized. */}}
   else{await saveDevicePreference(current,value);if(!valid())throw Error('Session changed');}
   setLocal({owner,value});emitPreferenceChange(owner,value);
  }catch(e){if(scoped()){setActionError(e as Error);try{await mutate();}catch{/* Keep the original action error visible. */}}throw e;}finally{if(scoped())setSaving(false);}
 },[owner,current,error,saving,mutate]);
 const toggleSync=useCallback(async(enabled:boolean)=>{
  if(!owner || !current || error || saving || typeof enabled!=='boolean')throw Error('Refresh the current preferences before saving.');
  const run=generation.current,token=getAccessToken();const scoped=()=>run===generation.current && activeOwner.current===owner;const valid=()=>scoped() && token===getAccessToken();
  setSaving(true);setActionError(null);
  const value=current.sync_enabled?current.preferences.stream_counter:local.owner===owner?local.value:readLocalCounter(owner);
  try{
   const result=await saveOwnPreferences(current,enabled,value);await mutate(result,false);
   if(!valid())throw Error('Session changed');
   if(!enabled){try{writeLocalCounter(owner,value);}catch{throw Error('Sync setting was saved, but device storage failed. Refresh the profile before continuing.');}}
   else try{writeLocalCounter(owner,value);}catch{/* Optional local backup; synchronized snapshot is durable. */}
   setLocal({owner,value});emitPreferenceChange(owner,value);
  }catch(e){if(scoped()){setActionError(e as Error);try{await mutate();}catch{/* Keep the original action error visible. */}}throw e;}finally{if(scoped())setSaving(false);}
 },[owner,current,error,saving,local,mutate]);
 return{revision:current?.profile_revision,getPreference,setPreference,syncEnabled:current?.sync_enabled,toggleSync,refresh,loading:isLoading||saving||Boolean(owner&&!current&&!error),error:actionError??error,dbPreferences:current?.preferences??null};
}
