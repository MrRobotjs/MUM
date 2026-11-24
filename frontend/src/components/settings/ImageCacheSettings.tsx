import {useCallback, useEffect, useRef, useState, useSyncExternalStore} from 'react';
import {useAlerts} from '../../contexts';
import {requestJson} from '../../util/apiClient';
import {getAccessToken,getAuthSnapshot,subscribeToAuthStore} from '../../store/authStore';
import {Button} from '../ui/button';
import {Card, CardContent, CardHeader, CardTitle, CardDescription} from '../ui/card';
import {Input} from '../ui/input';
import {Label} from '../ui/label';
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from '../ui/select';

type ServerCache = {id:number;name:string;provider:string;limit_mb:number;usage_bytes:number};
type CacheSettings = {mode:'shared'|'per_server';shared_limit_mb:number;revision:number;usage_bytes:number;available:boolean;servers:ServerCache[]};
const size = (bytes:number) => bytes >= 1024**3 ? `${(bytes/1024**3).toFixed(2)} GB` : `${(bytes/1024**2).toFixed(1)} MB`;

export function ImageCacheSettings({serverId,refreshKey=0}:{serverId?:number;refreshKey?:number}) {
  const {success,error:showError}=useAlerts();
  const token=useSyncExternalStore(subscribeToAuthStore,getAuthSnapshot).accessToken;
  const identity=`${token}:${serverId ?? 'all'}`;
  const current=useRef(identity);current.current=identity;
  const loaded=useRef(identity),active=useRef(true),admitted=useRef(false);
  const [settings,setSettings]=useState<CacheSettings|null>(null);
  const [mode,setMode]=useState<'shared'|'per_server'>('shared');
  const [limit,setLimit]=useState('1024');
  const [busy,setBusy]=useState(false);
  const [failure,setFailure]=useState(false);
  const load=useCallback(async (signal?:AbortSignal) => {
    const expected=identity;
    const {data}=await requestJson<{data:CacheSettings}>('/api/settings/image-cache',{signal,retryAuthentication:false});
    if(!token || token!==getAccessToken() || !active.current || current.current!==expected || signal?.aborted || !data || !['shared','per_server'].includes(data.mode) || !Number.isSafeInteger(data.revision) || data.revision<1 || !Number.isSafeInteger(data.shared_limit_mb) || data.shared_limit_mb<1 || data.shared_limit_mb>1048576 || !Number.isSafeInteger(data.usage_bytes) || data.usage_bytes<0 || typeof data.available!=='boolean' || !Array.isArray(data.servers) || data.servers.some(row=>!Number.isSafeInteger(row.id)||row.id<1||!Number.isSafeInteger(row.limit_mb)||row.limit_mb<1||row.limit_mb>1048576||!Number.isSafeInteger(row.usage_bytes)||row.usage_bytes<0)) throw Error('Cache settings unavailable');
    const server=data.servers.find(row=>row.id===serverId);
    if(serverId && !server) throw Error('Server not found');
    loaded.current=expected;setSettings(data);setMode(data.mode);setLimit(String(serverId ? server!.limit_mb : data.shared_limit_mb));setFailure(false);
  },[serverId,token,identity]);
  useEffect(()=>{active.current=true;return()=>{active.current=false}},[]);
  useEffect(()=>{if(!token)return;const abort=new AbortController();void load(abort.signal).catch(()=>{if(!abort.signal.aborted)setFailure(true)});return()=>abort.abort()},[load,refreshKey,token]);
  const save=async()=>{
    if(!settings || busy || admitted.current || !token || getAccessToken()!==token || loaded.current!==identity)return;
    const parsed=Number(limit);
    if(!Number.isSafeInteger(parsed)||parsed<1||parsed>1048576){showError('Enter a cache limit between 1 and 1,048,576 MB.');return}
    const start=identity;admitted.current=true;setBusy(true);
    try {
      await requestJson(serverId?`/api/servers/${serverId}/image-cache/limit`:'/api/settings/image-cache',{method:'PUT',retryAuthentication:false,body:JSON.stringify(serverId?{revision:settings.revision,limit_mb:parsed}:{revision:settings.revision,mode,shared_limit_mb:parsed})});
      if(active.current&&current.current===start&&getAccessToken()===token){await load();success('Image cache settings saved')}
    } catch {if(active.current&&current.current===start&&getAccessToken()===token){showError('Could not confirm cache settings. Refresh before trying again.');await load().catch(()=>setFailure(true))}} finally {admitted.current=false;if(active.current&&current.current===start)setBusy(false)}
  };
  const clear=async()=>{
    if(!settings || busy || admitted.current || !token || getAccessToken()!==token || loaded.current!==identity)return;
    const start=identity;admitted.current=true;setBusy(true);try{await requestJson('/api/settings/image-cache/clear',{method:'POST',retryAuthentication:false});if(active.current&&current.current===start&&getAccessToken()===token){await load();success('Image cache cleared')}}catch{if(active.current&&current.current===start&&getAccessToken()===token)showError('Could not clear the image cache.')}finally{admitted.current=false;if(active.current&&current.current===start)setBusy(false)}
  };
  if(!token || loaded.current!==identity)return <p className="text-sm text-muted-foreground">Loading image cache settings…</p>;
  if(failure)return <p className="text-sm text-destructive">Could not load image cache settings.</p>;
  if(!settings)return <p className="text-sm text-muted-foreground">Loading image cache settings…</p>;
  const server=settings.servers.find(row=>row.id===serverId);
  if(serverId && settings.mode==='shared')return <p className="text-xs text-muted-foreground">Image cache uses the shared limit in Advanced Settings. This server uses {size(server?.usage_bytes??0)}.</p>;
  const body=<div className="space-y-4">
    {!settings.available && <p className="text-sm text-destructive">The disk image cache is unavailable. Check MUM’s logs and data directory.</p>}
    {!serverId && <div className="space-y-2"><Label htmlFor="image-cache-mode">Cache limit</Label><Select value={mode} onValueChange={value=>setMode(value as 'shared'|'per_server')}><SelectTrigger id="image-cache-mode"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="shared">Shared across all servers</SelectItem><SelectItem value="per_server">Managed per server</SelectItem></SelectContent></Select></div>}
    {(serverId || mode==='shared') && <div className="space-y-2"><Label htmlFor={serverId?'server-cache-limit':'shared-cache-limit'}>{serverId?'Server cache limit':'Shared cache limit'} (MB)</Label><Input id={serverId?'server-cache-limit':'shared-cache-limit'} type="number" min={1} max={1048576} value={limit} onChange={event=>setLimit(event.target.value)} /></div>}
    <p className="text-sm text-muted-foreground">{serverId?`This server uses ${size(server?.usage_bytes??0)}.`:`Total disk usage: ${size(settings.usage_bytes)}.`} {(!serverId && mode==='per_server')?'Set each limit on its server settings page. Total usage can grow as servers are added.':'Least recently used images are removed when the limit is reached.'}</p>
    <div className="flex flex-wrap gap-2"><Button type="button" onClick={()=>void save()} disabled={busy}>Save cache settings</Button>{!serverId && <Button type="button" variant="outline" onClick={()=>void clear()} disabled={busy}>Clear all image caches</Button>}</div>
  </div>;
  return serverId ? body : <Card><CardHeader><CardTitle>Image Cache</CardTitle><CardDescription>Store server images on disk so they remain available after a restart.</CardDescription></CardHeader><CardContent>{body}</CardContent></Card>;
}
