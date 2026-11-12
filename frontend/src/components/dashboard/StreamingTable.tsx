import {useAccountDisplay} from '../../hooks/useAccountDisplay';
import {useActivityHistory} from '../../hooks/useActivityHistory';
import {observationAccountLabels,type ActivityScope} from '../../lib/activityHistory';
import {Avatar,AvatarFallback} from '@/components/ui/avatar';
import {Button} from '@/components/ui/button';
import {Spinner} from '@/components/ui/spinner';
import {Table,TableBody,TableCaption,TableCell,TableHead,TableHeader,TableRow} from '@/components/ui/table';

export function StreamingTable({scope='own',server}:{scope?:ActivityScope;server?:string}) {
  const {formatTimestamp}=useAccountDisplay();
  const {page,loading,error,refresh,hasPrevious,next,previous,latest}=useActivityHistory(scope,server);
  if(error)return <div className="text-sm text-muted-foreground">Activity history is unavailable. <Button variant="outline" onClick={()=>void refresh().catch(()=>{})}>Refresh history</Button></div>;
  if(loading||!page)return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner className="size-4"/> Loading observations…</div>;
  return <div className="space-y-4">
    <div className="text-sm text-muted-foreground">{scope==='own'?'Your currently linked primary accounts and their attributed observations.':'Administrator view of all authorized observations.'} These are observed boundaries, not playback start/stop times or watched duration.</div>
    <div className="space-y-2 text-sm text-muted-foreground">{page.servers.map(status=><p key={status.server_id}>{status.provider} · Server {status.server_id}: {status.freshness}; {status.age_seconds===null?'never observed':`${status.age_seconds} seconds since observation`}; pending: {status.pending}.</p>)}</div>
    <div className="overflow-hidden rounded-xl border bg-card text-foreground shadow-sm"><Table>
      <TableHeader><TableRow className="text-xs uppercase text-muted-foreground"><TableHead className="w-[1%]">Title</TableHead><TableHead className="w-[1%]">Attributed account</TableHead><TableHead className="w-[1%]">Server</TableHead><TableHead className="w-[1%]">First observed</TableHead><TableHead className="w-[1%]">Last observed</TableHead><TableHead className="w-[1%]">Observation</TableHead></TableRow></TableHeader>
      <TableBody>{page.items.map(row=><TableRow key={row.id}>
        <TableCell className="font-medium w-[1%]"><div className="flex items-center gap-3 min-w-0"><div className="h-12 w-8 shrink-0 rounded-md bg-muted/60"/><span className="max-w-[280px] truncate leading-tight">{row.title}</span></div></TableCell>
        <TableCell className="w-[1%]"><div className="flex items-center gap-2"><Avatar className="h-7 w-7"><AvatarFallback>U</AvatarFallback></Avatar><span>{observationAccountLabels(row,scope).owner}</span></div><span className="text-xs text-muted-foreground">{observationAccountLabels(row,scope).account}</span></TableCell>
        <TableCell className="w-[1%]">{page.servers.find(s=>s.server_id===row.server_id)?.provider} · {row.server_id}</TableCell>
        <TableCell className="w-[1%]">{formatTimestamp(row.first_observed_at)}</TableCell><TableCell className="w-[1%]">{formatTimestamp(row.last_observed_at)}</TableCell>
        <TableCell className="w-[1%]">{row.ended_observation_at?`Ended observation: ${row.end_reason?.replace(/_/g,' ')} (${formatTimestamp(row.ended_observation_at)})`:`Last observed ${row.paused?'paused':'playing'}`}</TableCell>
      </TableRow>)}{page.items.length===0&&<TableRow><TableCell colSpan={6} className="py-6 text-center text-sm text-muted-foreground">No observations are available in this authorized page.</TableCell></TableRow>}</TableBody><TableCaption className="sr-only">Scoped activity observation history</TableCaption>
    </Table><div className="border-t bg-muted/50 px-4 py-3"><div className="flex items-center justify-between gap-3"><Button variant="outline" disabled={!hasPrevious} onClick={previous}>Newer page</Button><Button variant="ghost" onClick={()=>{latest();void refresh().catch(()=>{});}}>Latest observations</Button><Button variant="outline" disabled={!page.next_before} onClick={next}>Older page</Button></div></div></div>
  </div>;
}
export default StreamingTable;
