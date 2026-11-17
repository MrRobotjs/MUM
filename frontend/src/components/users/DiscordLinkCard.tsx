import { useEffect, useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faDiscord } from '@fortawesome/free-brands-svg-icons';
import { useAuth } from '../../contexts/AuthContext';
import { useAlerts } from '../../contexts/AlertContext';
import { discordOutcome, getAccountDiscord, startDiscordLink, unlinkDiscord, type AccountDiscord } from '../../lib/discordSignIn';
import { Button } from '../ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Alert, AlertDescription } from '../ui/alert';
import { Checkbox } from '../ui/checkbox';
import { Spinner } from '../ui/spinner';

// Linking a Discord account on the account page (DISCORD_SIGN_IN_DESIGN.md):
// the same for admins and users. Discord sends the browser back here with the
// outcome, which is shown once.
export function DiscordLinkFields({ info, busy, unlinkAcknowledged, onAcknowledge, onLink, onUnlink }: {
  info: AccountDiscord; busy: boolean; unlinkAcknowledged: boolean;
  onAcknowledge: (value: boolean) => void; onLink: () => void; onUnlink: () => void;
}) {
  if (!info.available && !info.linked) return <p className="text-sm text-muted-foreground">An administrator must set up Discord before you can link an account.</p>;
  if (info.linked) return <>
    <p className="text-sm text-muted-foreground">Linked Discord account: {info.username}.{info.signIn ? ' You can use Sign in with Discord on the sign-in page.' : ''}</p>
    <label className="flex items-start gap-2 text-sm"><Checkbox checked={unlinkAcknowledged} onCheckedChange={value => onAcknowledge(value === true)} disabled={busy} /><span>Unlink this Discord account. Sign in with Discord stops working for this account, and sessions started with it end.</span></label>
    <Button variant="outline" disabled={busy || !unlinkAcknowledged} onClick={onUnlink}>Unlink Discord Account</Button>
  </>;
  return <Button type="button" variant="outline" className="w-full text-lg h-12 hover:-translate-y-0.5 hover:shadow-lg transition-all duration-200 ease-in-out" disabled={busy} onClick={onLink}>
    <FontAwesomeIcon icon={faDiscord} className="mr-2 text-indigo-500" />
    Link Discord Account
  </Button>;
}

function DiscordLinkPanel() {
  const { success, error: showError } = useAlerts();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { discord?: string };
  const [info, setInfo] = useState<AccountDiscord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [unlinkAcknowledged, setUnlinkAcknowledged] = useState(false);
  const load = async () => {
    try { setInfo(await getAccountDiscord()); setError(null); }
    catch { setError('Your Discord link could not be read.'); }
  };
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (!search.discord) return;
    const outcome = discordOutcome('account', search.discord);
    if (outcome?.kind === 'success') success(outcome.message);
    else if (outcome) showError(outcome.message);
    navigate({ to: '/account', search: (prev: Record<string, unknown>) => ({ ...prev, discord: undefined }), replace: true });
  }, [search.discord, navigate, success, showError]);
  const link = async () => {
    setBusy(true);
    try { window.location.assign(await startDiscordLink()); }
    catch (err) { showError(err instanceof Error && err.message ? err.message : 'Linking Discord failed. Try again.'); setBusy(false); }
  };
  const unlink = async () => {
    setBusy(true);
    try { await unlinkDiscord(); setUnlinkAcknowledged(false); success('Discord account unlinked.'); await load(); }
    catch (err) { showError(err instanceof Error && err.message ? err.message : 'Unlinking Discord failed. Try again.'); }
    finally { setBusy(false); }
  };
  return <Card>
    <CardHeader>
      <CardTitle>Discord Account</CardTitle>
      <CardDescription>Link your Discord account to show it on your profile and, when an administrator allows it, to use Sign in with Discord.</CardDescription>
    </CardHeader>
    <CardContent><div className="space-y-4">
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      {!info && !error && <Spinner className="h-4 w-4 mr-2" />}
      {info && <DiscordLinkFields info={info} busy={busy} unlinkAcknowledged={unlinkAcknowledged} onAcknowledge={setUnlinkAcknowledged} onLink={() => void link()} onUnlink={() => void unlink()} />}
    </div></CardContent>
  </Card>;
}

export function DiscordLinkCard() {
  const { user, isAuthenticated } = useAuth();
  return user && isAuthenticated ? <DiscordLinkPanel key={user.uuid} /> : null;
}
