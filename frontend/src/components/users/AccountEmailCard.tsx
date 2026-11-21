import {useEffect,useRef,useState} from 'react';
import { CardActions } from '../common/CardActions';
import {Card,CardContent} from '../ui/card';
import {Button} from '../ui/button';import {Input} from '../ui/input';import {Label} from '../ui/label';
import {useAuth} from '../../contexts/AuthContext';import {useAlerts} from '../../contexts/AlertContext';
import {fetchPersonalProfile,type PersonalProfile} from '../../lib/plexConnection';import {changeOwnEmail} from '../../lib/accountEmail';
import {ConfirmAction,SettingHeader} from './AccountSettings';
export function AccountEmailCard({onChanged}:{onChanged?:()=>Promise<void>}){
 const {user}=useAuth();const {success}=useAlerts();const generation=useRef(0),pending=useRef(false);
 const [profile,setProfile]=useState<PersonalProfile|null>(null),[email,setEmail]=useState(''),[password,setPassword]=useState(''),[busy,setBusy]=useState(true),[error,setError]=useState<string|null>(null);
 const [open,setOpen]=useState(false),[confirming,setConfirming]=useState(false);
 const load=async(run:number)=>{const p=await fetchPersonalProfile();if(run!==generation.current)return;if(p.uuid!==user?.uuid)throw Error('The signed-in account changed.');setProfile(p);setEmail(p.email??'');};
 useEffect(()=>{const run=++generation.current;pending.current=false;setBusy(true);setProfile(null);setEmail('');setPassword('');setOpen(false);setConfirming(false);setError(null);if(user?.uuid)void load(run).catch(()=>{if(run===generation.current)setError('Could not read the current profile.');}).finally(()=>{if(run===generation.current)setBusy(false);});return()=>{generation.current++;};},[user?.uuid]);
 // Refresh is offered only beside an error, to read the profile again.
 const refresh=async()=>{if(pending.current)return;const run=generation.current;setBusy(true);setPassword('');setError(null);try{await load(run);}catch{if(run===generation.current){setProfile(null);setError('Could not read the current profile. Try refreshing again.');}}finally{if(run===generation.current)setBusy(false);}};
 const close=()=>{setOpen(false);setPassword('');setEmail(profile?.email??'');};
 // Submitting the form only asks; the save runs from the confirmation, which
 // is where the unverified-address acknowledgement comes from.
 const ask=(e:React.FormEvent)=>{e.preventDefault();if(!profile?.email_change_available || pending.current)return;setConfirming(true);};
 const save=async()=>{if(!user || !profile?.email_change_available || pending.current)return;const run=generation.current;pending.current=true;setBusy(true);setError(null);
  try{const result=await changeOwnEmail(user.uuid,profile.profile_revision,{email,current_password:password,acknowledge_unverified_contact:true});if(run!==generation.current)return;setProfile({...profile,email:result.email,profile_revision:result.profile_revision});setEmail(result.email??'');setOpen(false);success(result.email?'Unverified contact email saved.':'Contact email cleared.');if(onChanged)try{await onChanged();}catch{/* The committed result remains valid even if another view cannot refresh. */}}
  catch(e){if(run!==generation.current)return;setError((e as Error).message);try{await load(run);}catch{if(run===generation.current)setProfile(null);}}
  finally{if(run===generation.current){setPassword('');setConfirming(false);setBusy(false);pending.current=false;}}
 };
 const available=Boolean(profile?.email_change_available);
 const clearing=email.trim()==='';
 return <Card>
  <SettingHeader title="Contact email" summary={profile?(profile.email??'Not set'):''}
   info={<><p>A contact address kept on your MUM profile.</p><p>It is not verified: it cannot be used to sign in or recover your account, and it does not change your media server email.</p></>}
   action={<Button type="button" variant="outline" size="sm" aria-expanded={open} disabled={!available || busy && !open} onClick={()=>open?close():setOpen(true)}>{open?'Cancel':'Change'}</Button>}/>
  {open || error ? <CardContent>
   {open ? <form className="space-y-4" onSubmit={ask}>
    <div className="space-y-2"><Label htmlFor="account-email">Email</Label><Input id="account-email" type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@example.com" maxLength={254} disabled={busy || !available}/></div>
    <div className="space-y-2"><Label htmlFor="email-current-password">Current password</Label><Input id="email-current-password" type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} disabled={busy || !available} required/></div>
    {error?<p className="text-sm text-destructive">{error}</p>:null}
    <CardActions><Button type="submit" disabled={busy || !available}>{busy?'Saving...':clearing?'Clear email':'Save email'}</Button></CardActions>
   </form> : null}
   {error && !open ? <div className="account-setting-error flex flex-wrap items-center gap-3"><p className="text-sm text-destructive">{error}</p><Button type="button" variant="outline" size="sm" disabled={busy} onClick={()=>void refresh()}>Refresh</Button></div> : null}
  </CardContent> : null}
  <ConfirmAction open={confirming} onOpenChange={setConfirming} title={clearing?'Clear your contact email?':'Save this contact email?'} confirmLabel={clearing?'Clear email':'Save email'} busy={busy} onConfirm={()=>void save()}>
   {clearing?'Your profile will have no contact address.':'This address is not verified. It cannot be used to sign in or recover your account.'}
  </ConfirmAction>
 </Card>;
}
