import { useEffect, useRef, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Checkbox } from '../ui/checkbox';
import { useAuth } from '../../contexts/AuthContext';
import { useAlerts } from '../../contexts/AlertContext';
import { fetchOwnUsername, changeOwnUsername, type AccountUsername } from '../../lib/accountUsername';

export function UsernameChangeCard() {
  const { user } = useAuth();
  const { success } = useAlerts();
  const generation = useRef(0), activeOwner = useRef(user?.uuid), pending = useRef(false);
  activeOwner.current = user?.uuid;
  const [profile, setProfile] = useState<AccountUsername | null>(null);
  const [username, setUsername] = useState(''), [password, setPassword] = useState(''), [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const load = async (run: number) => {
    if (!user) return;
    const result = await fetchOwnUsername(user.uuid);
    if (run === generation.current && activeOwner.current === user.uuid) { setProfile(result); setUsername(result.username); }
  };
  useEffect(() => {
    const run = ++generation.current;
    pending.current = false; setProfile(null); setUsername(''); setPassword(''); setAck(false); setError(null); setBusy(true);
    void load(run).catch(() => { if (run === generation.current) setError('Could not read the current username. Refresh before editing.'); }).finally(() => { if (run === generation.current) setBusy(false); });
    return () => { generation.current++; };
  }, [user?.uuid]);
  const refresh = async () => {
    if (pending.current) return;
    const run = generation.current;
    pending.current = true; setBusy(true); setPassword(''); setAck(false); setError(null);
    try { await load(run); } catch { if (run === generation.current) { setProfile(null); setError('Could not read the current username. Try refreshing again.'); } }
    finally { if (run === generation.current) { pending.current = false; setBusy(false); } }
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!user || !profile?.username_change_available || pending.current || busy || error) return;
    const run = generation.current, owner = user.uuid;
    const scoped = () => run === generation.current && activeOwner.current === owner;
    pending.current = true; setBusy(true); setError(null);
    try {
      const result = await changeOwnUsername(profile, { username, current_password: password, acknowledge_revoke_sessions: ack });
      if (scoped()) success(`Username changed. Sign in with ${result.username} and your existing password.`);
    } catch (e) { if (scoped()) setError((e as Error).message); }
    finally { if (scoped()) { setPassword(''); setAck(false); pending.current = false; setBusy(false); } }
  };
  const disabled = busy || !profile?.username_change_available || Boolean(error);
  return <Card><CardHeader><CardTitle>Change Username</CardTitle><CardDescription>
    Change your MUM sign-in name and sign out every session. Your password, account identity and server usernames stay the same. Usernames are unique without regard to ASCII letter case.
  </CardDescription></CardHeader><CardContent><form className="space-y-4" onSubmit={event => void submit(event)}>
    <div className="space-y-2"><Label htmlFor="account-new-username">New Username</Label><Input id="account-new-username" autoComplete="username" value={username} onChange={e => setUsername(e.target.value)} minLength={1} maxLength={255} disabled={disabled} required /><p className="text-sm text-muted-foreground">Use 1–255 printable ASCII characters. Outer whitespace is trimmed.</p></div>
    <div className="space-y-2"><Label htmlFor="username-current-password">Current Local Password</Label><Input id="username-current-password" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} minLength={12} maxLength={1024} disabled={disabled} required /></div>
    <label className="flex items-start gap-3"><Checkbox checked={ack} onCheckedChange={value => setAck(value === true)} disabled={disabled} /><span>I authorize signing out every session, including this one.</span></label>
    {error ? <p className="text-sm text-destructive">{error}</p> : null}
    <Button type="submit" className="w-full sm:w-auto" disabled={disabled || !ack || username.trim() === profile?.username}>{busy ? 'Saving…' : 'Save Username'}</Button>
    <Button type="button" variant="outline" disabled={busy} onClick={() => void refresh()}>Refresh Username</Button>
  </form></CardContent></Card>;
}
