import { useAccountDisplay } from '../../hooks/useAccountDisplay';
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { PlexConnectionController, type PlexConnectionState } from '../../lib/plexConnection';
import { Button } from '../ui/button';
import { Card, CardContent } from '../ui/card';
import { ConfirmAction, SettingHeader } from './AccountSettings';
import { Spinner } from '../ui/spinner';

const initial: PlexConnectionState = {phase:'loading',busy:false,enabled:false,connection:null,challenge:null,error:null};
function PlexConnectionPanel({owner}:{owner:string}) {
  const { formatTimestamp } = useAccountDisplay();
 const [state,setState] = useState(initial);
 const [disconnecting,setDisconnecting] = useState(false);
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
 // Plex opens in a separate window, opened during the click so the browser
 // does not block it; the account links as soon as Plex approves.
 const connect = () => {
  const popup = window.open('', 'mum-plex-connect', 'width=600,height=750');
  void controller.current?.connect(url => {
   if (popup && !popup.closed) {popup.opener = null;popup.location.href = url;}
   else window.open(url,'_blank','noopener');
  }, () => popup !== null && popup.closed).finally(() => {if (popup && !popup.closed) popup.close();});
 };
 const linked = state.connection && state.phase!=='uncertain' ? state.connection : null;
 const canConnect = !linked && state.enabled && ['ready','expired','error'].includes(state.phase);
 const summary = state.phase==='loading' ? <Spinner className="h-4 w-4" /> : linked ? linked.username : state.enabled ? 'Not linked' : 'Not available';
 return <Card>
  <SettingHeader title="Plex" summary={summary}
   info={<>
    <p>Link your personal Plex account to use Sign in with Plex on the sign-in page. Linking does not grant library access.</p>
    {!state.enabled && <p>An administrator must turn on Plex connections first.</p>}
    {linked && <p>Linked Plex account: {linked.username} (Plex ID {linked.account_id}).</p>}
    {linked?.on_server === false && <p>This Plex account isn't on any of this server's Plex servers, but you can still use it to sign in to MUM.</p>}
   </>}
   action={linked
    ? <Button type="button" variant="outline" size="sm" disabled={state.busy} onClick={() => setDisconnecting(true)}>Disconnect</Button>
    : canConnect && <Button type="button" variant="outline" size="sm" className="border-orange-600 text-orange-700 dark:text-orange-400 hover:bg-orange-50 dark:hover:bg-orange-950 hover:border-orange-600" disabled={state.busy || !state.enabled} onClick={connect}>Connect Plex</Button>} />
  {(state.error || state.phase==='pending' || state.phase==='verified' || state.phase==='uncertain') && <CardContent><div className="space-y-4">
   {state.error && <div className="account-setting-error flex flex-wrap items-center gap-3"><p className="text-sm text-destructive">{state.error}</p><Button type="button" variant="outline" size="sm" disabled={state.busy} onClick={() => void controller.current?.reload()}>Try again</Button></div>}
   {state.challenge?.authorization_url && state.phase==='pending' && <p className="text-sm text-muted-foreground">
    Approve in the Plex window; this page links your account as soon as Plex confirms it. Keep this page open until {formatTimestamp(state.challenge.expires_at, 'time')}.{' '}
    <a href={state.challenge.authorization_url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" className="font-medium text-primary hover:underline">Open Plex again</a>
   </p>}
   {state.phase==='verified' && state.challenge?.account && <>
    <p className="text-sm text-muted-foreground">Plex verified {state.challenge.account.username} (Plex ID {state.challenge.account.id}). Confirm only if this is your account.</p>
    <Button disabled={state.busy || !state.enabled} onClick={() => void controller.current?.confirm()}>Confirm This Plex Account</Button>
   </>}
   {state.phase==='uncertain' && !state.error && <Button type="button" variant="outline" size="sm" disabled={state.busy} onClick={() => void controller.current?.reload()}>Try again</Button>}
  </div></CardContent>}
  <ConfirmAction open={disconnecting} onOpenChange={setDisconnecting} title="Disconnect Plex?" confirmLabel="Disconnect" destructive busy={state.busy}
   onConfirm={() => void controller.current?.disconnect().finally(() => setDisconnecting(false))}>
   Sign in with Plex stops working for this account. Your Plex devices, sessions and library shares stay as they are.
  </ConfirmAction>
 </Card>;
}
export function PlexConnectionCard() {
 const {user,isAuthenticated} = useAuth();
 return user && isAuthenticated ? <PlexConnectionPanel key={user.uuid} owner={user.uuid} /> : null;
}
