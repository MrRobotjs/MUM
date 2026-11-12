import {useEffect,useRef,useState} from 'react';
import {Card,CardContent,CardDescription,CardHeader,CardTitle} from '../ui/card';import {Button} from '../ui/button';import {Label} from '../ui/label';import {Switch} from '../ui/switch';
import {Alert,AlertDescription} from '../ui/alert';import {FontAwesomeIcon} from '@fortawesome/react-fontawesome';import {faArrowRightArrowLeft,faCircleInfo} from '@fortawesome/free-solid-svg-icons';
import {useUserPreferences} from '../../hooks/useUserPreferences';import {useAuth} from '../../contexts/AuthContext';import {useAlerts} from '../../contexts/AlertContext';
export function UserPreferencesCard(){
 const {user}=useAuth();const prefs=useUserPreferences();const {success,error:showError}=useAlerts();
 const counter=prefs.getPreference('stream_counter',false);
 const [draftCounter,setCounter]=useState(counter),[draftSync,setSync]=useState(prefs.syncEnabled??false),[busy,setBusy]=useState(false);
 const generation=useRef(0),pending=useRef(false);
 useEffect(()=>{generation.current++;setBusy(false);pending.current=false;return()=>{generation.current++;};},[user?.uuid]);
 useEffect(()=>{setCounter(counter);setSync(prefs.syncEnabled??false);},[user?.uuid,prefs.revision,prefs.syncEnabled,counter]);
 const run=async(action:'counter'|'sync')=>{
  if(pending.current || prefs.syncEnabled===undefined)return;
  const current=generation.current;pending.current=true;setBusy(true);
  try{if(action==='counter')await prefs.setPreference('stream_counter',draftCounter);else await prefs.toggleSync(draftSync);if(current===generation.current)success(action==='counter'?'Display preference saved.':draftSync?'Preference sync enabled.':'Preference sync disabled.');}
  catch(e){if(current===generation.current)showError((e as Error).message);}
  finally{if(current===generation.current){pending.current=false;setBusy(false);}}
 };
 const disabled=busy || prefs.loading || Boolean(prefs.error) || prefs.syncEnabled===undefined;
 return <Card><CardHeader><CardTitle>User Preferences</CardTitle><CardDescription>Choose a device-local or synchronized stream-counter display preference. Enabling sync uploads this device's current supported setting; other devices read it when refreshed.</CardDescription></CardHeader><CardContent className="space-y-4">
  <div className="flex items-center justify-between gap-4"><Label htmlFor="stream-counter-preference">Show stream-counter badge</Label><Switch id="stream-counter-preference" checked={draftCounter} onCheckedChange={setCounter} disabled={disabled}/></div>
  <Button type="button" size="sm" onClick={()=>void run('counter')} disabled={disabled || draftCounter===counter}>Save Display Setting</Button>
  <div className="flex items-center justify-between gap-4"><div className="space-y-0.5"><Label htmlFor="sync-preferences" className="text-base font-medium cursor-pointer flex items-center gap-2">Sync preferences across devices<FontAwesomeIcon icon={faArrowRightArrowLeft} className="h-4 w-4" aria-hidden="true"/></Label><p className="text-sm text-muted-foreground">{prefs.syncEnabled?'The supported setting is saved to your account.':'The supported setting is saved only on this device.'}</p></div><Switch id="sync-preferences" checked={draftSync} onCheckedChange={setSync} disabled={disabled}/></div>
  <div className="flex items-center gap-3"><Button type="button" size="sm" onClick={()=>void run('sync')} disabled={disabled || draftSync===prefs.syncEnabled}>Save Sync Setting</Button>{draftSync!==prefs.syncEnabled?<span className="text-sm text-muted-foreground">Unsaved change</span>:null}</div>
  {draftSync?<Alert><FontAwesomeIcon icon={faCircleInfo} className="h-4 w-4"/><AlertDescription>When sync is enabled, the supported stream-counter preference is saved to your account. When disabled, device-local values take priority and the server snapshot is retained.</AlertDescription></Alert>:null}
  <Button type="button" variant="outline" onClick={()=>void prefs.refresh()} disabled={busy || prefs.loading}>Refresh Preferences</Button>
  {prefs.error?<p className="text-sm text-destructive">{prefs.error.message}</p>:null}
 </CardContent></Card>;
}
