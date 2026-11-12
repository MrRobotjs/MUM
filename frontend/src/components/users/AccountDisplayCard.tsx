import { useEffect, useRef, useState } from 'react';
import { Button } from '../ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Alert, AlertDescription } from '../ui/alert';
import { useAccountDisplay } from '../../hooks/useAccountDisplay';
import { useAlerts } from '../../contexts/AlertContext';
import { getAccessToken } from '../../store/authStore';
import { saveOwnDisplay, type DisplayValues } from '../../lib/accountDisplay';

function detectedZone(): string | null {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; }
}

export function AccountDisplayCard() {
  const { current, owner, error: readError, mutate } = useAccountDisplay();
  const { success } = useAlerts();
  const generation = useRef(0), activeOwner = useRef(owner), pending = useRef(false);
  activeOwner.current = owner;
  const [form, setForm] = useState<{ owner: string; revision: number; values: DisplayValues } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  useEffect(() => {
    generation.current++; pending.current = false; setBusy(false); setError(null); setForm(null);
    return () => { generation.current++; };
  }, [owner]);
  const values = form && form.owner === owner ? form.values : current?.display;
  const disabled = busy || !current || Boolean(readError);
  const edit = (next: DisplayValues) => {
    if (owner && current && !disabled) setForm(previous => ({ owner, revision: previous?.owner === owner ? previous.revision : current.profile_revision, values: next }));
  };
  const refresh = async () => {
    if (pending.current) return;
    const run = generation.current; setBusy(true);
    try { const result = await mutate(); if (run === generation.current && activeOwner.current === owner) { setForm(null); setError(result ? null : 'Could not read display settings.'); } }
    catch { if (run === generation.current && activeOwner.current === owner) setError('Could not read display settings.'); }
    finally { if (run === generation.current && activeOwner.current === owner) setBusy(false); }
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!current || !values || disabled || pending.current) return;
    if (form && form.owner === owner && form.revision !== current.profile_revision) {
      setError('Your account settings changed while editing. Refresh before saving.');
      return;
    }
    const run = generation.current, token = getAccessToken();
    const scoped = () => run === generation.current && activeOwner.current === owner;
    pending.current = true; setBusy(true); setError(null);
    try {
      const result = await saveOwnDisplay(current, values);
      if (!scoped() || token !== getAccessToken()) return;
      await mutate(result, false);
      if (!scoped() || token !== getAccessToken()) return;
      setForm(null); success('Display preferences saved.');
    } catch (e) {
      if (scoped()) {
        setError((e as Error).message);
        try { await mutate(); } catch { /* Reconciliation reads never replay a mutation. */ }
      }
    } finally { if (scoped()) { pending.current = false; setBusy(false); } }
  };
  const zone = detectedZone();
  return <Card><CardHeader><CardTitle>Timezone Settings</CardTitle><CardDescription>
    Display settings are saved to your account independently of stream-counter sync. Device mode uses each browser's timezone. UTC and named zones apply across devices.
  </CardDescription></CardHeader><CardContent><form className="space-y-4" onSubmit={e => void submit(e)}>
    <div className="space-y-2"><Label>Display Time In</Label><Select disabled={disabled} value={values?.mode ?? 'device'} onValueChange={(mode: DisplayValues['mode']) => values && edit({ ...values, mode, time_zone: mode === 'named' ? zone ?? 'UTC' : null })}>
      <SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent>
        <SelectItem value="device">This Device's Timezone</SelectItem><SelectItem value="utc">UTC</SelectItem><SelectItem value="named">Named Timezone</SelectItem>
      </SelectContent></Select></div>
    {values?.mode === 'named' ? <div className="space-y-2"><Label htmlFor="local-timezone">Named Timezone</Label>
      <Input id="local-timezone" placeholder="e.g. America/New_York" value={values.time_zone ?? ''} disabled={disabled} maxLength={128} onChange={e => edit({ ...values, time_zone: e.target.value })} required />
      {zone ? <button type="button" disabled={disabled} className="text-sm text-primary underline-offset-4 hover:underline" onClick={() => edit({ ...values, time_zone: zone })}>Use detected timezone ({zone})</button> : null}
    </div> : null}
    <div className="space-y-2"><Label>Time Format</Label><Select disabled={disabled} value={values?.time_format ?? '12'} onValueChange={(time_format: DisplayValues['time_format']) => values && edit({ ...values, time_format })}>
      <SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="12">12-hour (AM/PM)</SelectItem><SelectItem value="24">24-hour</SelectItem></SelectContent>
    </Select></div>
    {error || readError ? <Alert variant="destructive"><AlertDescription>{error ?? 'Could not read display settings. Refresh before saving.'}</AlertDescription></Alert> : null}
    <Button type="submit" disabled={disabled || Boolean(error)} className="w-full sm:w-auto">{busy ? 'Saving…' : 'Save Preferences'}</Button>
    <Button type="button" variant="outline" disabled={busy} onClick={() => void refresh()}>Refresh Display Settings</Button>
  </form></CardContent></Card>;
}
