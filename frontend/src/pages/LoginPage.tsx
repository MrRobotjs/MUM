import { FormEvent, useState, useEffect } from 'react';
import { useLocation, useNavigate, Link, useSearch } from '@tanstack/react-router';
import { requestJson, ApiError } from '../util/apiClient';
import { setAccessToken } from '../util/tokenStore';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Button } from '../components/ui/button';
import { Separator } from '../components/ui/separator';
import { Alert, AlertDescription } from '../components/ui/alert';

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
  const [error, setError] = useState<string | null>(null);
  const [allowUserAccounts, setAllowUserAccounts] = useState(false);

  // Prefer ?next= query, then location.state.from, else dashboard
  const search = useSearch({ from: '/admin/login', strict: false }) as { next?: string; error?: string };
  const nextParam = search.next;
  const errorParam = search.error;
  const locationStateFrom = (location.state as LocationState | undefined)?.from;
  // Ignore location.state.from if it's the login page itself (avoid redirect loop)
  const validLocationFrom = locationStateFrom && locationStateFrom !== '/admin/login' ? locationStateFrom : null;
  const fromPath = nextParam || validLocationFrom || '/admin/dashboard';

  // Check if user accounts are enabled
  useEffect(() => {
    const checkUserAccounts = async () => {
      try {
        const response = await requestJson<{ data: { allow_user_accounts: boolean } }>('/admin/api/v2/settings/user-accounts');
        setAllowUserAccounts(response.data?.allow_user_accounts || false);
      } catch {
        // If check fails, default to false
        setAllowUserAccounts(false);
      }
    };
    checkUserAccounts();
  }, []);

  // Check for error query parameter (e.g., from Plex SSO callback)
  useEffect(() => {
    if (errorParam) {
      setError(errorParam);
      // Clear the error from URL to prevent it from showing again on refresh
      navigate({ from: '/admin/login', search: (prev) => ({ ...prev, error: undefined }), replace: true });
    }
  }, [errorParam, navigate]);

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
    setSubmitting(true);
    setError(null);

    try {
      const response = await requestJson<{
        data?: {
          access_token?: string;
          user?: unknown;
        };
      }>(
        '/admin/api/v2/auth/jwt/login',
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

  const handlePlexSSO = async () => {
    setPlexLoading(true);
    setError(null);

    try {
      const response = await requestJson<{
        data?: {
          redirect_url?: string;
        };
      }>(
        '/admin/api/v2/auth/plex/start',
        {
          method: 'POST',
          body: JSON.stringify({
            next: fromPath
          })
        }
      );

      const redirectUrl = response?.data?.redirect_url;
      if (redirectUrl) {
        window.location.href = redirectUrl;
      } else {
        setError('Failed to initiate Plex login');
        setPlexLoading(false);
      }
    } catch (err) {
      const apiError = err as ApiError;
      setError(apiError.message || 'Plex login failed');
      setPlexLoading(false);
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
                      <i className="fas fa-crown text-primary text-2xl" />
                    </div>
                    <div className="text-center lg:text-left">
                      <h1 className="text-4xl lg:text-5xl font-bold">MUM</h1>
                      <p className="text-lg text-muted-foreground font-medium">Multimedia User Manager</p>
                    </div>
                  </div>
                  
                  <div className="space-y-4 text-muted-foreground">
                    <p className="text-lg">Administrator access portal. Sign in to manage your media services and user accounts.</p>
                    <div className="flex flex-wrap justify-center lg:justify-start gap-4 text-sm">
                      <div className="flex items-center">
                        <i className="fas fa-crown text-primary mr-2" />
                        <span>Admin Controls</span>
                      </div>
                      <div className="flex items-center">
                        <i className="fas fa-cog text-primary mr-2" />
                        <span>System Management</span>
                      </div>
                      <div className="flex items-center">
                        <i className="fas fa-chart-line text-primary mr-2" />
                        <span>Analytics & Reports</span>
                      </div>
                    </div>
                  </div>
                </div>
                
                {/* Feature Highlights */}
                <div className="hidden lg:block">
                  <h3 className="text-xl font-semibold mb-4">Administrative Features</h3>
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div className="bg-muted/50 rounded-lg p-3 hover:bg-muted/80 hover:-translate-y-0.5 hover:shadow-md transition-all duration-200 ease-in-out">
                      <i className="fas fa-users text-primary mb-2 block" />
                      <div className="font-medium">User Management</div>
                      <div className="text-muted-foreground">Manage accounts & access</div>
                    </div>
                    <div className="bg-muted/50 rounded-lg p-3 hover:bg-muted/80 hover:-translate-y-0.5 hover:shadow-md transition-all duration-200 ease-in-out">
                      <i className="fas fa-server text-primary mb-2 block" />
                      <div className="font-medium">Server Control</div>
                      <div className="text-muted-foreground">Multi-service support</div>
                    </div>
                    <div className="bg-muted/50 rounded-lg p-3 hover:bg-muted/80 hover:-translate-y-0.5 hover:shadow-md transition-all duration-200 ease-in-out">
                      <i className="fas fa-chart-bar text-primary mb-2 block" />
                      <div className="font-medium">Analytics</div>
                      <div className="text-muted-foreground">Usage insights</div>
                    </div>
                    <div className="bg-muted/50 rounded-lg p-3 hover:bg-muted/80 hover:-translate-y-0.5 hover:shadow-md transition-all duration-200 ease-in-out">
                      <i className="fas fa-shield-alt text-primary mb-2 block" />
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
              <CardHeader className="text-center pb-6">
                <CardTitle className="text-2xl mb-2">Admin Login</CardTitle>
                <CardDescription>Administrator access required</CardDescription>
              </CardHeader>

              <CardContent className="space-y-6">
                {error && (
                  <Alert variant="destructive">
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}

                <form onSubmit={handleSubmit} className="space-y-6">
                  {/* Username Field */}
                  <div className="space-y-2">
                    <Label htmlFor="username" className="flex items-center gap-2">
                      <i className="fas fa-user-shield text-muted-foreground text-sm" />
                      <span>Username</span>
                    </Label>
                    <Input
                      id="username"
                      type="text"
                      placeholder="Admin username"
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

                {/* Divider */}
                <div className="relative">
                  <div className="absolute inset-0 flex items-center">
                    <Separator />
                  </div>
                  <div className="relative flex justify-center text-xs uppercase">
                    <span className="bg-card px-2 text-muted-foreground">or continue with</span>
                  </div>
                </div>

                {/* Plex SSO Button */}
                <Button
                  type="button"
                  variant="outline"
                  onClick={handlePlexSSO}
                  className="w-full text-lg h-12 hover:-translate-y-0.5 hover:shadow-lg transition-all duration-200 ease-in-out border-orange-600 text-orange-700 dark:text-orange-400 hover:bg-orange-50 dark:hover:bg-orange-950 hover:border-orange-600"
                  disabled={plexLoading}
                >
                  {plexLoading ? (
                    <>
                      <span className="animate-spin rounded-full h-4 w-4 border-b-2 border-current mr-2" />
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

                {/* Additional Info */}
                <div className="pt-6">
                  <Separator className="mb-6" />
                  <div className="text-center text-sm text-muted-foreground">
                    <p className="mb-4">Secure administrator access to MUM</p>
                    {allowUserAccounts && (
                      <div>
                        <p className="text-muted-foreground mb-1">Need to access your user account?</p>
                        <Link to="/login" className="text-primary hover:underline">
                          User Login
                        </Link>
                      </div>
                    )}
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

export default LoginPage;
