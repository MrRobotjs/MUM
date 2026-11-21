// The public address: the one people outside the server's network use to
// reach MUM. Invite links and Discord sign-in are built from it; without one,
// invite links use the address the administrator is browsing on.

/** Where an address can be reached from: only this network, by a bare IP, or by a domain name. */
export type AddressReach = 'local' | 'ip' | 'domain';

const ipv4 = (host: string) => {
  const parts = host.split('.');
  if (parts.length !== 4 || parts.some(p => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return null;
  return parts.map(Number);
};

const privateIPv4 = ([a, b]: number[]) =>
  a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) || a === 0;

/** Classifies an http(s) address, or returns null when it isn't one. */
export function addressReach(address: string): AddressReach | null {
  let url: URL;
  try { url = new URL(address); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.lan') || host.endsWith('.home.arpa') || !host.includes('.') && !host.includes(':')) return 'local';
  const v4 = ipv4(host);
  if (v4) return privateIPv4(v4) ? 'local' : 'ip';
  if (host.includes(':')) {
    // IPv6: loopback, unique-local (fc00::/7) and link-local (fe80::/10) stay on this network.
    return host === '::1' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) ? 'local' : 'ip';
  }
  return 'domain';
}

/** The warning to show with an invite link built from an address, or null when it's a domain name. */
export function inviteLinkWarning(link: string): string | null {
  switch (addressReach(link)) {
    case 'local': return 'This link only works on your own network. Set a Public Address in Settings → General so people outside can open it.';
    case 'ip': return 'This link shows your server’s IP address to everyone you send it to. A domain name is safer: set one as the Public Address in Settings → General.';
    default: return null;
  }
}

/** Notes about an address entered as the Public Address (empty when it's fine). */
export function publicAddressNotes(address: string): string[] {
  const value = address.trim();
  if (!value) return [];
  const reach = addressReach(value);
  if (reach === null) return ['Enter a full address starting with http:// or https://, such as https://mum.example.com.'];
  try {
    const url = new URL(value);
    if (url.pathname !== '/' || url.search || url.hash) return ['Use just the address, without a path after it, such as https://mum.example.com.'];
  } catch { /* Classified above. */ }
  const notes: string[] = [];
  if (reach === 'local') notes.push('This address only works on your own network, so invitees outside it can’t open invite links.');
  if (reach === 'ip') notes.push('Invite links will show this IP address to everyone you send them to. A domain name is safer.');
  if (reach !== 'local' && value.toLowerCase().startsWith('http://')) notes.push('Discord sign-in needs an address starting with https://.');
  return notes;
}
