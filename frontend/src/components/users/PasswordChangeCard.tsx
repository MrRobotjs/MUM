import {useEffect,useRef,useState} from 'react';
import {Card,CardContent} from '../ui/card';
import {Button} from '../ui/button';
import {Input} from '../ui/input';
import {Label} from '../ui/label';
import {useAuth} from '../../contexts/AuthContext';
import {useAlerts} from '../../contexts/AlertContext';
import {fetchPersonalProfile} from '../../lib/plexConnection';
import {changeOwnPassword} from '../../lib/accountPassword';
import {ConfirmAction,SettingHeader} from './AccountSettings';
const empty=()=>({current_password:'',new_password:'',confirm_password:''});
const fields=[['current_password','Current password'],['new_password','New password'],['confirm_password','Confirm new password']] as const;
export function PasswordChangeCard(){
 const {user}=useAuth();const {success}=useAlerts();
 const [form,setForm]=useState(empty);const [enabled,setEnabled]=useState(false);const [busy,setBusy]=useState(false);const [error,setError]=useState<string|null>(null);
 const [open,setOpen]=useState(false),[confirming,setConfirming]=useState(false);
 const generation=useRef(0),pending=useRef(false);
 useEffect(()=>{const run=++generation.current;setForm(empty());setBusy(false);setEnabled(false);setError(null);setOpen(false);setConfirming(false);pending.current=false;
  if(user?.uuid)void fetchPersonalProfile().then(p=>{if(generation.current===run && p.uuid===user.uuid)setEnabled(p.has_password && p.password_change_available);}).catch(()=>{if(generation.current===run)setError('Could not verify password-change availability. Reopen your account page.');});
  return ()=>{generation.current++;};
 },[user?.uuid]);
 const close=()=>{setOpen(false);setForm(empty());setError(null);};
 // Submitting the form only asks; the change runs from the confirmation.
 const ask=(event:React.FormEvent)=>{event.preventDefault();if(!enabled || pending.current)return;
  if(form.new_password!==form.confirm_password){setError('The new passwords do not match.');return;}
  setError(null);setConfirming(true);
 };
 const change=async()=>{if(!user || !enabled || pending.current)return;const run=generation.current;pending.current=true;setBusy(true);setError(null);
  try{await changeOwnPassword(user.uuid,{...form,acknowledge_revoke_sessions:true});if(run===generation.current){setOpen(false);success('Password changed. All sessions were signed out. Sign in with your new password.');}}
  catch(e){if(run===generation.current)setError((e as Error).message);}
  finally{if(run===generation.current){setForm(empty());setConfirming(false);setBusy(false);pending.current=false;}}
 };
 return <Card>
  <SettingHeader title="Password" summary={enabled?'Set':'Not available'}
   info={<><p>Changing your MUM password signs out every session, including this one. Sign in again afterward with the new password.</p><p>Use 12 to 1024 characters. Your media server passwords and Plex access do not change.</p></>}
   action={<Button type="button" variant="outline" size="sm" aria-expanded={open} disabled={!enabled || busy} onClick={()=>open?close():setOpen(true)}>{open?'Cancel':'Change'}</Button>}/>
  {open || error ? <CardContent>
   {open ? <form className="space-y-4" onSubmit={ask}>
    {fields.map(([name,label],index)=><div className="space-y-2" key={name}><Label htmlFor={`account-${name}`}>{label}</Label><Input id={`account-${name}`} type="password" autoComplete={index===0?'current-password':'new-password'} value={form[name]} onChange={e=>setForm(p=>({...p,[name]:e.target.value}))} minLength={12} maxLength={1024} disabled={busy} required/></div>)}
    {error?<p className="text-sm text-destructive">{error}</p>:null}
    <Button type="submit" className="w-full sm:w-auto" disabled={busy}>{busy?'Updating...':'Update password'}</Button>
   </form> : <p className="text-sm text-destructive">{error}</p>}
  </CardContent> : null}
  <ConfirmAction open={confirming} onOpenChange={setConfirming} title="Change your password?" confirmLabel="Change password" busy={busy} onConfirm={()=>void change()}>
   This signs out every session, including this one. You will sign in again with your new password.
  </ConfirmAction>
 </Card>;
}
