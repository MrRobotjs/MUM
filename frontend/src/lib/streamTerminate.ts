import { requestJson } from '../util/apiClient';

// Stops a current stream on its server, with an optional message to the
// viewer. Only the owner and full administrators may; the server checks. The
// request is sent once: a failed or uncertain stop is never repeated.
export async function terminateStream(sessionKey: string, message: string): Promise<void> {
  // Streams page session keys are "<server id>:<observation id>".
  const match = /^\d+:(\d+)$/.exec(sessionKey);
  if (!match) throw new Error('Invalid stream');
  const id = match[1];
  const { data } = await requestJson<{ data?: { id?: unknown; status?: unknown } }>(`/api/activity/current/${id}/terminate`, {
    method: 'POST',
    body: JSON.stringify({ message: message.trim() }),
  });
  if (data?.id !== id || data.status !== 'terminated') throw new Error('The server returned an unexpected answer');
}
