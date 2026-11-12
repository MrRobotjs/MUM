import { useAccountDisplay } from '../../hooks/useAccountDisplay';
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { PlexConnectionController, type PlexConnectionState } from '../../lib/plexConnection';
import { Button } from '../ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Alert, AlertDescription } from '../ui/alert';
import { Checkbox } from '../ui/checkbox';
import { Spinner } from '../ui/spinner';

const initial: PlexConnectionState = {phase:'loading',busy:false,enabled:false,connection:null,challenge:null,error:null};
function PlexConnectionPanel({owner}:{owner:string}) {
  const { formatTimestamp } = useAccountDisplay();
 const [state,setState] = useState(initial);
 const [disconnectAcknowledged,setDisconnectAcknowledged] = useState(false);
 const controller = useRef<PlexConnectionController | null>(null);
 useEffect(() => {
  const current = new PlexConnectionController(owner,setState);controller.current = current;
  void current.reload();
  return () => {current.dispose();controller.current = null;};
 },[owner]);
 useEffect(() => {
  if (!state.challenge) return;
  const timer = window.setTimeout(() => controller.current?.expire(),Math.max(0,Date.parse(state.challenge.expires_at)-Date.now()));
  return () => window.clearTimeout(timer);
 },[state.challenge]);
 useEffect(() => {setDisconnectAcknowledged(false);},[state.connection?.id,state.phase]);
 return <Card>
  <CardHeader>
   <CardTitle>Plex Account Connection</CardTitle>
   <CardDescription>Verify a personal Plex account. This does not enable Plex sign-in or grant library access.</CardDescription>
  </CardHeader>
  <CardContent><div className="space-y-4">
   {state.error && <Alert variant="destructive"><AlertDescription>{state.error}</AlertDescription></Alert>}
   {state.phase==='loading' && <Spinner className="h-4 w-4 mr-2" />}
   {!state.enabled && state.phase!=='loading' && state.phase!=='error' && <p className="text-sm text-muted-foreground">An administrator must enable Plex connections before authorization.</p>}
   {state.connection && state.phase!=='uncertain' && <>
    <p className="text-sm text-muted-foreground">Connected account: {state.connection.username} (Plex ID {state.connection.account_id}).</p>
    <label className="flex items-start gap-2 text-sm"><Checkbox checked={disconnectAcknowledged} onCheckedChange={value => setDisconnectAcknowledged(value===true)} disabled={state.busy} /><span>Disconnect only this local connection. Plex devices, sessions and existing library shares will remain.</span></label>
    <Button variant="outline" disabled={state.busy || !disconnectAcknowledged} onClick={() => void controller.current?.disconnect()}>Disconnect Local Connection</Button>
   </>}
   {state.challenge?.authorization_url && state.phase==='pending' && <>
    <Button asChild variant="outline"><a href={state.challenge.authorization_url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Open Plex Authorization</a></Button>
    <p className="text-sm text-muted-foreground">Authorize in the Plex tab, then return here and check approval. Keep this page open; the request expires at {formatTimestamp(state.challenge.expires_at, 'time')}.</p>
   </>}
   {state.phase==='pending' && <Button variant="outline" disabled={state.busy || !state.enabled} onClick={() => void controller.current?.poll()}>Check Plex Approval</Button>}
   {state.phase==='verified' && state.challenge?.account && <>
    <p className="text-sm text-muted-foreground">Plex verified {state.challenge.account.username} (Plex ID {state.challenge.account.id}). Confirm only if this is your account.</p>
    <Button disabled={state.busy || !state.enabled} onClick={() => void controller.current?.confirm()}>Confirm This Plex Account</Button>
   </>}
   {!state.connection && ['ready','expired','error'].includes(state.phase) && <Button type="button" variant="outline" className="w-full text-lg h-12 hover:-translate-y-0.5 hover:shadow-lg transition-all duration-200 ease-in-out border-orange-600 text-orange-700 dark:text-orange-400 hover:bg-orange-50 dark:hover:bg-orange-950 hover:border-orange-600" disabled={state.busy || !state.enabled} onClick={() => void controller.current?.start()}>
    <svg className="w-5 h-5 mr-3" viewBox="0 0 192 192" xmlns="http://www.w3.org/2000/svg" fill="currentColor" stroke="transparent" strokeLinejoin="round" strokeWidth="12"><path d="M22 25.5h48L116 94l-46 68.5H22L68.5 94Zm109.8 56L108 46l14-20.5h48zm-.3 23.5c10.979 17.625 25.52 38.875 38.5 49.5-11.149 13.635-34.323 32.278-62.5-14z"/></svg>
    Connect Plex Account</Button>}
   <Button type="button" variant="outline" disabled={state.busy} onClick={() => void controller.current?.reload()}>Check Current Connection</Button>
   {state.busy && <Spinner className="h-4 w-4 mr-2" />}
  </div></CardContent>
 </Card>;
}
export function PlexConnectionCard() {
 const {user,isAuthenticated} = useAuth();
 return user && isAuthenticated ? <PlexConnectionPanel key={user.uuid} owner={user.uuid} /> : null;
}
