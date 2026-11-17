import { useEffect, useRef, useState } from 'react';
import { Card, CardContent } from '../ui/card';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { useAuth } from '../../contexts/AuthContext';
import { useAlerts } from '../../contexts/AlertContext';
import { fetchOwnUsername, changeOwnUsername, type AccountUsername } from '../../lib/accountUsername';
import { ConfirmAction, SettingHeader } from './AccountSettings';

export function UsernameChangeCard() {
  const { user } = useAuth();
  const { success } = useAlerts();
  const generation = useRef(0), activeOwner = useRef(user?.uuid), pending = useRef(false);
  activeOwner.current = user?.uuid;
  const [profile, setProfile] = useState<AccountUsername | null>(null);
  const [username, setUsername] = useState(''), [password, setPassword] = useState('');
  const [open, setOpen] = useState(false), [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const load = async (run: number) => {
    if (!user) return;
    const result = await fetchOwnUsername(user.uuid);
    if (run === generation.current && activeOwner.current === user.uuid) { setProfile(result); setUsername(result.username); }
  };
  useEffect(() => {
    const run = ++generation.current;
    pending.current = false; setProfile(null); setUsername(''); setPassword(''); setOpen(false); setConfirming(false); setError(null); setBusy(true);
    void load(run).catch(() => { if (run === generation.current) setError('Could not read the current username.'); }).finally(() => { if (run === generation.current) setBusy(false); });
    return () => { generation.current++; };
  }, [user?.uuid]);
  // Refresh is offered only beside an error, to read the username again.
  const refresh = async () => {
    if (pending.current) return;
    const run = generation.current;
    pending.current = true; setBusy(true); setPassword(''); setError(null);
    try { await load(run); } catch { if (run === generation.current) { setProfile(null); setError('Could not read the current username. Try refreshing again.'); } }
    finally { if (run === generation.current) { pending.current = false; setBusy(false); } }
  };
  const close = () => { setOpen(false); setPassword(''); setUsername(profile?.username ?? ''); };
  // Submitting the form only asks; the change runs from the confirmation.
  const ask = (event: React.FormEvent) => {
    event.preventDefault();
    if (!profile?.username_change_available || pending.current || busy || error) return;
    setConfirming(true);
  };
  const change = async () => {
    if (!user || !profile?.username_change_available || pending.current) return;
    const run = generation.current, owner = user.uuid;
    const scoped = () => run === generation.current && activeOwner.current === owner;
    pending.current = true; setBusy(true); setError(null);
    try {
      const result = await changeOwnUsername(profile, { username, current_password: password, acknowledge_revoke_sessions: true });
      if (scoped()) { setOpen(false); success(`Username changed. Sign in with ${result.username} and your existing password.`); }
    } catch (e) { if (scoped()) setError((e as Error).message); }
    finally { if (scoped()) { setPassword(''); setConfirming(false); pending.current = false; setBusy(false); } }
  };
  const available = Boolean(profile?.username_change_available);
  return <Card>
    <SettingHeader title="Username" summary={profile?.username ?? (busy ? '' : 'Not set')}
      info={<><p>Your MUM sign-in name. Changing it signs out every session, including this one; your password, account and media server usernames stay the same.</p><p>Use 1 to 255 English letters, numbers, spaces and standard symbols (no accents or emoji). Names are not case-sensitive, and spaces at the start and end are removed.</p></>}
      action={<Button type="button" variant="outline" size="sm" aria-expanded={open} disabled={!available || busy || Boolean(error)} onClick={() => open ? close() : setOpen(true)}>{open ? 'Cancel' : 'Change'}</Button>} />
    {open || error ? <CardContent>
      {open ? <form className="space-y-4" onSubmit={ask}>
        <div className="space-y-2"><Label htmlFor="account-new-username">New username</Label><Input id="account-new-username" autoComplete="username" value={username} onChange={e => setUsername(e.target.value)} minLength={1} maxLength={255} disabled={busy || Boolean(error)} required /></div>
        <div className="space-y-2"><Label htmlFor="username-current-password">Current password</Label><Input id="username-current-password" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} minLength={12} maxLength={1024} disabled={busy || Boolean(error)} required /></div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <Button type="submit" className="w-full sm:w-auto" disabled={busy || Boolean(error) || username.trim() === profile?.username}>{busy ? 'Saving…' : 'Save username'}</Button>
      </form> : null}
      {error ? <div className="account-setting-error flex flex-wrap items-center gap-3">{open ? null : <p className="text-sm text-destructive">{error}</p>}<Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void refresh()}>Refresh</Button></div> : null}
    </CardContent> : null}
    <ConfirmAction open={confirming} onOpenChange={setConfirming} title="Change your username?" confirmLabel="Change username" busy={busy} onConfirm={() => void change()}>
      This signs out every session, including this one. Sign in again with your new username and your existing password.
    </ConfirmAction>
  </Card>;
}
