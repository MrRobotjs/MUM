import { FormEvent, useState, useEffect } from 'react';
import { useLocation, useNavigate, Link, useSearch } from '@tanstack/react-router';
import { requestJson, ApiError } from '../util/apiClient';
import { setAccessToken } from '../util/tokenStore';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Button } from '../components/ui/button';
import { Checkbox } from '../components/ui/checkbox';
import { Separator } from '../components/ui/separator';
import { Alert, AlertDescription } from '../components/ui/alert';
import { ResponsiveDialog } from '../components/ui/responsive-dialog';

type LocationState = {
  from?: string;
};

const UserLoginPage = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const search = useSearch({ from: '/login', strict: false }) as { next?: string };
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [logoutNotice, setLogoutNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showInactivityInfo, setShowInactivityInfo] = useState(false);

  // Prefer ?next= query, then location.state.from, else user dashboard
  const nextParam = search.next;
  const fromPath = nextParam || (location.state as LocationState | undefined)?.from || '/user/dashboard';

  // Auto-focus first input on desktop
  useEffect(() => {
    if (window.innerWidth > 768) {
      const firstInput = document.getElementById('username');
      if (firstInput) {
        setTimeout(() => firstInput.focus(), 300);
      }
    }
  }, []);

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

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const response = await requestJson<{
        data?: {
          access_token?: string;
          user?: unknown;
        };
      }>(
        '/api/v2/public/auth/jwt/login',
        {
          method: 'POST',
          body: JSON.stringify({
            username,
            password,
            remember: rememberMe
          })
        }
      );

      const token = (response && typeof response === 'object' && 'data' in response)
        ? (response.data as { access_token?: string })?.access_token
        : undefined;
      if (token) {
        setAccessToken(token);
      }

      navigate({ to: fromPath, replace: true });
    } catch (err) {
      const apiError = err as ApiError;
      setError(apiError.message || 'Login failed');
    } finally {
      setSubmitting(false);
    }
  };

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
                      <i className="fas fa-film text-primary text-2xl" />
                    </div>
                    <div className="text-center lg:text-left">
                      <h1 className="text-4xl lg:text-5xl font-bold">MUM</h1>
                      <p className="text-lg text-muted-foreground font-medium">Multimedia User Manager</p>
                    </div>
                  </div>
                  
                  <div className="space-y-4 text-muted-foreground">
                    <p className="text-lg">Welcome to your personal media hub! Access your content, manage your preferences, and explore your multimedia library.</p>
                    <div className="flex flex-wrap justify-center lg:justify-start gap-4 text-sm">
                      <div className="flex items-center">
                        <i className="fas fa-play text-primary mr-2" />
                        <span>Stream Content</span>
                      </div>
                      <div className="flex items-center">
                        <i className="fas fa-user-cog text-primary mr-2" />
                        <span>Personal Dashboard</span>
                      </div>
                      <div className="flex items-center">
                        <i className="fas fa-server text-primary mr-2" />
                        <span>Multi-Service Access</span>
                      </div>
                    </div>
                  </div>
                </div>
                
                {/* Feature Highlights */}
                <div className="hidden lg:block">
                  <h3 className="text-xl font-semibold mb-4">Platform Features</h3>
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div className="bg-muted/50 rounded-lg p-3 hover:bg-muted/80 hover:-translate-y-0.5 hover:shadow-md transition-all duration-200 ease-in-out">
                      <i className="fas fa-film text-primary mb-2 block" />
                      <div className="font-medium">Your Library</div>
                      <div className="text-muted-foreground">Personal media collection</div>
                    </div>
                    <div className="bg-muted/50 rounded-lg p-3 hover:bg-muted/80 hover:-translate-y-0.5 hover:shadow-md transition-all duration-200 ease-in-out">
                      <i className="fas fa-history text-primary mb-2 block" />
                      <div className="font-medium">Watch History</div>
                      <div className="text-muted-foreground">Track your viewing</div>
                    </div>
                    <div className="bg-muted/50 rounded-lg p-3 hover:bg-muted/80 hover:-translate-y-0.5 hover:shadow-md transition-all duration-200 ease-in-out">
                      <i className="fas fa-download text-primary mb-2 block" />
                      <div className="font-medium">Offline Access</div>
                      <div className="text-muted-foreground">Download for later</div>
                    </div>
                    <div className="bg-muted/50 rounded-lg p-3 hover:bg-muted/80 hover:-translate-y-0.5 hover:shadow-md transition-all duration-200 ease-in-out">
                      <i className="fas fa-mobile-alt text-primary mb-2 block" />
                      <div className="font-medium">Multi-Device</div>
                      <div className="text-muted-foreground">Access anywhere</div>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Right Side - Login Form */}
          <div className="order-2 lg:order-2">
            <Card className="rounded-2xl shadow-2xl p-8 max-w-md mx-auto">
              <CardHeader className="text-center pb-6">
                <CardTitle className="text-2xl mb-2">Sign In</CardTitle>
                <CardDescription>Enter your credentials to access your media dashboard</CardDescription>
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
                        <i className="fa-solid fa-circle-info text-sm" />
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
                  {/* Username Field */}
                  <div className="space-y-2">
                    <Label htmlFor="username" className="flex items-center gap-2">
                      <i className="fas fa-user text-muted-foreground text-sm" />
                      <span>Username or Email</span>
                    </Label>
                    <Input
                      id="username"
                      type="text"
                      placeholder="Enter your username or email"
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
                      <i className="fas fa-lock text-muted-foreground text-sm" />
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

                  {/* Sign In Button */}
                  <Button
                    type="submit"
                    className="w-full text-lg h-12 hover:-translate-y-0.5 hover:shadow-lg transition-all duration-200 ease-in-out"
                    disabled={submitting}
                  >
                    {submitting ? (
                      <>
                        <span className="animate-spin rounded-full h-4 w-4 border-b-2 border-current mr-2" />
                        Signing in...
                      </>
                    ) : (
                      'Sign in'
                    )}
                  </Button>
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
                    <p className="mb-4">New here? You'll need an invite from your administrator to create an account.</p>
                    <div>
                      <p className="text-muted-foreground mb-1">Administrator access?</p>
                      <Link to="/admin/login" className="text-primary hover:underline">
                        Admin Login
                      </Link>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Security Notice */}
            <div className="mt-6 text-center">
              <div className="inline-flex items-center text-xs text-muted-foreground">
                <i className="fas fa-shield-alt mr-2" />
                <span>Your connection is secure and encrypted</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default UserLoginPage;
