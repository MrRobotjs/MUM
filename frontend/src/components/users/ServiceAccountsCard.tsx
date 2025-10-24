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

export const ServiceAccountsCard = ({ accounts, loading, error, onUnlink }: ServiceAccountsCardProps) => {
  if (loading) {
    return (
      <section className="card border border-base-300 bg-base-100 shadow-sm">
        <div className="card-body">
          <div className="flex items-center gap-2 text-sm text-base-content/60">
            <span className="loading loading-spinner loading-sm" />
            Loading service accounts…
          </div>
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <section className="card border border-base-300 bg-base-100 shadow-sm">
        <div className="card-body text-sm text-error">
          Failed to load service accounts: {error.message}
        </div>
      </section>
    );
  }

  return (
    <section className="card border border-base-300 bg-base-100 shadow-sm">
      <div className="card-body space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold">Linked Service Accounts</h3>
            <span className="text-xs text-base-content/60">{accounts.length} linked</span>
          </div>
          {onLink ? (
            <button type="button" className="btn btn-primary btn-sm" onClick={onLink}>
              Link Account
            </button>
          ) : null}
        </div>
        {accounts.length === 0 ? (
          <p className="text-sm text-base-content/60">No service accounts linked.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {accounts.map((account) => (
              <li key={account.uuid} className="rounded border border-base-200 bg-base-200/40 px-3 py-2">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium">{account.external_username ?? 'Service Account'}</div>
                    <div className="text-xs text-base-content/60">
                      {account.service_type ?? 'service'} · {account.server_name ?? 'Unknown server'}
                    </div>
                  </div>
                  {onUnlink ? (
                    <button
                      type="button"
                      className="btn btn-ghost btn-xs text-error"
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
