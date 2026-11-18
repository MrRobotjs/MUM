import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';

import { useAlerts } from '../../contexts';
import { getServiceLinks, linkServiceAccount, unlinkServiceAccount, type ServiceLink, type ServiceLinks } from '../../lib/serviceSignIn';
import { ApiError } from '../../util/apiClient';
import { Alert, AlertDescription } from '../ui/alert';
import { Button } from '../ui/button';
import { Card, CardContent } from '../ui/card';
import { ConfirmAction, ServiceSettingIcon, SettingHeader, SettingIcon } from './AccountSettings';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faServer } from '@fortawesome/free-solid-svg-icons';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Spinner } from '@/components/ui/spinner';
import { AvatarName } from './AccountAvatar';

const message = (err: unknown) => {
  if (err instanceof ApiError) {
    const payload = err.payload && typeof err.payload === 'object' && 'error' in err.payload ? (err.payload.error as { message?: string })?.message : undefined;
    return payload || err.message;
  }
  return err instanceof Error ? err.message : 'Unexpected error';
};

// ServiceLinksList shows the caller's linked server accounts. An account is
// offered for unlinking only while another way to sign in would remain.
export const ServiceLinksList = ({ links, busy, onUnlink }: { links: ServiceLink[]; busy: boolean; onUnlink: (link: ServiceLink) => void }) => (
  links.length === 0 ? (
    <p className="text-sm text-muted-foreground">No media server accounts are linked to your MUM account.</p>
  ) : (
    <ul className="divide-y rounded-md border">
      {links.map((link) => (
        <li key={link.serviceUuid} className="flex items-center justify-between gap-3 p-3 text-sm">
          <div className="flex min-w-0 items-center gap-3">
            <ServiceSettingIcon serviceType={link.serverType} />
            <div className="min-w-0">
            <p className="truncate font-medium text-foreground">{link.serverName}</p>
            <p className="text-xs text-muted-foreground"><AvatarName key={link.serviceUuid} url={link.avatarUrl} name={link.username || 'Unnamed account'} /></p>
            </div>
          </div>
          {link.canUnlink ? (
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => onUnlink(link)}>Unlink</Button>
          ) : (
            <span className="text-xs text-muted-foreground">Only way to sign in</span>
          )}
        </li>
      ))}
    </ul>
  )
);

export const ServiceLinksCard = () => {
  const { success } = useAlerts();
  const [state, setState] = useState<ServiceLinks | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ server: '', username: '', password: '' });
  const [open, setOpen] = useState(false);
  const [unlinking, setUnlinking] = useState<ServiceLink | null>(null);
  const load = useRef(0);

  const refresh = useCallback(async () => {
    const run = ++load.current;
    try {
      const value = await getServiceLinks();
      if (run === load.current) { setState(value); setError(null); }
    } catch (err) {
      if (run === load.current) setError(message(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => { load.current++; };
  }, [refresh]);

  const server = state?.servers.find((s) => String(s.id) === form.server);

  const link = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!server) return;
    setBusy(true);
    setError(null);
    try {
      await linkServiceAccount(server.id, form.username, form.password);
      setForm({ server: form.server, username: '', password: '' });
      setOpen(false);
      success(`${server.name} account linked`);
      await refresh();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  const unlink = async (target: ServiceLink) => {
    setBusy(true);
    setError(null);
    try {
      await unlinkServiceAccount(target.serviceUuid);
      success(`${target.serverName} account unlinked`);
      await refresh();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
      setUnlinking(null);
    }
  };

  const canLink = Boolean(state?.serviceSignIn && state.servers.length > 0);
  return (
    <Card>
      <SettingHeader title="Media servers" icon={<SettingIcon className="bg-muted text-muted-foreground"><FontAwesomeIcon icon={faServer} /></SettingIcon>}
        info={<>
          <p>Any of these logins signs you in to this MUM account. Linking or unlinking does not change your access on the media server.</p>
          <p>An account marked "Only way to sign in" can be unlinked once you link another account or set a MUM password.</p>
          {state && !state.serviceSignIn && <p>Linking your own accounts is available when your administrator allows signing in with media server logins.</p>}
        </>}
        action={canLink && <Button type="button" variant="outline" size="sm" aria-expanded={open} disabled={busy} onClick={() => setOpen(!open)}>{open ? 'Cancel' : 'Link account'}</Button>} />
      <CardContent className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {state === null ? (
          !error && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner className="h-4 w-4" />Loading linked accounts...</div>
        ) : (
          <>
            <ServiceLinksList links={state.links} busy={busy} onUnlink={setUnlinking} />
            {canLink && open && (
              <form className="space-y-4" onSubmit={link}>
                <div className="space-y-2">
                  <Label htmlFor="link-server">Server</Label>
                  <Select value={form.server} onValueChange={(value) => setForm((prev) => ({ ...prev, server: value }))}>
                    <SelectTrigger id="link-server" className="w-full">
                      <SelectValue placeholder="Choose a server" />
                    </SelectTrigger>
                    <SelectContent>
                      {state.servers.map((s) => (
                        <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="link-username">Username</Label>
                  <Input id="link-username" autoComplete="off" value={form.username} required maxLength={255} onChange={(event) => setForm((prev) => ({ ...prev, username: event.target.value }))} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="link-password">Password</Label>
                  <Input id="link-password" type="password" autoComplete="off" value={form.password} required maxLength={1024} onChange={(event) => setForm((prev) => ({ ...prev, password: event.target.value }))} />
                </div>
                <Button type="submit" disabled={busy || !server}>{busy ? 'Checking…' : 'Link account'}</Button>
              </form>
            )}
          </>
        )}
      </CardContent>
      <ConfirmAction open={unlinking !== null} onOpenChange={value => { if (!value) setUnlinking(null); }} title={`Unlink ${unlinking?.serverName ?? 'this'} account?`} confirmLabel="Unlink" destructive busy={busy}
        onConfirm={() => { if (unlinking) void unlink(unlinking); }}>
        You will no longer be able to sign in to MUM with {unlinking?.username || 'this account'} on {unlinking?.serverName ?? 'this server'}. Your access on that server does not change.
      </ConfirmAction>
    </Card>
  );
};

export default ServiceLinksCard;
