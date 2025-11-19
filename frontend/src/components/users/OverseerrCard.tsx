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
  <section className="rounded-lg border border-border bg-background shadow-sm">
    <div className="p-6 space-y-3">
      <h3 className="text-lg font-semibold">Overseerr Status</h3>
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="inline-flex size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
          Loading Overseerr data…
        </div>
      ) : error ? (
        <div className="text-sm text-red-600 dark:text-red-400">Failed to load Overseerr data: {error.message}</div>
      ) : links.length === 0 ? (
        <p className="text-sm text-muted-foreground">No Overseerr records found for this user.</p>
      ) : (
        <ul className="space-y-2 text-sm">
          {links.map((link) => (
            <li key={link.server_id} className="rounded border border-border bg-muted/40 px-3 py-2">
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-medium">{link.server_name ?? 'Server'}</div>
                  <div className="text-xs text-muted-foreground">
                    {link.overseerr_username ?? 'Unlinked'} ({link.overseerr_email ?? 'No email'})
                  </div>
                </div>
                <span className={`inline-flex items-center rounded-full px-2 py-1 text-xs font-medium ${link.is_linked ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-muted text-muted-foreground'}`}>
                  {link.is_linked ? 'Linked' : 'Not linked'}
                </span>
              </div>
              {link.last_sync_at ? (
                <div className="mt-1 text-xs text-foreground/50">
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
