import { FormEvent, useState } from 'react';
import { ensureCsrfToken, apiFetch } from '../util/apiClient';
import { useNavigate } from '@tanstack/react-router';

export default function SetupAccountPage() {
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!username || !password || !confirmPassword) {
      setError('Please fill in all fields.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setSubmitting(true);
    try {
      await ensureCsrfToken('/admin/api/v2/auth/csrf-token');
      const form = new FormData();
      form.set('username', username);
      form.set('password', password);
      form.set('confirm_password', confirmPassword);
      form.set('submit_type', 'username_password');

      const resp = await apiFetch('/setup/account', {
        method: 'POST',
        body: form
      });

      if (resp.ok) {
        // Owner is logged in on success; send to plugins config in admin
        navigate('/admin/settings/plugins', { replace: true });
      } else {
        setError('Account creation failed. Please try again.');
      }
    } catch (err: any) {
      setError(err?.message || 'Request failed');
    } finally {
      setSubmitting(false);
    }
  };

  const startPlexSSO = async () => {
    // Submit a real POST to trigger server redirect to Plex auth
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = '/setup/account';
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = 'submit_type';
    input.value = 'plex_sso';
    form.appendChild(input);
    document.body.appendChild(form);
    form.submit();
  };

  return (
    <div className="container mx-auto max-w-xl p-6">
      <h1 className="text-2xl font-semibold mb-2">Owner Account Setup</h1>
      <p className="text-sm text-gray-500 mb-6">Create the primary administrator account.</p>

      {error && (
        <div className="alert alert-error mb-4">
          <span>{error}</span>
        </div>
      )}

      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium mb-1">Username</label>
          <input
            type="text"
            className="input input-bordered w-full"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Password</label>
          <input
            type="password"
            className="input input-bordered w-full"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Confirm Password</label>
          <input
            type="password"
            className="input input-bordered w-full"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
          />
        </div>
        <button type="submit" className={`btn btn-primary w-full ${submitting ? 'loading' : ''}`} disabled={submitting}>
          Create Administrator Account
        </button>
      </form>

      <div className="divider">or</div>

      <button onClick={startPlexSSO} className="btn btn-outline w-full">
        Continue with Plex
      </button>
    </div>
  );
}
