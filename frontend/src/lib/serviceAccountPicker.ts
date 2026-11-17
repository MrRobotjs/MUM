// Choosing a service account to link (ACCOUNT_PAGE_DESIGN.md): first the
// server, then a user on it, found by name or email.

export type PickableAccount = { uuid: string; service_type?: string; server_name?: string; external_username?: string; external_email?: string };
export type PickerServer = { key: string; name: string; serviceType: string; count: number };

const serverKey = (a: PickableAccount) => `${a.service_type ?? ''}\u0000${a.server_name ?? ''}`;

// pickerServers lists each server that has unlinked accounts, by name.
export function pickerServers(accounts: readonly PickableAccount[]): PickerServer[] {
  const servers = new Map<string, PickerServer>();
  for (const a of accounts) {
    const key = serverKey(a);
    const found = servers.get(key);
    if (found) found.count++;
    else servers.set(key, { key, name: a.server_name || 'Unknown server', serviceType: a.service_type ?? '', count: 1 });
  }
  return [...servers.values()].sort((x, y) => x.name.localeCompare(y.name) || x.serviceType.localeCompare(y.serviceType));
}

// pickerAccounts is one server's accounts matching the search, by username.
export function pickerAccounts(accounts: readonly PickableAccount[], server: string, query: string): PickableAccount[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return accounts
    .filter(a => serverKey(a) === server)
    .filter(a => { const text = `${a.external_username ?? ''} ${a.external_email ?? ''}`.toLowerCase(); return words.every(w => text.includes(w)); })
    .sort((x, y) => (x.external_username ?? '').localeCompare(y.external_username ?? '', undefined, { sensitivity: 'base' }));
}
