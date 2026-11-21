import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { getAuthSnapshot, subscribeToAuthStore } from '../../store/authStore';
import { signOutUserEverywhere } from '../../lib/accountSessions';
import { Card, CardContent } from '../ui/card';
import { Button } from '../ui/button';
import { ConfirmAction, SettingHeader } from './AccountSettings';

export function AdminSessionsCard({ target, name, owner }: { target: string; name: string; owner: boolean }) {
  const { user, isAdministrator } = useAuth();
  const auth = useSyncExternalStore(subscribeToAuthStore, getAuthSnapshot, getAuthSnapshot);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const generation = useRef(0);
  const pending = useRef(false);
  const confirmedFor = useRef<{ target: string; generation: number } | null>(null);
  useEffect(() => { generation.current++; pending.current = false; setBusy(false); setMessage(''); setConfirming(false); confirmedFor.current = null; return () => { generation.current++; }; }, [target, auth.generation]);
  if (!isAdministrator || !auth.accessToken || owner || target === user?.uuid) return null;
  const signOut = async () => {
    if (pending.current || confirmedFor.current?.target !== target || confirmedFor.current?.generation !== getAuthSnapshot().generation) return;
    const run = generation.current, started = getAuthSnapshot();
    pending.current = true; setBusy(true); setMessage('');
    try {
      const count = await signOutUserEverywhere(target);
      if (run === generation.current && getAuthSnapshot() === started) {
        setMessage(count === 1 ? '1 session signed out.' : `${count} sessions signed out.`); setConfirming(false);
      }
    } catch (error) {
      if (run === generation.current && getAuthSnapshot() === started) setMessage(error instanceof Error ? error.message : 'Could not sign out sessions.');
    } finally { if (run === generation.current) { pending.current = false; setBusy(false); } }
  };
  return <Card>
    <SettingHeader title="Signed-in devices" info={<p>Sign this person out of every MUM session. They can sign in again if their account allows it.</p>}
      action={<Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => { confirmedFor.current = { target, generation: getAuthSnapshot().generation }; setMessage(''); setConfirming(true); }}>Sign out all devices</Button>} />
    {message && <CardContent><p role="status" className="text-sm text-muted-foreground">{message}</p></CardContent>}
    <ConfirmAction open={confirming} onOpenChange={setConfirming} title={`Sign out ${name}?`} confirmLabel="Sign out all devices" busy={busy} onConfirm={() => void signOut()}>
      <p>All of this person's MUM sessions will end. Their media server sessions and accounts are unchanged.</p>
    </ConfirmAction>
  </Card>;
}
