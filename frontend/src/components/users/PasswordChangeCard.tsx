import {useEffect,useRef,useState} from 'react';
import {Card,CardContent,CardDescription,CardHeader,CardTitle} from '../ui/card';
import {Button} from '../ui/button';
import {Input} from '../ui/input';
import {Label} from '../ui/label';
import {Checkbox} from '../ui/checkbox';
import {useAuth} from '../../contexts/AuthContext';
import {useAlerts} from '../../contexts/AlertContext';
import {fetchPersonalProfile} from '../../lib/plexConnection';
import {changeOwnPassword} from '../../lib/accountPassword';
const empty=()=>({current_password:'',new_password:'',confirm_password:'',acknowledge_revoke_sessions:false});
export function PasswordChangeCard(){
 const {user}=useAuth();const {success,error:showError}=useAlerts();
 const [form,setForm]=useState(empty);const [enabled,setEnabled]=useState(false);const [busy,setBusy]=useState(false);const [error,setError]=useState<string|null>(null);
 const generation=useRef(0),pending=useRef(false);
 useEffect(()=>{const run=++generation.current;setForm(empty());setBusy(false);setEnabled(false);setError(null);pending.current=false;
  if(user?.uuid)void fetchPersonalProfile().then(p=>{if(generation.current===run && p.uuid===user.uuid)setEnabled(p.has_password && p.password_change_available);}).catch(()=>{if(generation.current===run)setError('Could not verify password-change availability. Reopen your account page.');});
  return ()=>{generation.current++;};
 },[user?.uuid]);
 const submit=async(event:React.FormEvent)=>{event.preventDefault();if(!user || !enabled || pending.current)return;const run=generation.current;pending.current=true;setBusy(true);setError(null);
  try{await changeOwnPassword(user.uuid,form);if(run===generation.current)success('Password changed. All sessions were signed out. Sign in with your new password.');}
  catch(e){if(run===generation.current){const message=(e as Error).message;setError(message);showError(message);}}
  finally{if(run===generation.current){setForm(empty());setBusy(false);pending.current=false;}}
 };
 return <Card><CardHeader><CardTitle>Change Password</CardTitle><CardDescription>Change your local password and sign out all sessions. Sign in again afterward. Server passwords and Plex access are unchanged.</CardDescription></CardHeader><CardContent>
  <form className="space-y-4" onSubmit={event=>void submit(event)}>
   {(['current_password','new_password','confirm_password'] as const).map((name,index)=><div className="space-y-2" key={name}><Label htmlFor={`account-${name}`}>{['Current Password','New Password','Confirm New Password'][index]}</Label><Input id={`account-${name}`} type="password" autoComplete={index===0?'current-password':'new-password'} value={form[name]} onChange={e=>setForm(p=>({...p,[name]:e.target.value}))} minLength={12} maxLength={1024} disabled={busy || !enabled} required/></div>)}
   <label className="flex items-start gap-3"><Checkbox checked={form.acknowledge_revoke_sessions} onCheckedChange={value=>setForm(p=>({...p,acknowledge_revoke_sessions:value===true}))} disabled={busy || !enabled}/><span>I authorize signing out every session, including this one.</span></label>
   {error?<p className="text-sm text-destructive">{error}</p>:null}
   <Button type="submit" className="w-full" disabled={busy || !enabled || !form.acknowledge_revoke_sessions}>{busy?'Updating...':'Update Password'}</Button>
  </form>
 </CardContent></Card>;
}
