import { requestJson } from './apiClient';
import { revalidatePluginsCache } from '../cache/pluginsCache';

export const requestPluginMutation = async <T = unknown>(
  input: RequestInfo,
  init: RequestInit = {}
): Promise<T> => {
  const response = await requestJson<T>(input, init);
  await revalidatePluginsCache();
  return response;
};
