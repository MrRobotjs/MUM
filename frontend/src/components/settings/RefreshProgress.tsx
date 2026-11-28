import { Progress } from '../ui/progress';
import type { RefreshProgress as Progressing } from '../../lib/scheduledTasks';

const number = (n: number) => n.toLocaleString();

/** What a running refresh is doing and, when the server gives a total, how far it has got. */
export function refreshProgressText(scope: 'users' | 'libraries', p: Progressing): { line: string; detail?: string; percent?: number } {
  const percent = p.total > 0 ? Math.min(100, (p.done / p.total) * 100) : undefined;
  switch (p.phase) {
    case 'list':
      return { line: scope === 'users' ? 'Reading the users list' : 'Reading the libraries list' };
    case 'items':
      return { line: p.library, detail: p.total > 0 ? `${number(p.done)} of ${number(p.total)} items` : `${number(p.done)} items read`, percent };
    default: {
      const parents = p.phase === 'tracks' ? 'albums' : 'shows';
      return { line: `${p.library} — ${p.phase}: ${p.current}`, detail: p.total > 0 ? `${number(Math.min(p.done + 1, p.total))} of ${number(p.total)} ${parents}` : undefined, percent };
    }
  }
}

export function RefreshProgress({ scope, progress }: { scope: 'users' | 'libraries'; progress: Progressing }) {
  const { line, detail, percent } = refreshProgressText(scope, progress);
  return (
    <div className="space-y-1">
      <p className="truncate text-xs text-muted-foreground" title={line}>{line}</p>
      {percent !== undefined && <Progress value={percent} className="h-2" aria-label={detail} />}
      {detail && <p className="text-xs text-muted-foreground">{detail}</p>}
    </div>
  );
}
