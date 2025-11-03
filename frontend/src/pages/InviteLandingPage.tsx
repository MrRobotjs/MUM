import { FormEvent, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';

const extractInviteToken = (raw: string): string => {
  const input = (raw || '').trim();
  if (!input) return '';

  // If it's a full URL, try to parse and extract after /invite/
  try {
    const url = new URL(input);
    const parts = url.pathname.split('/').filter(Boolean);
    const inviteIndex = parts.findIndex((p) => p.toLowerCase() === 'invite');
    if (inviteIndex >= 0 && parts.length > inviteIndex + 1) {
      return parts[inviteIndex + 1];
    }
  } catch {
    // Not a URL; fall through
  }

  // If it contains "/invite/" anywhere, grab the segment after it
  const inviteIdx = input.toLowerCase().indexOf('/invite/');
  if (inviteIdx >= 0) {
    const after = input.slice(inviteIdx + '/invite/'.length);
    const seg = after.split(/[?#/]/)[0];
    return seg;
  }

  // Otherwise assume it's already the token/custom path (single segment)
  return input.split(/[?#/]/)[0];
};

const InviteLandingPage = () => {
  const navigate = useNavigate();
  const [inviteInput, setInviteInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    const token = extractInviteToken(inviteInput);
    if (!token) {
      setError('Enter an invite code or link');
      return;
    }

    setSubmitting(true);
    try {
      // Validate invite via v2 public endpoint before redirecting
      const res = await fetch(`/api/v2/public/invite/${encodeURIComponent(token)}`, {
        headers: { Accept: 'application/json' },
        credentials: 'include',
      });
      if (!res.ok) {
        throw new Error('Invite not found or expired');
      }
      navigate(`/invite/${encodeURIComponent(token)}`);
    } catch (err) {
      setError((err as Error).message || 'Unable to validate invite');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-base-200 flex items-center justify-center p-4">
      <div className="w-full max-w-xl rounded-xl border border-base-300 bg-base-100 p-8 shadow-sm">
        <h1 className="text-2xl font-semibold">Join with an Invite</h1>
        <p className="mt-2 text-sm text-base-content/70">
          Paste your invite link or enter the invite code to continue.
        </p>

        <form className="mt-6 space-y-4" onSubmit={onSubmit}>
          <div>
            <label htmlFor="invite" className="label">
              <span className="label-text">Invite link or code</span>
            </label>
            <input
              id="invite"
              type="text"
              className="input input-bordered w-full"
              placeholder="https://your-mum.example.com/invite/xyz123 or xyz123"
              value={inviteInput}
              onChange={(e) => setInviteInput(e.target.value)}
              autoFocus
              required
            />
          </div>

          {error ? <p className="text-sm text-error">{error}</p> : null}

          <button type="submit" className={`btn btn-primary w-full ${submitting ? 'loading' : ''}`} disabled={submitting}>
            {submitting ? 'Checking…' : 'Continue'}
          </button>
        </form>

        <div className="mt-6 text-xs text-base-content/60">
          If you were given a custom invite path, include it after <code>/invite/</code>.
        </div>
      </div>
    </div>
  );
};

export default InviteLandingPage;
