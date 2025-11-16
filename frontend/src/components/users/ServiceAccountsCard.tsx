import { useMemo } from 'react';

export type ServiceAccount = {
  uuid: string;
  service_type?: string;
  server_name?: string;
  external_username?: string;
  external_email?: string;
  linked_at?: string;
};

type ServiceAccountsCardProps = {
  accounts: ServiceAccount[];
  loading?: boolean;
  error?: Error | null;
  onUnlink?: (serviceUuid: string) => Promise<void> | void;
  onLink?: () => void;
};

export const ServiceAccountsCard = ({ accounts, loading, error, onUnlink, onLink }: ServiceAccountsCardProps) => {
  if (loading) {
    return (
      <section className="rounded-lg border border-border bg-background shadow-sm">
        <div className="p-6">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span className="inline-flex size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
            Loading service accounts…
          </div>
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <section className="rounded-lg border border-border bg-background shadow-sm">
        <div className="p-6 text-sm text-error">
          Failed to load service accounts: {error.message}
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-border bg-background shadow-sm">
      <div className="p-6 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold">Linked Service Accounts</h3>
            <span className="text-xs text-muted-foreground">{accounts.length} linked</span>
          </div>
          {onLink ? (
            <button type="button" className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 bg-primary text-primary-foreground hover:bg-primary/90 h-9 px-3" onClick={onLink}>
              Link Account
            </button>
          ) : null}
        </div>
        {accounts.length === 0 ? (
          <p className="text-sm text-muted-foreground">No service accounts linked.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {accounts.map((account) => (
              <li key={account.uuid} className="rounded border border-border bg-muted/40 px-3 py-2">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium">{account.external_username ?? 'Service Account'}</div>
                    <div className="text-xs text-muted-foreground">
                      {account.service_type ?? 'service'} · {account.server_name ?? 'Unknown server'}
                    </div>
                  </div>
                  {onUnlink ? (
                    <button
                      type="button"
                      className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 hover:bg-accent hover:text-accent-foreground h-8 px-2 text-destructive"
                      onClick={() => onUnlink(account.uuid)}
                    >
                      Unlink
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
};

export default ServiceAccountsCard;
