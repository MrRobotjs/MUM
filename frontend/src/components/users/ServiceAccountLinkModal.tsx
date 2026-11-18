import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ResponsiveDialog } from '../ui/responsive-dialog';
import { Spinner } from '@/components/ui/spinner';
import { pickerAccounts, pickerServers } from '../../lib/serviceAccountPicker';
import { ServiceSettingIcon } from './AccountSettings';

export type AvailableServiceAccount = {
  uuid: string;
  service_type?: string;
  server_name?: string;
  external_username?: string;
  external_email?: string;
  avatar_url?: string | null;
};

type ServiceAccountLinkModalProps = {
  open: boolean;
  onClose: () => void;
  accounts: AvailableServiceAccount[];
  loading?: boolean;
  error?: Error | null;
  // Who the account is linked to, for the dialog's description.
  ownerName?: string;
  onSubmit: (accountUuid: string) => Promise<void> | void;
};

// Linking a service account: choose the server, find the user on it by name
// or email, select them and link. Only accounts no one owns are offered.
export const ServiceAccountLinkModal = ({ open, onClose, accounts, loading, error, ownerName, onSubmit }: ServiceAccountLinkModalProps) => {
  const servers = useMemo(() => pickerServers(accounts), [accounts]);
  const [server, setServer] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const shown = useMemo(() => pickerAccounts(accounts, server, query), [accounts, server, query]);

  // Start fresh each time; with only one server, it is already chosen.
  useEffect(() => {
    if (!open) return;
    setServer(current => servers.some(s => s.key === current) ? current : servers.length === 1 ? servers[0].key : '');
  }, [open, servers]);
  useEffect(() => { if (!open) { setQuery(''); setSelected(''); } }, [open]);
  useEffect(() => { if (!shown.some(a => a.uuid === selected)) setSelected(''); }, [shown, selected]);

  const choice = shown.find(a => a.uuid === selected);
  const handleSubmit = async () => {
    if (submitting || loading || error || !choice) return;
    setSubmitting(true);
    try {
      await onSubmit(choice.uuid);
      setSelected('');
    } finally {
      setSubmitting(false);
    }
  };

  const footer = [
    <Button key="cancel" variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>,
    <Button key="submit" onClick={() => void handleSubmit()} disabled={!choice || submitting || loading || !!error}>
      {submitting ? 'Linking…' : choice ? `Link ${choice.external_username || 'account'}` : 'Link account'}
    </Button>,
  ];

  const body = loading ? (
    <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner className="size-4" />Loading available service accounts…</div>
  ) : error ? (
    <div className="text-sm text-destructive">Failed to load accounts: {error.message}</div>
  ) : servers.length === 0 ? (
    <p className="text-sm text-muted-foreground">Every service account is already linked to a MUM profile. Sync a server to find new users.</p>
  ) : (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="link-account-server">Server</Label>
        <Select value={server} onValueChange={value => { setServer(value); setSelected(''); }}>
          <SelectTrigger id="link-account-server" className="w-full"><SelectValue placeholder="Choose a server" /></SelectTrigger>
          <SelectContent>
            {servers.map(s => (
              <SelectItem key={s.key} value={s.key}>
                <span className="flex items-center gap-2"><ServiceSettingIcon serviceType={s.serviceType} />{s.name} ({s.count})</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {server && <>
        <div className="space-y-2">
          <Label htmlFor="link-account-search">User</Label>
          <Input id="link-account-search" type="search" autoComplete="off" placeholder="Search by username or email" value={query} disabled={submitting} onChange={event => setQuery(event.target.value)} />
        </div>
        {shown.length === 0 ? (
          <p className="text-sm text-muted-foreground">No unlinked users on this server match.</p>
        ) : (
          <div role="radiogroup" aria-label="Users" className="flex max-h-72 flex-col gap-2 overflow-y-auto">
            {shown.map(account => (
              <label key={account.uuid} className={`flex cursor-pointer items-center justify-between rounded border px-3 py-2 text-sm ${selected === account.uuid ? 'border-primary bg-primary/10' : 'border'}`}>
                <div className="min-w-0">
                  <div className="truncate font-medium">{account.external_username || 'Unnamed account'}</div>
                  {account.external_email && <div className="truncate text-xs text-muted-foreground">{account.external_email}</div>}
                </div>
                <input type="radio" name="service-account" className="radio radio-primary" checked={selected === account.uuid} disabled={submitting} onChange={() => setSelected(account.uuid)} />
              </label>
            ))}
          </div>
        )}
      </>}
    </div>
  );

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={value => { if (!value && !submitting) onClose(); }}
      title="Link a service account"
      description={`Choose a server, then the user to link to ${ownerName || 'this profile'}. This changes ownership in MUM only.`}
      footer={footer}
      contentClassName="max-w-lg"
    >
      {body}
    </ResponsiveDialog>
  );
};

export default ServiceAccountLinkModal;
