import { FormEvent, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AppLayout, PageHeader } from '../components';
import { ensureCsrfToken, requestJson, setCsrfToken, ApiError } from '../util/apiClient';
import { useSession } from '../hooks/useSession';

type LocationState = {
  from?: string;
};

const LoginPage = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { refresh } = useSession();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fromPath = (location.state as LocationState | undefined)?.from ?? '/admin/dashboard';

  useEffect(() => {
    ensureCsrfToken().catch((err) => console.warn('Unable to prime CSRF token', err));
  }, []);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const response = await requestJson<{
        data?: {
          csrf_token?: string | null;
        };
      }>(
        '/admin/api/v1/auth/login',
        {
          method: 'POST',
          body: JSON.stringify({
            username,
            password,
            remember: rememberMe
          })
        }
      );

      if (response && typeof response === 'object' && 'data' in response) {
        const csrf = (response.data as { csrf_token?: string | null })?.csrf_token ?? null;
        setCsrfToken(csrf);
      }

      await refresh();
      navigate(fromPath, { replace: true });
    } catch (err) {
      const apiError = err as ApiError;
      setError(apiError.message || 'Login failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-base-200">
      <AppLayout>
        <PageHeader
          title="Sign in"
          description="Use your admin credentials to access the Multimedia User Manager dashboard."
        />

        <div className="mx-auto mt-8 max-w-lg rounded-xl border border-base-300 bg-base-100 p-8 shadow-sm">
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
              className={`btn btn-primary w-full ${submitting ? 'loading' : ''}`}
              disabled={submitting}
            >
              {submitting ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </div>
      </AppLayout>
    </div>
  );
};

export default LoginPage;
