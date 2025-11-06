import { FormEvent, useState } from 'react';
import { useLocation, useNavigate } from '@tanstack/react-router';
// Login page uses a standalone layout (no app navbar)
import { requestJson, ApiError } from '../util/apiClient';
import { setAccessToken } from '../util/tokenStore';

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
  const [error, setError] = useState<string | null>(null);

  // Prefer ?next= query, then location.state.from, else dashboard
  const search = new URLSearchParams(((location as any).searchStr) ?? (typeof window !== 'undefined' ? window.location.search : ''));
  const nextParam = search.get('next');
  const fromPath = nextParam || (location.state as LocationState | undefined)?.from || '/admin/dashboard';

  // No CSRF priming needed under JWT

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
        
        // Fire event to notify useSession hooks to refresh
        try {
          window.dispatchEvent(new CustomEvent('auth_token_updated', { detail: { accessToken: token } }));
        } catch {}
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
    <div className="min-h-screen bg-base-200 flex items-center justify-center p-4">
      <div className="w-full max-w-6xl">
        <div className="grid lg:grid-cols-2 gap-8 items-center">
          {/* Left: Branding */}
          <div className="order-2 lg:order-1 text-center lg:text-left card bg-base-100 border border-base-300 p-8 shadow-2xl">
            <div className="mb-6 flex flex-col items-center lg:flex-row lg:justify-start">
              <div className="w-16 h-16 rounded-full bg-primary/20 flex items-center justify-center mb-4 lg:mb-0 lg:mr-4">
                <i className="fas fa-crown text-primary text-2xl" />
              </div>
              <div className="text-center lg:text-left">
                <h1 className="text-4xl lg:text-5xl font-bold text-base-content">MUM</h1>
                <p className="text-lg text-base-content/70 font-medium">Multimedia User Manager</p>
              </div>
            </div>
            <div className="space-y-3 text-base-content/80">
              <p className="text-lg">Administrator access portal. Sign in to manage your services and users.</p>
              <div className="flex flex-wrap justify-center lg:justify-start gap-4 text-sm">
                <div className="flex items-center"><i className="fas fa-cog text-primary mr-2" />System Management</div>
                <div className="flex items-center"><i className="fas fa-chart-line text-primary mr-2" />Analytics</div>
                <div className="flex items-center"><i className="fas fa-shield-alt text-primary mr-2" />Security</div>
              </div>
            </div>
          </div>

          {/* Right: Login Card */}
          <div className="order-1 lg:order-2">
            <div className="bg-base-100 border border-base-300 rounded-2xl shadow-2xl p-8 max-w-md mx-auto">
              <div className="text-center mb-6">
                <h2 className="text-2xl font-bold text-base-content mb-1">Admin Login</h2>
                <p className="text-base-content/60">Administrator access required</p>
              </div>

              <form className="space-y-5" onSubmit={handleSubmit}>
            <div>
              <label htmlFor="username" className="label">
                <span className="label-text">Username</span>
              </label>
              <input
                id="username"
                type="text"
                className="input input-bordered w-full"
                value={username}
                autoComplete="username"
                onChange={(event) => setUsername(event.target.value)}
                required
              />
            </div>

            <div>
              <label htmlFor="password" className="label">
                <span className="label-text">Password</span>
              </label>
              <input
                id="password"
                type="password"
                className="input input-bordered w-full"
                value={password}
                autoComplete="current-password"
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </div>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="checkbox checkbox-sm"
                checked={rememberMe}
                onChange={(event) => setRememberMe(event.target.checked)}
              />
              <span>Remember this device</span>
            </label>

            {error ? <p className="text-sm text-error">{error}</p> : null}

            <button
              type="submit"
              className={"btn btn-primary w-full " + (submitting ? 'loading' : '')}
              disabled={submitting}
            >
              {submitting ? 'Signing in…' : 'Sign in'}
            </button>
              </form>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default LoginPage;
