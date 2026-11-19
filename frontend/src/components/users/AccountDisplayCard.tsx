import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../ui/button';
import { Card, CardContent } from '../ui/card';
import { SettingHeader } from './AccountSettings';
import { Label } from '../ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { useAccountDisplay } from '../../hooks/useAccountDisplay';
import { useAlerts } from '../../contexts/AlertContext';
import { getAccessToken } from '../../store/authStore';
import { deviceTimeZone, saveOwnDisplay, timeZoneChoices, type DisplayValues } from '../../lib/accountDisplay';

// The timezone list's value for following this device.
const DEVICE = 'device';

// "America/New York (GMT-5)": the zone's name and its offset today.
function zoneLabel(zone: string): string {
  if (zone === 'UTC') return zone;
  let offset = '';
  try { offset = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' }).formatToParts(new Date()).find(p => p.type === 'timeZoneName')?.value ?? ''; } catch { /* The name alone. */ }
  const name = zone.replaceAll('_', ' ');
  return offset && offset !== name ? `${name} (${offset})` : name;
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
  const zone = deviceTimeZone();
  const saved = values?.mode === 'named' ? values.time_zone : null;
  const zones = useMemo(() => {
    const list = timeZoneChoices();
    if (saved && !list.includes(saved)) list.push(saved);
    return list.map(value => ({ value, label: zoneLabel(value) }));
  }, [saved]);
  const chosen = !values || values.mode === 'device' ? DEVICE : values.mode === 'utc' ? 'UTC' : values.time_zone ?? DEVICE;
  const choose = (value: string) => values && edit(value === DEVICE ? { ...values, mode: 'device', time_zone: null }
    : value === 'UTC' ? { ...values, mode: 'utc', time_zone: null } : { ...values, mode: 'named', time_zone: value });
  return (
    <Card>
      <SettingHeader title="Time & timezone" info={<>
        <p>Choose how dates and times appear throughout MUM. These settings are saved to your account.</p>
        <p>This device's timezone follows the browser you are using. Choosing a timezone from the list keeps the same time display on every device.</p>
      </>} />
      <CardContent>
        <form className="space-y-5" onSubmit={e => void submit(e)}>
          <div className="space-y-2">
            <Label htmlFor="display-timezone">Timezone</Label>
            <Select disabled={disabled} value={chosen} onValueChange={choose}>
              <SelectTrigger id="display-timezone" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent className="max-h-72">
                <SelectItem value={DEVICE}>{zone ? `This Device's Timezone (${zone.replaceAll('_', ' ')})` : "This Device's Timezone"}</SelectItem>
                {zones.map(z => <SelectItem key={z.value} value={z.value}>{z.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="display-time-format">Time format</Label>
            <Select disabled={disabled} value={values?.time_format ?? '12'} onValueChange={(time_format: DisplayValues['time_format']) => values && edit({ ...values, time_format })}>
              <SelectTrigger id="display-time-format" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="12">12-hour (AM/PM)</SelectItem><SelectItem value="24">24-hour</SelectItem></SelectContent>
            </Select>
          </div>
          {error || readError ? <div className="account-setting-error flex flex-wrap items-center gap-3"><p className="text-sm text-destructive">{error ?? 'Could not read display settings.'}</p><Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void refresh()}>Refresh</Button></div> : null}
          <Button type="submit" disabled={disabled || Boolean(error) || !form} className="w-full sm:w-auto">{busy ? 'Saving…' : 'Save'}</Button>
        </form>
      </CardContent>
    </Card>
  );
}
