import { LOGIN_PATH, HOME_PATH } from './appLinks';
export { LOGIN_PATH, HOME_PATH, ACCOUNT_PATH } from './appLinks';

function canonicalPath(input: unknown): { pathname: string; path: string } | null {
  if (typeof input !== 'string' || input.length > 2048 || !input.startsWith('/') || input.startsWith('//')) return null;
  if (/[\\\u0000-\u0020\u007f]/.test(input)) return null;
  try {
    // Decode the pathname before URL normalization so encoded separators and dot
    // segments receive the same security classification as routed addresses.
    const split = input.search(/[?#]/);
    const rawPath = split < 0 ? input : input.slice(0, split);
    const suffix = split < 0 ? '' : input.slice(split);
    const decoded = decodeURIComponent(rawPath);
    // Reject nested encoding rather than allowing different consumers to decode
    // it a different number of times. Validate escapes in search/hash as well.
    if (/[\\\u0000-\u001f\u007f]/.test(decodeURIComponent(suffix))) return null;
    if (/[\\%\u0000-\u0020\u007f?#]/.test(decoded) || decoded.startsWith('//')) return null;
    const url = new URL(decoded, 'https://mum.invalid');
    if (url.origin !== 'https://mum.invalid') return null;
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    if (pathname.startsWith('//') || new URL(pathname + suffix, 'https://mum.invalid').origin !== 'https://mum.invalid') return null;
    return { pathname, path: pathname + suffix };
  } catch { return null; }
}

export const isAdminPath = (path: string): boolean => {
  const pathname = canonicalPath(path)?.pathname;
  return pathname === '/admin' || Boolean(pathname?.startsWith('/admin/'));
};
export const safeNextPath = (next: unknown): string | null => {
  const path = canonicalPath(next);
  return path && path.pathname !== LOGIN_PATH ? path.path : null;
};
export const postLoginPath = (next: unknown, hasAdminAccess: boolean): string => {
  const path = safeNextPath(next);
  return path && (hasAdminAccess || !isAdminPath(path)) ? path : HOME_PATH;
};
export type GuardDecision = 'loading' | 'login' | 'home' | 'error' | 'allow';
export const guardDecision = (state: { loading: boolean; unauthorized: boolean; failed: boolean; signedIn: boolean; hasAdminAccess: boolean }, require: 'signed-in' | 'admin'): GuardDecision => {
  if (state.loading) return 'loading';
  if (state.unauthorized) return 'login';
  if (state.failed) return 'error';
  if (!state.signedIn) return 'login';
  if (require === 'admin' && !state.hasAdminAccess) return 'home';
  return 'allow';
};


