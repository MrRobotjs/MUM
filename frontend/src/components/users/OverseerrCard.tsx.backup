type OverseerrLink = {
  server_id: number;
  server_name?: string;
  overseerr_user_id?: number;
  overseerr_username?: string;
  overseerr_email?: string;
  is_linked: boolean;
  last_sync_at?: string;
};

type OverseerrCardProps = {
  links: OverseerrLink[];
  loading?: boolean;
  error?: Error | null;
};

export const OverseerrCard = ({ links, loading, error }: OverseerrCardProps) => (
  <section className="card border border-base-300 bg-base-100 shadow-sm">
    <div className="card-body space-y-3">
      <h3 className="text-lg font-semibold">Overseerr Status</h3>
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-base-content/60">
          <span className="loading loading-spinner loading-sm" />
          Loading Overseerr data…
        </div>
      ) : error ? (
        <div className="text-sm text-error">Failed to load Overseerr data: {error.message}</div>
      ) : links.length === 0 ? (
        <p className="text-sm text-base-content/60">No Overseerr records found for this user.</p>
      ) : (
        <ul className="space-y-2 text-sm">
          {links.map((link) => (
            <li key={link.server_id} className="rounded border border-base-200 bg-base-200/40 px-3 py-2">
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-medium">{link.server_name ?? 'Server'}</div>
                  <div className="text-xs text-base-content/60">
                    {link.overseerr_username ?? 'Unlinked'} ({link.overseerr_email ?? 'No email'})
                  </div>
                </div>
                <span className={`badge badge-${link.is_linked ? 'success' : 'ghost'} badge-sm`}>
                  {link.is_linked ? 'Linked' : 'Not linked'}
                </span>
              </div>
              {link.last_sync_at ? (
                <div className="mt-1 text-xs text-base-content/50">
                  Last sync: {new Date(link.last_sync_at).toLocaleString()}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  </section>
);

export default OverseerrCard;
