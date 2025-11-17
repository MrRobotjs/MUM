import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { ResponsiveDialog } from '../ui/responsive-dialog';

export type AvailableServiceAccount = {
  uuid: string;
  service_type?: string;
  server_name?: string;
  external_username?: string;
  external_email?: string;
  avatar_url?: string;
};

type ServiceAccountLinkModalProps = {
  open: boolean;
  onClose: () => void;
  accounts: AvailableServiceAccount[];
  loading?: boolean;
  error?: Error | null;
  onSubmit: (accountUuid: string) => Promise<void> | void;
};

export const ServiceAccountLinkModal = ({
  open,
  onClose,
  accounts,
  loading,
  error,
  onSubmit
}: ServiceAccountLinkModalProps) => {
  const [selected, setSelected] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!selected) return;
    setSubmitting(true);
    try {
      await onSubmit(selected);
      setSelected('');
    } finally {
      setSubmitting(false);
    }
  };

  const handleOpenChange = (value: boolean) => {
    if (!value) {
      onClose();
    }
  };

  const footer = [
    <Button key="cancel" variant="outline" onClick={onClose} disabled={submitting}>
      Cancel
    </Button>,
    <Button key="submit" onClick={handleSubmit} disabled={!selected || submitting}>
      {submitting ? 'Linking…' : 'Link Account'}
    </Button>,
  ];

  const body = loading ? (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <span className="loading loading-spinner loading-sm" />
      Loading available service accounts…
    </div>
  ) : error ? (
    <div className="text-sm text-destructive">Failed to load accounts: {error.message}</div>
  ) : accounts.length === 0 ? (
    <p className="text-sm text-muted-foreground">No unlinked service accounts available.</p>
  ) : (
    <div className="flex max-h-72 flex-col gap-2 overflow-y-auto">
      {accounts.map((account) => (
        <label
          key={account.uuid}
          className={`flex cursor-pointer items-center justify-between rounded border px-3 py-2 text-sm ${
            selected === account.uuid ? 'border-primary bg-primary/10' : 'border'
          }`}
        >
          <div>
            <div className="font-medium">{account.external_username ?? 'Service Account'}</div>
            <div className="text-xs text-muted-foreground">
              {account.service_type ?? 'service'} · {account.server_name ?? 'Unknown server'}
            </div>
          </div>
          <input
            type="radio"
            name="service-account"
            className="radio radio-primary"
            checked={selected === account.uuid}
            onChange={() => setSelected(account.uuid)}
          />
        </label>
      ))}
    </div>
  );

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={handleOpenChange}
      title="Link Service Account"
      description="Choose a service account to link to this user."
      footer={footer}
      contentClassName="max-w-lg"
    >
      {body}
    </ResponsiveDialog>
  );
};

export default ServiceAccountLinkModal;
