import { requestJson } from './apiClient';
import { revalidateMediaServices } from '../cache/mediaServicesCache';

/** Sends a change to a media service (turning it on or off), then reads the media services again. */
export const requestMediaServiceMutation = async <T = unknown>(input: RequestInfo, init: RequestInit = {}): Promise<T> => {
  const response = await requestJson<T>(input, init);
  await revalidateMediaServices();
  return response;
};
