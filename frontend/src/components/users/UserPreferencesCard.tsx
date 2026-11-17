import {useEffect,useRef,useState} from 'react';
import {Card,CardContent} from '../ui/card';import {Button} from '../ui/button';import {Label} from '../ui/label';import {Switch} from '../ui/switch';
import {useUserPreferences} from '../../hooks/useUserPreferences';import {useAuth} from '../../contexts/AuthContext';import {useAlerts} from '../../contexts/AlertContext';
import {SettingHeader} from './AccountSettings';
// Each switch saves when it is turned (one request, never repeated); a
// refused save puts the switch back.
export function UserPreferencesCard(){
 const {user}=useAuth();const prefs=useUserPreferences();const {success,error:showError}=useAlerts();
 const counter=prefs.getPreference('stream_counter',false);
 const [draftCounter,setCounter]=useState(counter),[draftSync,setSync]=useState(prefs.syncEnabled??false),[busy,setBusy]=useState(false);
 const generation=useRef(0),pending=useRef(false);
 useEffect(()=>{generation.current++;setBusy(false);pending.current=false;return()=>{generation.current++;};},[user?.uuid]);
 useEffect(()=>{setCounter(counter);setSync(prefs.syncEnabled??false);},[user?.uuid,prefs.revision,prefs.syncEnabled,counter]);
 const save=async(action:'counter'|'sync',value:boolean)=>{
  if(pending.current || prefs.syncEnabled===undefined)return;
  const current=generation.current;pending.current=true;setBusy(true);
  if(action==='counter')setCounter(value);else setSync(value);
  try{if(action==='counter')await prefs.setPreference('stream_counter',value);else await prefs.toggleSync(value);if(current===generation.current)success(action==='counter'?'Display preference saved.':value?'Preference sync enabled.':'Preference sync disabled.');}
  catch(e){if(current===generation.current){if(action==='counter')setCounter(counter);else setSync(prefs.syncEnabled??false);showError((e as Error).message);}}
  finally{if(current===generation.current){pending.current=false;setBusy(false);}}
 };
 const disabled=busy || prefs.loading || Boolean(prefs.error) || prefs.syncEnabled===undefined;
 return (
  <Card>
   <SettingHeader title="Stream counter & sync" info={<>
    <p>The stream-counter badge is shown beside Streaming when that page is available.</p>
    <p>With sync on, this setting is saved to your account and other devices pick it up when refreshed; turning sync on saves this device's setting to your account. With sync off, it is saved only on this device. Timezone settings are always saved separately.</p>
   </>}/>
   <CardContent className="space-y-5">
    <div className="account-preference-row flex items-start justify-between gap-4">
     <Label htmlFor="stream-counter-preference">Show stream-counter badge</Label>
     <Switch id="stream-counter-preference" checked={draftCounter} onCheckedChange={value=>void save('counter',value)} disabled={disabled}/>
    </div>
    <div className="account-preference-row flex items-start justify-between gap-4">
     <Label htmlFor="sync-preferences">Sync across devices</Label>
     <Switch id="sync-preferences" checked={draftSync} onCheckedChange={value=>void save('sync',value)} disabled={disabled}/>
    </div>
    {prefs.error?<div className="account-setting-error flex flex-wrap items-center gap-3"><p className="text-sm text-destructive">{prefs.error.message}</p><Button type="button" variant="outline" size="sm" onClick={()=>void prefs.refresh()} disabled={busy || prefs.loading}>Refresh</Button></div>:null}
   </CardContent>
  </Card>
 );
}
