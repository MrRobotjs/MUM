import {useEffect,useRef,useState} from 'react';
import {Card,CardContent,CardDescription,CardHeader,CardTitle} from '../ui/card';
import {Button} from '../ui/button';import {Input} from '../ui/input';import {Label} from '../ui/label';import {Checkbox} from '../ui/checkbox';
import {useAuth} from '../../contexts/AuthContext';import {useAlerts} from '../../contexts/AlertContext';
import {fetchPersonalProfile,type PersonalProfile} from '../../lib/plexConnection';import {changeOwnEmail} from '../../lib/accountEmail';
export function AccountEmailCard({onChanged}:{onChanged?:()=>Promise<void>}){
 const {user}=useAuth();const {success}=useAlerts();const generation=useRef(0),pending=useRef(false);
 const [profile,setProfile]=useState<PersonalProfile|null>(null),[email,setEmail]=useState(''),[password,setPassword]=useState(''),[ack,setAck]=useState(false),[busy,setBusy]=useState(true),[error,setError]=useState<string|null>(null);
 const load=async(run:number)=>{const p=await fetchPersonalProfile();if(run!==generation.current)return;if(p.uuid!==user?.uuid)throw Error('The signed-in account changed.');setProfile(p);setEmail(p.email??'');};
 useEffect(()=>{const run=++generation.current;pending.current=false;setBusy(true);setProfile(null);setEmail('');setPassword('');setAck(false);setError(null);if(user?.uuid)void load(run).catch(()=>{if(run===generation.current)setError('Could not read the current profile. Refresh before editing.');}).finally(()=>{if(run===generation.current)setBusy(false);});return()=>{generation.current++;};},[user?.uuid]);
 const refresh=async()=>{if(pending.current)return;const run=generation.current;setBusy(true);setPassword('');setAck(false);setError(null);try{await load(run);}catch{if(run===generation.current){setProfile(null);setError('Could not read the current profile. Try refreshing again.');}}finally{if(run===generation.current)setBusy(false);}};
 const submit=async(e:React.FormEvent)=>{e.preventDefault();if(!user || !profile?.email_change_available || pending.current)return;const run=generation.current;pending.current=true;setBusy(true);setError(null);
  try{const result=await changeOwnEmail(user.uuid,profile.profile_revision,{email,current_password:password,acknowledge_unverified_contact:ack});if(run!==generation.current)return;setProfile({...profile,email:result.email,profile_revision:result.profile_revision});setEmail(result.email??'');success(result.email?'Unverified contact email saved.':'Contact email cleared.');if(onChanged)try{await onChanged();}catch{/* The committed result remains valid even if another view cannot refresh. */}}
  catch(e){if(run!==generation.current)return;setError((e as Error).message);try{await load(run);}catch{if(run===generation.current)setProfile(null);}}
  finally{if(run===generation.current){setPassword('');setAck(false);setBusy(false);pending.current=false;}}
 };
 return <Card><CardHeader><CardTitle>Account Email</CardTitle><CardDescription>Save an unverified MUM contact address. Leave it empty to clear it. This does not verify ownership, enable password recovery or change a server email.</CardDescription></CardHeader><CardContent><form className="space-y-4" onSubmit={e=>void submit(e)}>
  <div className="space-y-2"><Label htmlFor="account-email">Email</Label><Input id="account-email" type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@example.com" maxLength={254} disabled={busy || !profile?.email_change_available}/></div>
  <div className="space-y-2"><Label htmlFor="email-current-password">Current Local Password</Label><Input id="email-current-password" type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} disabled={busy || !profile?.email_change_available} required/></div>
  <label className="flex items-start gap-3"><Checkbox checked={ack} onCheckedChange={v=>setAck(v===true)} disabled={busy || !profile?.email_change_available}/><span>I understand this contact address is unverified and is not a login or recovery identity.</span></label>
  {error?<p className="text-sm text-destructive">{error}</p>:null}
  <Button type="submit" className="w-full sm:w-auto" disabled={busy || !profile?.email_change_available || !ack}>{busy?'Saving...':'Save Email'}</Button>
  <Button type="button" variant="outline" onClick={()=>void refresh()} disabled={busy}>Refresh Profile</Button>
 </form></CardContent></Card>;
}
