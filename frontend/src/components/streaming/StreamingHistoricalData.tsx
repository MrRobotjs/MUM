import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';

type StreamingSummary = {
  by_service: Array<{ service_type: string; count: number }>;
  by_server: Array<{ server_name: string; service_type: string; count: number }>;
};

interface StreamingHistoricalDataProps {
  summary: StreamingSummary | null;
}

export const StreamingHistoricalData = ({ summary }: StreamingHistoricalDataProps) => {
  if (!summary) return null;

  const byServer = summary.by_server ?? [];
  const byService = summary.by_service ?? [];
  const serverMax = byServer.reduce((max, entry) => Math.max(max, entry.count), 0);
  const serviceMax = byService.reduce((max, entry) => Math.max(max, entry.count), 0);
  const toPercent = (count: number, max: number) => (max > 0 ? Math.round((count / max) * 100) : 0);

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="text-base font-semibold">Streams by server</CardTitle>
          <CardDescription>Activity split by individual media servers.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2 text-sm text-foreground/80">
            {byServer.length === 0 ? (
              <li className="text-muted-foreground">No recent streams.</li>
            ) : null}
            {byServer.map((entry) => (
              <li
                key={`${entry.server_name}-${entry.service_type}`}
                className="space-y-2 rounded-lg border bg-muted/50 px-3 py-2"
              >
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="font-medium text-foreground">{entry.server_name || 'Unknown Server'}</div>
                    <div className="text-xs uppercase text-muted-foreground">{entry.service_type}</div>
                  </div>
                  <span className="font-medium text-foreground">{entry.count}</span>
                </div>
                <Progress value={toPercent(entry.count, serverMax)} />
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="text-base font-semibold">Streams by service type</CardTitle>
          <CardDescription>Overall activity across each service type.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2 text-sm text-foreground/80">
            {byService.length === 0 ? (
              <li className="text-muted-foreground">No recent streams.</li>
            ) : null}
            {byService.map((entry) => (
              <li
                key={entry.service_type}
                className="space-y-2 rounded-lg border bg-muted/50 px-3 py-2"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium uppercase text-foreground">{entry.service_type}</span>
                  <span className="text-muted-foreground">{entry.count}</span>
                </div>
                <Progress value={toPercent(entry.count, serviceMax)} />
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
};
