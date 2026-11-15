import { getAuthSnapshot, type AuthSnapshot } from '../store/authStore';
import { readFreshSession, useSession } from '../hooks/useSession';
import { postLoginPath, safeNextPath, LOGIN_PATH } from '../router/routePaths';
import { FormEvent, useState, useEffect, useRef } from 'react';
import { useLocation, useNavigate, useSearch } from '@tanstack/react-router';
import { requestJson, ApiError } from '../util/apiClient';
import { setAccessToken } from '../util/tokenStore';
import { checkPlexSignIn, startPlexSignIn } from '../lib/plexSignIn';
import { checkQuickConnect, serviceSignIn, startQuickConnect } from '../lib/serviceSignIn';
import { useSignInMethods } from '../hooks/useSignInMethods';
import { getServiceIcon, getServiceMeta } from '../config/pluginMetadata';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Button } from '../components/ui/button';
import { Checkbox } from '../components/ui/checkbox';
import { Separator } from '../components/ui/separator';
import { Alert, AlertDescription } from '../components/ui/alert';
import { ResponsiveDialog } from '../components/ui/responsive-dialog';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { Spinner } from '@/components/ui/spinner'
import {
  faChartBar,
  faChartLine,
  faCircleInfo,
  faCog,
  faCrown,
  faLock,
  faServer,
  faShieldHalved,
  faUserShield,
  faUsers
} from '@fortawesome/free-solid-svg-icons';

type LocationState = {
  from?: string;
};

const LoginPage = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [plexLoading, setPlexLoading] = useState(false);
  const loginAttempt = useRef(0);
  const currentAttempt = (attempt: number, auth: AuthSnapshot) => {
    const current = getAuthSnapshot();
    return attempt === loginAttempt.current && current.generation === auth.generation && current.credentialRevision === auth.credentialRevision;
  };
  const [logoutNotice, setLogoutNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showInactivityInfo, setShowInactivityInfo] = useState(false);
  // 'mum' signs in with a MUM password, 'plex' through Plex's own sign-in
  // page, and a server ID with that server's login.
  const [target, setTarget] = useState('mum');
  const methods = useSignInMethods();
  const targetServer = methods.servers.find((server) => String(server.id) === target);
  const plexChosen = methods.plex && target === 'plex';
  // A Quick Connect code waiting for approval in a Jellyfin app.
  const [quickConnect, setQuickConnect] = useState<{ code: string } | null>(null);
  const quickConnectOffered = targetServer?.type === 'jellyfin';
  const showPicker = methods.plex || (methods.serviceSignIn && methods.servers.length > 0);

  // Prefer ?next= query, then location.state.from, else dashboard
  const search = useSearch({ strict: false }) as { next?: string; error?: string };
  const nextParam = search.next;
  const errorParam = search.error;
  const locationStateFrom = (location.state as LocationState | undefined)?.from;
  // Ignore location.state.from if it's the login page itself (avoid redirect loop)
  const validLocationFrom = locationStateFrom && safeNextPath(locationStateFrom) !== null && locationStateFrom !== LOGIN_PATH ? locationStateFrom : null;
  const fromPath = nextParam ?? validLocationFrom;

  // An account that is already signed in is sent on, as after signing in. Not
  // while a sign-in here is pending: that attempt navigates once validated.
  const { session } = useSession();
  const signedInAs = session?.user ? Boolean(session.user.has_admin_access) : null;
  useEffect(() => {
    if (signedInAs === null || submitting || plexLoading || quickConnect) return;
    navigate({ href: postLoginPath(fromPath, signedInAs), replace: true });
  }, [signedInAs, submitting, plexLoading, quickConnect, fromPath, navigate]);

  // Check for error query parameter (e.g., from Plex SSO callback)
  useEffect(() => {
    if (errorParam) {
      setError(errorParam);
      // Clear the error from URL to prevent it from showing again on refresh
      navigate({ from: LOGIN_PATH, search: (prev) => ({ ...prev, error: undefined }), replace: true });
    }
  }, [errorParam, navigate]);

  useEffect(() => {
    try {
      const reason = window.sessionStorage.getItem('auth_logout_reason');
      if (reason === 'inactivity') {
        setLogoutNotice('You were logged out due to inactivity. Please sign in again.');
      }
      if (reason) {
        window.sessionStorage.removeItem('auth_logout_reason');
      }
    } catch {
      // Ignore storage errors
    }
  }, []);

  // Auto-focus first input on desktop
  useEffect(() => {
    if (window.innerWidth > 768) {
      const firstInput = document.getElementById('username');
      if (firstInput) {
        setTimeout(() => firstInput.focus(), 300);
      }
    }
  }, []);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const attempt = ++loginAttempt.current;
    const auth = getAuthSnapshot();
    setSubmitting(true);
    setPlexLoading(false);
    setError(null);

    try {
      let token: string | undefined;
      if (targetServer) {
        token = await serviceSignIn(targetServer.id, username, password, rememberMe);
      } else {
        const response = await requestJson<{
          data?: {
            access_token?: string;
            user?: unknown;
          };
        }>(
          '/api/auth/login',
          {
            method: 'POST',
            body: JSON.stringify({
              username,
              password,
              remember: rememberMe
            })
          }
        );

        token = (response && typeof response === 'object' && 'data' in response)
          ? (response.data as { access_token?: string })?.access_token
          : undefined;
      }
      if (!currentAttempt(attempt, auth)) return;
      if (!token) throw new Error('Sign-in response did not include an access token');
      setAccessToken(token);
      let validated: AuthSnapshot | undefined;
      const session = await readFreshSession((checkpoint) => { validated = checkpoint; });
      if (!validated || !currentAttempt(attempt, validated)) throw new Error('Authentication session changed during sign-in');
      navigate({ href: postLoginPath(fromPath, Boolean(session.user.has_admin_access)), replace: true });
    } catch (err) {
      const apiError = err as ApiError;
      if (attempt === loginAttempt.current) setError(apiError.message || 'Login failed');
    } finally {
      if (attempt === loginAttempt.current) setSubmitting(false);
    }
  };

  // Sign in with Plex: Plex opens in a separate window and this page checks
  // every 2 seconds until Plex approves. The Plex account must already be
  // linked to a MUM account (Account → Credentials).
  const handlePlexSSO = async () => {
    if (plexLoading) return;
    const attempt = ++loginAttempt.current;
    const auth = getAuthSnapshot();
    setSubmitting(false);
    // Opened during the click so the browser does not block it.
    const popup = window.open('', 'mum-plex-sign-in', 'width=600,height=750');
    setPlexLoading(true);
    setError(null);
    try {
      const started = await startPlexSignIn(rememberMe);
      if (!currentAttempt(attempt, auth)) { if (popup && !popup.closed) popup.close(); return; }
      if (popup && !popup.closed) {
        popup.opener = null;
        popup.location.href = started.authorizationUrl;
      } else {
        window.open(started.authorizationUrl, '_blank', 'noopener');
      }
      const deadline = Math.min(Date.parse(started.expiresAt), Date.now() + 15 * 60 * 1000);
      while (Date.now() < deadline && currentAttempt(attempt, auth)) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        if (!currentAttempt(attempt, auth)) return;
        let result;
        try {
          result = await checkPlexSignIn(started.id);
        } catch (err) {
          // Checking too soon is answered with 429; wait and check again.
          if (err instanceof ApiError && err.status === 429) continue;
          throw err;
        }
        if (!currentAttempt(attempt, auth)) return;
        if (result.status === 'signed_in') {
          if (popup && !popup.closed) popup.close();
          setAccessToken(result.accessToken);
          let validated: AuthSnapshot | undefined;
          const session = await readFreshSession((checkpoint) => { validated = checkpoint; });
          if (!validated || !currentAttempt(attempt, validated)) throw new Error('Authentication session changed during sign-in');
          navigate({ href: postLoginPath(fromPath, Boolean(session.user.has_admin_access)), replace: true });
          return;
        }
        if (popup && popup.closed) {
          setError('Plex sign-in was closed before it finished. Try again.');
          return;
        }
      }
      if (currentAttempt(attempt, auth)) setError('Plex sign-in expired. Try again.');
    } catch (err) {
      if (popup && !popup.closed) popup.close();
      if (attempt === loginAttempt.current) setError(err instanceof Error && err.message ? err.message : 'Plex sign-in failed. Try again.');
    } finally {
      if (attempt === loginAttempt.current) setPlexLoading(false);
    }
  };

  // Jellyfin Quick Connect: show the server's code, then check every 3
  // seconds until the user approves it in a Jellyfin app.
  const handleQuickConnect = async () => {
    if (!targetServer || quickConnect) return;
    const server = targetServer;
    const attempt = ++loginAttempt.current;
    const auth = getAuthSnapshot();
    setSubmitting(false);
    setPlexLoading(false);
    setError(null);
    try {
      const started = await startQuickConnect(server.id, rememberMe);
      if (!currentAttempt(attempt, auth)) return;
      setQuickConnect({ code: started.code });
      const deadline = Math.min(Date.parse(started.expiresAt), Date.now() + 10 * 60 * 1000);
      while (Date.now() < deadline && currentAttempt(attempt, auth)) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        if (!currentAttempt(attempt, auth)) return;
        let result;
        try {
          result = await checkQuickConnect(started.id);
        } catch (err) {
          // Checking too soon is answered with 429; wait and check again.
          if (err instanceof ApiError && err.status === 429) continue;
          throw err;
        }
        if (!currentAttempt(attempt, auth)) return;
        if (result.status === 'signed_in') {
          setAccessToken(result.accessToken);
          let validated: AuthSnapshot | undefined;
          const session = await readFreshSession((checkpoint) => { validated = checkpoint; });
          if (!validated || !currentAttempt(attempt, validated)) throw new Error('Authentication session changed during sign-in');
          navigate({ href: postLoginPath(fromPath, Boolean(session.user.has_admin_access)), replace: true });
          return;
        }
      }
      if (currentAttempt(attempt, auth)) setError('The Quick Connect code expired. Try again.');
    } catch (err) {
      if (attempt === loginAttempt.current) setError(err instanceof Error && err.message ? err.message : 'Quick Connect failed. Try again.');
    } finally {
      if (attempt === loginAttempt.current) setQuickConnect(null);
    }
  };

  // Stops waiting for a Quick Connect approval; the code expires on its own.
  const cancelQuickConnect = () => {
    ++loginAttempt.current;
    setQuickConnect(null);
  };

  const chooseTarget = (value: string) => {
    if (quickConnect) cancelQuickConnect();
    setTarget(value);
  };
  useEffect(() => () => { ++loginAttempt.current; }, []);

  return (
    <div className="min-h-screen lg:min-h-[calc(100vh-4rem)] flex items-center justify-center p-4 bg-muted/30">
      <div className="w-full max-w-6xl">
        <div className="grid lg:grid-cols-2 gap-8 items-center">
          {/* Left Side - Branding & Info */}
          <div className="order-1 lg:order-1">
            <Card className="p-8 shadow-2xl">
              <CardContent className="p-0">
                <div className="mb-8">
                  <div className="flex flex-col items-center lg:flex-row lg:justify-start mb-6">
                    <div className="w-16 h-16 rounded-full bg-primary/20 flex items-center justify-center mb-4 lg:mb-0 lg:mr-4">
                      <FontAwesomeIcon icon={faCrown} className="text-primary text-2xl" />
                    </div>
                    <div className="text-center lg:text-left">
                      <h1 className="text-4xl lg:text-5xl font-bold">MUM</h1>
                      <p className="text-lg text-muted-foreground font-medium">Multimedia User Manager</p>
                    </div>
                  </div>
                  
                  <div className="space-y-4 text-muted-foreground">
                    <p className="text-lg">Sign in to your MUM account.</p>
                    <div className="flex flex-wrap justify-center lg:justify-start gap-4 text-sm">
                      <div className="flex items-center">
                        <FontAwesomeIcon icon={faCrown} className="text-primary mr-2" />
                        <span>Admin Controls</span>
                      </div>
                      <div className="flex items-center">
                        <FontAwesomeIcon icon={faCog} className="text-primary mr-2" />
                        <span>System Management</span>
                      </div>
                      <div className="flex items-center">
                        <FontAwesomeIcon icon={faChartLine} className="text-primary mr-2" />
                        <span>Analytics & Reports</span>
                      </div>
                    </div>
                  </div>
                </div>
                
                {/* Feature Highlights */}
                <div className="hidden lg:block">
                  <h3 className="text-xl font-semibold mb-4">What MUM Does</h3>
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div className="bg-muted/50 rounded-lg p-3 hover:bg-muted/80 hover:-translate-y-0.5 hover:shadow-md transition-all duration-200 ease-in-out">
                      <FontAwesomeIcon icon={faUsers} className="text-primary mb-2 block" />
                      <div className="font-medium">User Management</div>
                      <div className="text-muted-foreground">Manage accounts & access</div>
                    </div>
                    <div className="bg-muted/50 rounded-lg p-3 hover:bg-muted/80 hover:-translate-y-0.5 hover:shadow-md transition-all duration-200 ease-in-out">
                      <FontAwesomeIcon icon={faServer} className="text-primary mb-2 block" />
                      <div className="font-medium">Server Control</div>
                      <div className="text-muted-foreground">Multi-service support</div>
                    </div>
                    <div className="bg-muted/50 rounded-lg p-3 hover:bg-muted/80 hover:-translate-y-0.5 hover:shadow-md transition-all duration-200 ease-in-out">
                      <FontAwesomeIcon icon={faChartBar} className="text-primary mb-2 block" />
                      <div className="font-medium">Analytics</div>
                      <div className="text-muted-foreground">Usage insights</div>
                    </div>
                    <div className="bg-muted/50 rounded-lg p-3 hover:bg-muted/80 hover:-translate-y-0.5 hover:shadow-md transition-all duration-200 ease-in-out">
                      <FontAwesomeIcon icon={faShieldHalved} className="text-primary mb-2 block" />
                      <div className="font-medium">Security</div>
                      <div className="text-muted-foreground">Access control</div>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Right Side - Login Form */}
          <div className="order-2 lg:order-2">
            <Card className="rounded-2xl shadow-2xl p-8 max-w-md mx-auto">
              <CardHeader className="text-center">
                <CardTitle className="text-2xl mb-2">Sign In</CardTitle>
                <CardDescription>{methods.serviceSignIn ? 'Use your MUM account or a media server login' : methods.plex ? 'Use your MUM account or Plex' : 'Use your MUM account'}</CardDescription>
              </CardHeader>

              <CardContent className="space-y-6">
                {logoutNotice && (
                  <Alert variant="warning">
                    <AlertDescription>
                      <div className="flex items-start justify-between gap-3">
                        <span>{logoutNotice}</span>
                        <button
                          type="button"
                          className="inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                          aria-label="Why did this happen?"
                          title="Why did this happen?"
                          onClick={() => setShowInactivityInfo(true)}
                        >
                          <FontAwesomeIcon icon={faCircleInfo} className="text-sm" />
                        </button>
                      </div>
                    </AlertDescription>
                  </Alert>
                )}
                {error && (
                  <Alert variant="destructive">
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}

                <form onSubmit={handleSubmit} className="space-y-6">
                  {/* Account Choice: a MUM account or a media server login */}
                  {showPicker && (
                    <div className="space-y-2">
                      <Label htmlFor="sign-in-target" className="flex items-center gap-2">
                        <FontAwesomeIcon icon={faServer} className="text-muted-foreground text-sm" />
                        <span>Sign in using</span>
                      </Label>
                      <Select value={plexChosen ? 'plex' : targetServer ? target : 'mum'} onValueChange={chooseTarget}>
                        <SelectTrigger id="sign-in-target" className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="mum">
                            <FontAwesomeIcon icon={faCrown} className="text-primary" />
                            <span>MUM account</span>
                          </SelectItem>
                          {methods.plex && (
                            <SelectItem value="plex">
                              {getServiceIcon('plex')}
                              <span>Plex <span className="text-muted-foreground">(Plex account)</span></span>
                            </SelectItem>
                          )}
                          {methods.servers.map((server) => (
                            <SelectItem key={server.id} value={String(server.id)}>
                              {getServiceIcon(server.type)}
                              <span>{server.name} <span className="text-muted-foreground">({getServiceMeta(server.type).label})</span></span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  {quickConnect ? (
                    <div className="space-y-3 rounded-md border p-4 text-center">
                      <p className="text-sm text-muted-foreground">In a Jellyfin app where you are signed in, open Quick Connect and enter this code:</p>
                      <p id="quick-connect-code" className="font-mono text-3xl font-semibold tracking-widest text-foreground">{quickConnect.code}</p>
                      <p className="flex items-center justify-center gap-2 text-xs text-muted-foreground"><Spinner className="h-4 w-4" />Waiting for approval...</p>
                    </div>
                  ) : !plexChosen && (<>
                  {/* Username Field */}
                  <div className="space-y-2">
                    <Label htmlFor="username" className="flex items-center gap-2">
                      <FontAwesomeIcon icon={faUserShield} className="text-muted-foreground text-sm" />
                      <span>{targetServer ? `${targetServer.name} username` : 'Username'}</span>
                    </Label>
                    <Input
                      id="username"
                      type="text"
                      placeholder="Username"
                      value={username}
                      autoComplete="username"
                      onChange={(event) => setUsername(event.target.value)}
                      required
                      className="transition-all duration-200 ease-in-out focus:-translate-y-0.5"
                    />
                  </div>

                  {/* Password Field */}
                  <div className="space-y-2">
                    <Label htmlFor="password" className="flex items-center gap-2">
                      <FontAwesomeIcon icon={faLock} className="text-muted-foreground text-sm" />
                      <span>Password</span>
                    </Label>
                    <Input
                      id="password"
                      type="password"
                      placeholder="Enter your password"
                      value={password}
                      autoComplete="current-password"
                      onChange={(event) => setPassword(event.target.value)}
                      required
                      className="transition-all duration-200 ease-in-out focus:-translate-y-0.5"
                    />
                  </div>
                  </>)}

                  {/* Remember Me Checkbox */}
                  <div className="flex items-center space-x-2">
                    <Checkbox
                      id="remember"
                      checked={rememberMe}
                      onCheckedChange={(checked) => setRememberMe(checked === true)}
                    />
                    <Label htmlFor="remember" className="text-sm font-normal cursor-pointer">
                      Remember this device
                    </Label>
                  </div>

                  {quickConnect ? (
                  <Button type="button" variant="ghost" className="w-full" onClick={cancelQuickConnect}>Cancel</Button>
                  ) : plexChosen ? (<>
                  {/* Plex SSO Button */}
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handlePlexSSO}
                    title="Sign in with your Plex account"
                    className="w-full text-lg h-12 hover:-translate-y-0.5 hover:shadow-lg transition-all duration-200 ease-in-out border-orange-600 text-orange-700 dark:text-orange-400 hover:bg-orange-50 dark:hover:bg-orange-950 hover:border-orange-600"
                    disabled={plexLoading || submitting}
                  >
                    {plexLoading ? (
                      <>
                        <Spinner className="h-4 w-4 mr-2" />
                        Connecting...
                      </>
                    ) : (
                      <>
                        <svg className="w-5 h-5 mr-3" viewBox="0 0 192 192" xmlns="http://www.w3.org/2000/svg" fill="currentColor" stroke="transparent" strokeLinejoin="round" strokeWidth="12">
                          <path d="M22 25.5h48L116 94l-46 68.5H22L68.5 94Zm109.8 56L108 46l14-20.5h48zm-.3 23.5c10.979 17.625 25.52 38.875 38.5 49.5-11.149 13.635-34.323 32.278-62.5-14z"/>
                        </svg>
                        Sign in with Plex
                      </>
                    )}
                  </Button>
                  <p className="text-xs text-muted-foreground text-center">{methods.serviceSignIn ? 'Use the Plex account you were invited with or linked under Account → Credentials.' : 'Link your Plex account first under Account → Credentials.'}</p>
                  </>) : (
                  /* Sign In Button */
                  <Button
                    type="submit"
                    className="w-full text-lg h-12 hover:-translate-y-0.5 hover:shadow-lg transition-all duration-200 ease-in-out"
                    disabled={submitting}
                  >
                    {submitting ? (
                      <>
                        <Spinner className="h-4 w-4 mr-2" />
                        Signing in...
                      </>
                    ) : (
                      'Sign in'
                    )}
                  </Button>
                  )}
                  {quickConnectOffered && !quickConnect && (
                    <Button type="button" variant="outline" className="w-full" onClick={handleQuickConnect} disabled={submitting}>
                      Use Quick Connect instead
                    </Button>
                  )}
                </form>

                <ResponsiveDialog
                  open={showInactivityInfo}
                  onOpenChange={setShowInactivityInfo}
                  title="Why did this happen?"
                  description="Your session can only refresh when the app makes API requests."
                >
                  <div className="space-y-3 text-sm text-muted-foreground">
                    <p>
                      For security, sessions expire after inactivity. If you browse a page that doesn’t make API calls,
                      the app has no chance to refresh your session, so it can expire even while you’re on the site.
                    </p>
                    <p>
                      Selecting "Remember this device" keeps you signed in longer by extending the refresh token
                      lifetime to 30 days.
                    </p>
                  </div>
                </ResponsiveDialog>


                {/* Additional Info */}
                <div className="pt-6">
                  <Separator className="mb-6" />
                  <div className="text-center text-sm text-muted-foreground">
                    <p className="mb-4">Secure access to MUM</p>

                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Security Notice */}
            <div className="mt-6 text-center">
              <div className="inline-flex items-center text-xs text-muted-foreground">
                <FontAwesomeIcon icon={faShieldHalved} className="mr-2" />
                <span>Your connection is secure and encrypted</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default LoginPage;
