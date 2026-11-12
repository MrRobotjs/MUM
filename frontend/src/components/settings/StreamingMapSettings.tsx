import {useEffect, useRef, useState, useSyncExternalStore} from 'react';
import useSWR from 'swr';
import {useAuth} from '../../contexts/AuthContext';
import {getAccessToken, getAuthSnapshot, subscribeToAuthStore} from '../../store/authStore';
import {requestJson} from '../../util/apiClient';
import {Button} from '../ui/button';
import {Input} from '../ui/input';
import {Label} from '../ui/label';
import {Card, CardContent, CardHeader, CardTitle} from '../ui/card';
import {ResponsiveDialog} from '../ui/responsive-dialog';

export type MapSettings = {revision: number; configured: boolean};
export function useStreamingMapSettings() {
 const {user,isAdministrator}=useAuth();
 const session=useSyncExternalStore(subscribeToAuthStore,getAuthSnapshot);
 const identity=isAdministrator && session.accessToken ? user?.uuid : undefined;
 const state=useSWR(identity?['/api/settings/streaming-map',identity,session.accessToken]:null,async()=>{
  const {data}=await requestJson<{data:MapSettings}>('/api/settings/streaming-map',{retryAuthentication:false});
  if(!data || !Number.isSafeInteger(data.revision)||data.revision<1||typeof data.configured!=='boolean')throw Error('Invalid map settings');
  return data;
 },{keepPreviousData:false,refreshInterval:30000});
 return {...state,data:identity?state.data:undefined,canConfigure:Boolean(identity),sessionToken:session.accessToken};
}

export function MapKeyForm({base,onSaved}:{base:MapSettings;onSaved:()=>Promise<unknown>}) {
 const [key,setKey]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[uncertain,setUncertain]=useState(false);
 const admitted=useRef(false),active=useRef(true),controller=useRef<AbortController|null>(null);
 useEffect(()=>{active.current=true;return()=>{active.current=false;controller.current?.abort();};},[]);
 const save=async(value:string)=>{
  if(admitted.current||uncertain)return;admitted.current=true;setBusy(true);setMessage('');
  const token=getAccessToken();controller.current=new AbortController();
  const timer=setTimeout(()=>controller.current?.abort(),15000);
  try {
   await requestJson('/api/settings/streaming-map',{method:'PUT',retryAuthentication:false,signal:controller.current.signal,body:JSON.stringify({revision:base.revision,api_key:value})});
   if(active.current&&token===getAccessToken()){setKey('');setMessage(value?'Key saved. The map will now request tiles.':'Key removed.');await onSaved();}
  }catch{if(active.current&&token===getAccessToken()){setUncertain(true);setMessage('Save could not be confirmed. Close and reopen settings to inspect the saved status before trying again.');void onSaved();}}
  finally{clearTimeout(timer);admitted.current=false;if(active.current)setBusy(false);}
 };
 return <div className="space-y-4">
  <p className="text-sm text-muted-foreground">CARTO supplies the map background. Each MUM installation should use its own basemap key.</p>
  <ol className="list-decimal space-y-2 pl-5 text-sm">
   <li>Open <a className="text-primary underline" href="https://www.carto.com/basemaps/apikey/index.html" target="_blank" rel="noopener noreferrer">CARTO’s basemap key page</a> and request a key using your email address.</li>
   <li>Follow CARTO’s email instructions, copy the API key, and paste it below. Review their current free limits and terms on that page.</li>
   <li>Save the key here. You can replace or remove it later in Streaming Settings.</li>
  </ol>
  <p className="text-sm text-muted-foreground">Saved status: {base.configured?'Key configured':'No key configured'}. The saved key is never displayed. Tile requests are sent by your MUM server; browser referrer restrictions may not suit this setup.</p>
  <Label htmlFor="carto-basemap-key">CARTO basemap API key</Label>
  <Input id="carto-basemap-key" type="password" autoComplete="off" value={key} maxLength={512} disabled={busy||uncertain} placeholder={base.configured?'Enter a replacement key':'Paste your API key'} onChange={event=>setKey(event.target.value)}/>
  {message&&<p role="status" className="text-sm text-muted-foreground">{message}</p>}
  <div className="flex flex-wrap gap-2"><Button disabled={busy||uncertain||!key.trim()} onClick={()=>void save(key.trim())}>{busy?'Saving...':'Save map key'}</Button>{base.configured&&<Button variant="outline" disabled={busy||uncertain} onClick={()=>void save('')}>Remove key</Button>}</div>
 </div>;
}

export function StreamingMapSettings() {
 const state=useStreamingMapSettings();
 return <Card><CardHeader><CardTitle>Live User Map</CardTitle></CardHeader><CardContent>
  {state.error?<p role="alert">Map settings are unavailable. Close and reopen to refresh.</p>:state.data?<MapKeyForm key={`${state.sessionToken}:${state.data.revision}`} base={state.data} onSaved={()=>state.mutate()}/>:<p>Loading map settings...</p>}
 </CardContent></Card>;
}
export function StreamingMapKeyDialog({open,onClose}:{open:boolean;onClose:()=>void}) {
 return <ResponsiveDialog open={open} onOpenChange={value=>{if(!value)onClose();}} title="Set up Live User Map" description="Add your installation’s CARTO basemap key." contentClassName="max-w-lg" footer={<Button variant="outline" onClick={onClose}>Close</Button>}>
  {open&&<StreamingMapSettings/>}
 </ResponsiveDialog>;
}
