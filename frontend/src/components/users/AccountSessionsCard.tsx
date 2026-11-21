import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { clearAccessToken, getAuthSnapshot, subscribeToAuthStore } from '../../store/authStore';
import { Card, CardContent } from '../ui/card';
import { Button } from '../ui/button';
import { Spinner } from '../ui/spinner';
import { CardActions } from '../common/CardActions';
import { useAlerts } from '../../contexts/AlertContext';
import { useNavigate } from '@tanstack/react-router';
import { LOGIN_PATH } from '../../router/routePaths';
import { useAccountDisplay } from '../../hooks/useAccountDisplay';
import { describeDevice, describeSignIn, endAccountSession, fetchAccountSessions, signOutOtherSessions, signOutAllSessions, type AccountSession } from '../../lib/accountSessions';
import { ConfirmAction, SettingHeader } from './AccountSettings';

/**
 * Signed-in devices: every device signed in to this account, when each was
 * last used, and signing one, or every other one, out. This device is marked
 * and signs out with the normal Sign out.
 */
export function AccountSessionsCard() {
  const { success, error: showError } = useAlerts();
  const navigate = useNavigate();
  const { formatRelative, formatTimestamp } = useAccountDisplay();
  const [sessions, setSessions] = useState<readonly AccountSession[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  const auth = useSyncExternalStore(subscribeToAuthStore, getAuthSnapshot, getAuthSnapshot);
  const live = useRef(true), revision = useRef(0), pending = useRef(false), confirmationGeneration = useRef<number | null>(null);
  useEffect(() => { live.current = true; revision.current++; pending.current = false; setSessions(null); setBusy(null); setLoadError(false); setConfirming(false); setConfirmAll(false); confirmationGeneration.current = null; return () => { live.current = false; revision.current++; }; }, [auth.generation]);

  const load = useCallback(async () => {
    const run = ++revision.current, started = getAuthSnapshot();
    try {
      const list = await fetchAccountSessions();
      if (live.current && run === revision.current && getAuthSnapshot().generation === started.generation) { setSessions(list); setLoadError(false); }
    } catch {
      if (live.current && run === revision.current && getAuthSnapshot().generation === started.generation) setLoadError(true);
    }
  }, [auth.generation]);
  useEffect(() => { void load(); }, [load]);

  const signOut = async (session: AccountSession) => {
    if (pending.current) return;
    pending.current = true; const started = getAuthSnapshot();
    setBusy(session.id);
    try {
      await endAccountSession(session.id);
      if (live.current && getAuthSnapshot().generation === started.generation) success(`${describeDevice(session.user_agent)} signed out.`);
    } catch (err) {
      if (live.current && getAuthSnapshot().generation === started.generation) showError(`Couldn’t sign that device out: ${(err as Error).message}`);
    } finally {
      if (live.current && getAuthSnapshot().generation === started.generation) { pending.current = false; setBusy(null); await load(); }
    }
  };
  const signOutOthers = async () => {
    if (pending.current || confirmationGeneration.current !== getAuthSnapshot().generation) return;
    pending.current = true; const started = getAuthSnapshot();
    setBusy('others');
    try {
      const ended = await signOutOtherSessions();
      if (live.current && getAuthSnapshot().generation === started.generation) { success(ended === 1 ? '1 other device signed out.' : `${ended} other devices signed out.`); setConfirming(false); }
    } catch (err) {
      if (live.current && getAuthSnapshot().generation === started.generation) showError(`Couldn’t sign the other devices out: ${(err as Error).message}`);
    } finally {
      if (live.current && getAuthSnapshot().generation === started.generation) { pending.current = false; setBusy(null); await load(); }
    }
  };

  const signOutAll = async () => {
    if (pending.current || confirmationGeneration.current !== getAuthSnapshot().generation) return;
    pending.current = true; const started = getAuthSnapshot(); setBusy('all');
    try {
      await signOutAllSessions();
      if (getAuthSnapshot().generation === started.generation) { clearAccessToken(); if (live.current) void navigate({to: LOGIN_PATH, replace: true}); }
    } catch (err) {
      if (live.current && getAuthSnapshot().generation === started.generation) showError(`Couldn’t sign out all devices: ${(err as Error).message}`);
    } finally { if (live.current && getAuthSnapshot().generation === started.generation) { pending.current = false; setBusy(null); } }
  };

  const others = sessions?.filter(s => !s.current).length ?? 0;
  return (
    <Card>
      <SettingHeader title="Signed-in devices" summary={sessions ? (sessions.length === 1 ? 'Only this device' : `${sessions.length} devices`) : undefined} info={<>
        <p>Every browser signed in to your account. A device you don’t recognise may mean someone else knows your password: sign it out and change your password.</p>
        <p>Devices sign out by themselves after a while without use, and every sign-in ends after the maximum length set by your administrator.</p>
      </>} />
      <CardContent className="space-y-3">
        {loadError ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm text-destructive">Couldn’t read your signed-in devices.</p>
            <Button type="button" variant="outline" size="sm" onClick={() => void load()}>Try again</Button>
          </div>
        ) : sessions === null ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner className="size-4" />Loading devices…</div>
        ) : (
          <ul className="space-y-2">
            {sessions.map(session => (
              <li key={session.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/70 bg-muted/40 p-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {describeDevice(session.user_agent)}
                    {session.current ? <span className="ml-2 text-xs font-normal text-primary">This device</span> : null}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {[describeSignIn(session.sign_in), session.ip_address, session.current ? 'Active now' : `Last active ${formatRelative(session.last_used_at)}`].filter(Boolean).join(' · ')}
                  </p>
                  <p className="text-xs text-muted-foreground" title={formatTimestamp(session.created_at)}>Signed in {formatRelative(session.created_at)}</p>
                </div>
                {!session.current ? (
                  <Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={() => void signOut(session)}>
                    {busy === session.id ? 'Signing out…' : 'Sign out'}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <CardActions>
          <Button type="button" variant="outline" disabled={busy !== null || sessions === null} onClick={() => { confirmationGeneration.current = getAuthSnapshot().generation; setConfirmAll(true); }}>Sign out everywhere</Button>
        </CardActions>
        {others > 0 ? (
          <CardActions>
            <Button type="button" variant="outline" disabled={busy !== null} onClick={() => { confirmationGeneration.current = getAuthSnapshot().generation; setConfirming(true); }}>Sign out all other devices</Button>
          </CardActions>
        ) : null}
      </CardContent>
      <ConfirmAction open={confirmAll} onOpenChange={setConfirmAll} title="Sign out everywhere?" confirmLabel="Sign out everywhere"
        busy={busy === 'all'} onConfirm={() => void signOutAll()}>
        <p>Every device, including this one, will need to sign in again.</p>
      </ConfirmAction>
      <ConfirmAction open={confirming} onOpenChange={setConfirming} title="Sign out all other devices?" confirmLabel="Sign out other devices"
        busy={busy === 'others'} onConfirm={() => void signOutOthers()}>
        <p>Every device but this one is signed out and has to sign in again.</p>
      </ConfirmAction>
    </Card>
  );
}

export default AccountSessionsCard;
