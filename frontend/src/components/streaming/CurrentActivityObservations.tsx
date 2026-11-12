import {useState} from 'react';
import {useAuth} from '../../contexts/AuthContext';
import {useAccountDisplay} from '../../hooks/useAccountDisplay';
import {useActivityCurrent} from '../../hooks/useActivityHistory';
import {observationAccountLabels,observationPosition,observationProgress,type ActivityScope,type ActivityHistoryRow} from '../../lib/activityHistory';
import {Card,CardContent,CardDescription,CardHeader,CardTitle} from '@/components/ui/card';
import {Button} from '@/components/ui/button';
import {Badge} from '@/components/ui/badge';
import {Progress} from '@/components/ui/progress';
import {Select,SelectContent,SelectItem,SelectTrigger,SelectValue} from '@/components/ui/select';

function ObservationPanel({administrator}:{administrator:boolean}){
  const [scope,setScope]=useState<ActivityScope>('own'),[style,setStyle]=useState('detailed'),[group,setGroup]=useState('merged');
  const selectedScope=scope==='all'&&administrator?'all':'own';
  const {page,loading,error,refresh,hasPrevious,previous,next,latest}=useActivityCurrent(selectedScope);
  const {formatTimestamp}=useAccountDisplay();
  const grouped=new Map<string,ActivityHistoryRow[]>();
  for(const row of page?.items??[]){
    const source=page?.servers.find(server=>server.server_id===row.server_id);
    const key=group==='server'?`${source?.provider} · Server ${row.server_id}`:group==='service'?source?.provider??'Unknown':'Observations';
    grouped.set(key,[...(grouped.get(key)??[]),row]);
  }
  return <Card className="pt-0 gap-0 overflow-hidden border border-border/60 shadow-md">
    <CardHeader className="pt-6 border-b border-border/60 bg-gradient-to-r from-primary/5 via-transparent to-transparent pb-4">
      <div className="flex items-center justify-between gap-3"><div><CardTitle className="text-xl">Current observations</CardTitle><CardDescription>Last retained Jellyfin/Emby observations. Refresh reads saved observations; it does not request a provider poll.</CardDescription></div><Button variant="outline" disabled={loading} onClick={()=>void refresh().catch(()=>{})}>Refresh</Button></div>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={selectedScope} onValueChange={value=>setScope(value as ActivityScope)}><SelectTrigger className="h-9 w-full"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="own">My linked activity</SelectItem>{administrator&&<SelectItem value="all">All authorized activity</SelectItem>}</SelectContent></Select>
        <Select value={style} onValueChange={setStyle}><SelectTrigger className="h-9 w-full"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="detailed">Detailed cards</SelectItem><SelectItem value="compact">Compact cards</SelectItem></SelectContent></Select>
        <Select value={group} onValueChange={setGroup}><SelectTrigger className="h-9 w-full"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="merged">Merged</SelectItem><SelectItem value="server">By server</SelectItem><SelectItem value="service">By service</SelectItem></SelectContent></Select>
      </div>
    </CardHeader>
    <CardContent className="space-y-4">
      {error?<p className="text-sm text-destructive">Current observations are unavailable. Refresh to retry.</p>:loading||!page?<p className="text-sm text-muted-foreground">Loading observations...</p>:<>
        <p className="text-sm text-muted-foreground">{selectedScope==='own'?'Your currently linked primary accounts.':'Administrator scope.'} Read at {formatTimestamp(page.read_at)}. Positions describe this page only. Playback, device/network details and termination cannot be inferred from these observations.</p>
        <div className="space-y-2 text-sm text-muted-foreground">{page.servers.map(source=><p key={source.server_id}>{source.provider} · Server {source.server_id}: {source.freshness}; {source.age_seconds===null?'never observed':`${source.age_seconds} seconds since observation`}; pending: {source.pending}.</p>)}</div>
        {page.items.length===0?<div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border/60 bg-muted/30 py-12 text-muted-foreground">No current observations are available in this authorized page.</div>:Array.from(grouped).map(([label,rows])=><div className="space-y-4" key={label}>
          {group!=='merged'&&<h3 className="mb-3 flex items-center gap-2 text-lg font-semibold text-foreground">{label}</h3>}
          <div className={style==='compact'?'grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3':'grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3'}>{rows.map(row=>{
            const source=page.servers.find(s=>s.server_id===row.server_id),progress=observationProgress(row.position_ticks,row.duration_ticks);
            return <Card key={row.id} className="group relative overflow-hidden rounded-xl border border-border/50 bg-card shadow-md transition-all duration-300 hover:shadow-lg"><CardHeader><CardTitle className="text-base font-semibold">{row.title}</CardTitle><CardDescription>{row.media_type} · {source?.provider} · Server {row.server_id}</CardDescription><Badge variant="secondary">{source?.freshness} · last observed {row.paused?'paused':'playing'}</Badge></CardHeader>
              <CardContent className="space-y-4"><p className="text-sm text-muted-foreground">Position {observationPosition(row.position_ticks)} / Duration {observationPosition(row.duration_ticks)}</p>{progress===null?<p className="text-sm text-muted-foreground">Progress unknown</p>:<Progress value={progress}/>}
                {style==='detailed'&&<div className="space-y-2 text-sm text-muted-foreground"><p>Observed {formatTimestamp(row.last_observed_at)}</p><p>Quality: Unknown · Bandwidth: Unknown · Location: Unknown</p><p>Device: Unknown · Watched duration: Unknown</p></div>}
                <p className="text-xs text-muted-foreground">{observationAccountLabels(row,selectedScope).owner} · {observationAccountLabels(row,selectedScope).account}</p>
                <Button variant="outline" disabled>Termination unavailable</Button>
              </CardContent></Card>;
          })}</div>
        </div>)}
        <div className="flex items-center justify-between gap-3"><Button variant="outline" disabled={!hasPrevious} onClick={previous}>Newer page</Button><Button variant="ghost" onClick={()=>{latest();void refresh().catch(()=>{});}}>Latest observations</Button><Button variant="outline" disabled={!page.next_before} onClick={next}>Older page</Button></div>
      </>}
    </CardContent>
  </Card>;
}
export function CurrentActivityObservations(){const {user,isAdministrator}=useAuth();return <ObservationPanel key={user?.uuid??'anonymous'} administrator={isAdministrator}/>;}
