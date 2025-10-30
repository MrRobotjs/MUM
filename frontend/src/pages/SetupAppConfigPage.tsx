import { FormEvent, useState } from 'react';
import { ensureCsrfToken, apiFetch } from '../util/apiClient';
import { useNavigate } from 'react-router-dom';

export default function SetupAppConfigPage() {
  const navigate = useNavigate();
  const [appName, setAppName] = useState('Multimedia User Manager');
  const [appBaseUrl, setAppBaseUrl] = useState('');
  const [appLocalUrl, setAppLocalUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!appName || !appBaseUrl) {
      setError('App name and public URL are required.');
      return;
    }

    setSubmitting(true);
    try {
      await ensureCsrfToken('/admin/api/v2/auth/csrf-token');
      const form = new FormData();
      form.set('app_name', appName);
      form.set('app_base_url', appBaseUrl);
      if (appLocalUrl) form.set('app_local_url', appLocalUrl);

      const resp = await apiFetch('/setup/app', {
        method: 'POST',
        body: form
      });

      if (resp.ok) {
        navigate('/admin/settings/discord', { replace: true });
      } else {
        setError('Failed to save app configuration.');
      }
    } catch (err: any) {
      setError(err?.message || 'Request failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="container mx-auto max-w-xl p-6">
      <h1 className="text-2xl font-semibold mb-2">App Configuration</h1>
      <p className="text-sm text-gray-500 mb-6">Set your app identity and URLs.</p>

      {error && (
        <div className="alert alert-error mb-4">
          <span>{error}</span>
        </div>
      )}

      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium mb-1">Application Name</label>
          <input
            type="text"
            className="input input-bordered w-full"
            value={appName}
            onChange={(e) => setAppName(e.target.value)}
            required
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Public URL</label>
          <input
            type="url"
            placeholder="https://mum.example.com"
            className="input input-bordered w-full"
            value={appBaseUrl}
            onChange={(e) => setAppBaseUrl(e.target.value)}
            required
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Local URL (optional)</label>
          <input
            type="url"
            placeholder="http://192.168.1.100:5000"
            className="input input-bordered w-full"
            value={appLocalUrl}
            onChange={(e) => setAppLocalUrl(e.target.value)}
          />
        </div>
        <button type="submit" className={`btn btn-primary w-full ${submitting ? 'loading' : ''}`} disabled={submitting}>
          Save and Continue
        </button>
      </form>
    </div>
  );
}

