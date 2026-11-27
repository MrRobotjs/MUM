import { useState } from 'react';
import useSWR from 'swr';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faDownload, faEye, faTrash, faTriangleExclamation } from '@fortawesome/free-solid-svg-icons';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { InfoButton } from '../common/InfoButton';
import { Button } from '../ui/button';
import { Switch } from '../ui/switch';
import { Spinner } from '../ui/spinner';
import { ResponsiveDialog } from '../ui/responsive-dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';
import { ServiceIcon } from '../services/ServiceIcon';
import { useAuth } from '../../contexts/AuthContext';
import { useAlerts } from '../../contexts/AlertContext';
import { useAccountDisplay } from '../../hooks/useAccountDisplay';
import { formatBytes } from '../../lib/plexResources';
import {
  clearDebugLogs,
  downloadDebugLog,
  fetchDebugLogging,
  fetchDebugRecords,
  saveDebugStream,
  type DebugRecord,
  type DebugStream,
  type DebugTransport,
} from '../../lib/debugLogging';

// Debug Logging on the API Debug page: each service's HTTP and WebSocket
// streams switch on straight away for a limited time; the newest records can
// be read here and the files downloaded or cleared.

const transportLabel: Record<DebugTransport, string> = { http: 'HTTP', websocket: 'WebSocket' };

function prettyBody(body: string): string {
  try { return JSON.stringify(JSON.parse(body), null, 2); } catch { return body; }
}

function RecordsDialog({ stream, onClose }: { stream: DebugStream | null; onClose: () => void }) {
  const { formatTimestamp } = useAccountDisplay();
  const { data, error, isLoading } = useSWR(stream ? ['debug-records', stream.provider, stream.transport] as const : null,
    ([, provider, transport]) => fetchDebugRecords(provider, transport, 50), { refreshInterval: 5000 });
  return (
    <ResponsiveDialog size="lg" open={stream !== null} onOpenChange={open => { if (!open) onClose(); }}
      title={stream ? `${stream.provider_name} ${transportLabel[stream.transport]} log` : ''}
      description="The newest 50 records, newest first. Credentials are removed."
      footer={<Button variant="outline" onClick={onClose}>Close</Button>}>
      {error ? <p className="text-sm text-muted-foreground">The log couldn’t be read.</p>
        : isLoading && !data ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner className="size-4 text-muted-foreground" />Loading…</div>
        : !data || data.length === 0 ? <p className="text-sm text-muted-foreground">Nothing recorded yet. Records appear as {stream?.provider_name} sends MUM data.</p>
        : <div className="space-y-2">{data.map((record: DebugRecord, n) => (
          <details key={n} className="rounded-lg border bg-card p-3">
            <summary className="cursor-pointer text-sm">
              <span className="font-mono text-xs text-muted-foreground">{formatTimestamp(record.time)}</span>{' '}
              {record.transport === 'http'
                ? <><span className="font-medium">{record.method} {record.status ?? ''}</span> <span className="break-all text-muted-foreground">{record.url}</span></>
                : <span className="font-medium">{record.direction === 'sent' ? 'Sent' : 'Received'}</span>}
              <span className="text-xs text-muted-foreground"> · {formatBytes(record.bytes)}{record.duration_ms !== null ? ` · ${record.duration_ms} ms` : ''}{record.truncated ? ' · shortened' : ''}{record.server ? ` · ${record.server}` : ''}</span>
            </summary>
            {record.error && <p className="mt-2 text-sm text-red-600">{record.error}</p>}
            {record.body ? <pre className="mt-2 max-h-100 overflow-auto rounded bg-muted/40 p-2 text-xs whitespace-pre-wrap break-all">{prettyBody(record.body)}</pre>
              : !record.error && <p className="mt-2 text-xs text-muted-foreground">No text body.</p>}
          </details>
        ))}</div>}
    </ResponsiveDialog>
  );
}

export function DebugLoggingCard() {
  const { user, isAdministrator } = useAuth();
  const { formatTimestamp } = useAccountDisplay();
  const { success, error: showError } = useAlerts();
  const { data, error, isLoading, mutate } = useSWR(isAdministrator && user?.uuid ? ['debug-logging', user.uuid] as const : null, () => fetchDebugLogging(), { refreshInterval: 15000 });
  const [busy, setBusy] = useState<string | null>(null);
  const [viewing, setViewing] = useState<DebugStream | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const toggle = async (stream: DebugStream, enabled: boolean) => {
    const key = `${stream.provider}-${stream.transport}`;
    setBusy(key);
    try {
      const next = await saveDebugStream(stream.provider, stream.transport, enabled);
      await mutate(next, { revalidate: false });
      success(enabled ? `${stream.provider_name} ${transportLabel[stream.transport]} logging is on for ${next.window_hours} hours` : `${stream.provider_name} ${transportLabel[stream.transport]} logging is off`);
    } catch {
      showError('Debug logging couldn’t be changed. Refresh and try again.');
    } finally {
      setBusy(null);
    }
  };
  const clear = async () => {
    setBusy('clear');
    try {
      await mutate(await clearDebugLogs(), { revalidate: false });
      success('Debug logs cleared');
      setConfirmClear(false);
    } catch {
      showError('The debug logs couldn’t be cleared.');
    } finally {
      setBusy(null);
    }
  };
  const download = async (name: string) => {
    try { await downloadDebugLog(name); } catch { showError('The log couldn’t be downloaded.'); }
  };
  const hasFile = (stream: DebugStream) => data?.files.some(f => f.provider === stream.provider && f.transport === stream.transport) ?? false;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-amber-500/20 flex items-center justify-center shrink-0">
            <FontAwesomeIcon icon={faTriangleExclamation} className="text-amber-500 text-sm" />
          </div>
          <div>
            <div className="flex items-center gap-1">
              <CardTitle>Debug Logging</CardTitle>
              <InfoButton title="What the logs contain">
                <p>Logs record what media servers send MUM: user names, email addresses, IP addresses, titles and playback details. Share them with care.</p>
                <p>Tokens, API keys, passwords, cookies and sign-in codes are removed before anything is written, and what MUM sends in request bodies is never logged.</p>
                <p>Each stream turns itself off after {data?.window_hours ?? 24} hours. Files are kept in the Debug Logs folder of the application data directory, up to 20 MB per stream, until you clear them.</p>
              </InfoButton>
            </div>
            <CardDescription>Record what media servers send MUM, for troubleshooting</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">Logs include user names, email addresses and IP addresses, so share them with care.</p>

        {error ? <p className="text-sm text-muted-foreground">Debug logging settings couldn’t be loaded. Refresh the page.</p>
          : isLoading && !data ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner className="size-4 text-muted-foreground" />Loading debug logging…</div>
          : data && !data.available ? <p className="text-sm text-muted-foreground">Debug logging needs a writable application data directory.</p>
          : data && data.streams.length === 0 ? <p className="text-sm text-muted-foreground">Add a media server to record its traffic.</p>
          : data && <div className="space-y-3">
            {data.streams.map(stream => {
              const key = `${stream.provider}-${stream.transport}`;
              return (
                <div key={key} className="flex items-center justify-between gap-3 rounded-lg border border-border/70 bg-muted/40 p-3">
                  <div className="flex min-w-0 items-start gap-2">
                    <ServiceIcon serviceType={stream.provider} className="mt-0.5 h-4 w-4 shrink-0" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{stream.provider_name} {transportLabel[stream.transport]} logging</p>
                      <p className="text-xs text-muted-foreground">
                        {stream.enabled && stream.enabled_until ? `On until ${formatTimestamp(stream.enabled_until)}`
                          : stream.transport === 'http' ? `Records each response ${stream.provider_name} sends MUM.` : `Records each socket message between ${stream.provider_name} and MUM.`}
                      </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {hasFile(stream) && <Button type="button" variant="ghost" size="sm" onClick={() => setViewing(stream)}><FontAwesomeIcon icon={faEye} className="mr-1" />View</Button>}
                    {busy === key && <Spinner className="size-4 text-muted-foreground" />}
                    <Switch checked={stream.enabled} disabled={busy !== null} aria-label={`${stream.provider_name} ${transportLabel[stream.transport]} logging`}
                      onCheckedChange={checked => void toggle(stream, checked)} />
                  </div>
                </div>
              );
            })}

            {data.dropped_records > 0 && <p className="text-xs text-muted-foreground">{data.dropped_records.toLocaleString()} records were dropped because MUM was receiving them faster than it could write them.</p>}

            {data.files.length > 0 && <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium">Log files</p>
                <Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={() => setConfirmClear(true)}><FontAwesomeIcon icon={faTrash} className="mr-1" />Clear logs</Button>
              </div>
              <div className="overflow-x-auto rounded-md border">
                <Table>
                  <TableHeader><TableRow><TableHead>File</TableHead><TableHead>Size</TableHead><TableHead>Updated</TableHead><TableHead /></TableRow></TableHeader>
                  <TableBody>{data.files.map(file => <TableRow key={file.name}>
                    <TableCell className="font-mono text-xs">{file.name}</TableCell>
                    <TableCell className="whitespace-nowrap text-sm">{formatBytes(file.size_bytes)}</TableCell>
                    <TableCell className="whitespace-nowrap text-sm">{formatTimestamp(file.modified_at)}</TableCell>
                    <TableCell className="text-right"><Button type="button" variant="ghost" size="sm" onClick={() => void download(file.name)}><FontAwesomeIcon icon={faDownload} className="mr-1" />Download</Button></TableCell>
                  </TableRow>)}</TableBody>
                </Table>
              </div>
            </div>}
          </div>}
      </CardContent>

      <RecordsDialog stream={viewing} onClose={() => setViewing(null)} />
      <ResponsiveDialog open={confirmClear} onOpenChange={setConfirmClear} title="Clear debug logs?" description="This can’t be undone."
        footer={<><Button variant="outline" onClick={() => setConfirmClear(false)}>Cancel</Button><Button variant="destructive" disabled={busy === 'clear'} onClick={() => void clear()}>Clear logs</Button></>}>
        <p className="text-sm">Every debug log file is deleted. Logging that is on keeps recording into new files.</p>
      </ResponsiveDialog>
    </Card>
  );
}
