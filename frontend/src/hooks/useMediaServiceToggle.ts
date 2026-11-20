import { useState } from 'react';
import { useAlerts } from '../contexts';
import { requestMediaServiceMutation } from '../util/mediaServiceMutations';
import { type MediaService } from './useMediaServices';

/** Turns a whole media service on or off, one at a time, with a message either way. */
export const useMediaServiceToggle = () => {
  const { success, error: showError } = useAlerts();
  const [busy, setBusy] = useState<string | null>(null);
  const toggle = async (service: MediaService, on: boolean) => {
    if (busy) return;
    setBusy(service.id);
    try {
      await requestMediaServiceMutation(`/api/providers/${service.id}/${on ? 'enable' : 'disable'}`, { method: 'POST' });
      success(`${service.name} turned ${on ? 'on' : 'off'}.`);
    } catch (err) {
      showError(`Couldn’t turn ${service.name} ${on ? 'on' : 'off'}: ${(err as Error).message ?? 'Unknown error'}`);
    } finally {
      setBusy(null);
    }
  };
  return { busy, toggle };
};
