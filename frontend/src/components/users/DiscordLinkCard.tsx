import { useEffect, useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faDiscord } from '@fortawesome/free-brands-svg-icons';
import { useAuth } from '../../contexts/AuthContext';
import { useAlerts } from '../../contexts/AlertContext';
import { discordOutcome, getAccountDiscord, startDiscordLink, unlinkDiscord, type AccountDiscord } from '../../lib/discordSignIn';
import { Button } from '../ui/button';
import { Card, CardContent } from '../ui/card';
import { ConfirmAction, SettingHeader, SettingIcon } from './AccountSettings';
import { Spinner } from '../ui/spinner';
import { AvatarName } from './AccountAvatar';

// Linking a Discord account on the account page:
// the same for admins and users. Discord sends the browser back here with the
// outcome, which is shown once. Unlinking asks for confirmation first.
const DISCORD_ICON = <SettingIcon className="bg-indigo-500/10 text-indigo-500"><FontAwesomeIcon icon={faDiscord} /></SettingIcon>;

export function DiscordLinkFields({ info, busy, onLink, onUnlink }: {
  info: AccountDiscord; busy: boolean; onLink: () => void; onUnlink: () => void;
}) {
  const summary = info.linked ? <AvatarName key={info.username ?? ''} url={info.avatarUrl} name={info.username ?? ''} /> : info.available ? 'Not linked' : 'Not available';
  return <SettingHeader title="Discord" icon={DISCORD_ICON} summary={summary}
    info={<>
      <p>Link your Discord account to show it on your profile and, when an administrator allows it, to use Sign in with Discord.</p>
      {!info.available && !info.linked && <p>An administrator must set up Discord before you can link an account.</p>}
      {info.linked && info.signIn && <p>You can use Sign in with Discord on the sign-in page.</p>}
    </>}
    action={info.linked
      ? <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onUnlink}>Unlink</Button>
      : info.available && <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onLink}>Link Discord</Button>} />;
}

function DiscordLinkPanel() {
  const { success, error: showError } = useAlerts();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { discord?: string };
  const [info, setInfo] = useState<AccountDiscord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
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
    try { await unlinkDiscord(); success('Discord account unlinked.'); await load(); }
    catch (err) { showError(err instanceof Error && err.message ? err.message : 'Unlinking Discord failed. Try again.'); }
    finally { setBusy(false); setConfirming(false); }
  };
  return <Card>
    {info ? <DiscordLinkFields info={info} busy={busy} onLink={() => void link()} onUnlink={() => setConfirming(true)} />
      : <SettingHeader title="Discord" icon={DISCORD_ICON} summary={error ? '' : <Spinner className="h-4 w-4" />} />}
    {error && <CardContent><div className="account-setting-error flex flex-wrap items-center gap-3"><p className="text-sm text-destructive">{error}</p><Button type="button" variant="outline" size="sm" onClick={() => void load()}>Try again</Button></div></CardContent>}
    <ConfirmAction open={confirming} onOpenChange={setConfirming} title="Unlink Discord?" confirmLabel="Unlink" destructive busy={busy} onConfirm={() => void unlink()}>
      Sign in with Discord stops working for this account, and sessions started with it end.
    </ConfirmAction>
  </Card>;
}

export function DiscordLinkCard() {
  const { user, isAuthenticated } = useAuth();
  return user && isAuthenticated ? <DiscordLinkPanel key={user.uuid} /> : null;
}
