import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

type StreamingSummary = {
  daily: Array<{ date: string; count: number }>;
  by_service: Array<{ service_type: string; count: number }>;
};

interface StreamingHistoricalDataProps {
  summary: StreamingSummary | null;
}

export const StreamingHistoricalData = ({ summary }: StreamingHistoricalDataProps) => {
  if (!summary) return null;

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="text-base font-semibold">Daily activity</CardTitle>
          <CardDescription>Recent stream counts by day.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-1 text-xs text-foreground/80">
            {summary.daily.length === 0 ? (
              <li className="text-muted-foreground">No activity in the selected range.</li>
            ) : null}
            {summary.daily.slice(-14).map((point) => (
              <li
                key={point.date}
                className="flex items-center justify-between rounded-lg border bg-muted/50 px-3 py-2"
              >
                <span>{new Date(point.date).toLocaleDateString()}</span>
                <span className="font-medium text-foreground">{point.count}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="text-base font-semibold">Streams by service</CardTitle>
          <CardDescription>Breakdown of streams per media service.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2 text-sm text-foreground/80">
            {summary.by_service.length === 0 ? (
              <li className="text-muted-foreground">No recent streams.</li>
            ) : null}
            {summary.by_service.map((entry) => (
              <li
                key={entry.service_type}
                className="flex items-center justify-between rounded-lg border bg-muted/50 px-3 py-2 uppercase"
              >
                <span className="font-medium text-foreground">{entry.service_type}</span>
                <span className="text-muted-foreground">{entry.count}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
};
