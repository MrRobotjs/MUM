import {useEffect,useRef,useState} from 'react';
import {useAuth} from '../../contexts/AuthContext';
import {getAccessToken} from '../../store/authStore';
import {configureScheduledTask} from '../../lib/scheduledTasks';
import type {ScheduledTask} from '../../hooks/useScheduledTasks';
import {Button} from '../ui/button';
import {Checkbox} from '../ui/checkbox';
import {Input} from '../ui/input';
import {Label} from '../ui/label';
export function ScheduledSyncControls({task,onSaved}:{task:ScheduledTask;onSaved:()=>Promise<void>}){
 const{user}=useAuth(),actor=useRef(user?.uuid);actor.current=user?.uuid;
 const[enabled,setEnabled]=useState(task.enabled),[interval,setInterval]=useState(task.interval_seconds),[pending,setPending]=useState(false),[error,setError]=useState<string|null>(null);
 const active=useRef(true),admitted=useRef(false);useEffect(()=>{active.current=true;return()=>{active.current=false}},[]);
 if(!task.configuration_available)return null;
 const save=async()=>{
  if(admitted.current||actor.current!==task.actor_uuid)return;
  const token=getAccessToken();admitted.current=true;setPending(true);setError(null);
  try{await configureScheduledTask(task.base,task,enabled,interval);if(active.current&&actor.current===task.actor_uuid&&token===getAccessToken())await onSaved();}
  catch{if(active.current&&actor.current===task.actor_uuid&&token===getAccessToken())setError('Change could not be confirmed. Close, refresh and inspect this schedule before another attempt.');}
  finally{admitted.current=false;if(active.current)setPending(false);}
 };
 return <div className="space-y-4"><div className="flex items-center gap-2"><Checkbox id="scheduled-sync-enabled" checked={enabled} disabled={pending} onCheckedChange={v=>setEnabled(v===true)}/><Label htmlFor="scheduled-sync-enabled">Enable scheduled synchronization</Label></div><Label htmlFor="scheduled-sync-interval">Interval in seconds (60–86400)</Label><Input id="scheduled-sync-interval" type="number" min={60} max={86400} value={interval} disabled={pending} onChange={e=>setInterval(Number(e.target.value))}/><p className="text-sm text-muted-foreground">Enabling or changing this schedule makes it due immediately. Synchronization reads the configured provider and updates local users and libraries.</p>{error&&<p className="text-sm text-destructive">{error}</p>}<Button onClick={()=>void save()} disabled={pending||Boolean(error)||!Number.isSafeInteger(interval)||interval<60||interval>86400||enabled===task.enabled&&interval===task.interval_seconds}>Save schedule</Button></div>;
}
