import {useState} from 'react';
import {useAuth} from '../../contexts/AuthContext';
import {activityID,type ActivityScope} from '../../lib/activityHistory';
import {Card,CardContent,CardDescription,CardHeader,CardTitle} from '@/components/ui/card';
import {Select,SelectContent,SelectItem,SelectTrigger,SelectValue} from '@/components/ui/select';
import {Input} from '@/components/ui/input';
import {Button} from '@/components/ui/button';
import {StreamingTable} from '../dashboard';

function HistoryFiltersForm({isAdministrator}:{isAdministrator:boolean}){
  const [scope,setScope]=useState<ActivityScope>('own'),[draft,setDraft]=useState(''),[server,setServer]=useState<string|undefined>();
  const selectedScope=scope==='all'&&isAdministrator?'all':'own';
  return <Card className="gap-3.5"><CardHeader><div className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between"><div><CardTitle className="text-xl">Streaming Sessions History</CardTitle><CardDescription>Review scoped observations and their source freshness.</CardDescription></div></div></CardHeader>
    <CardContent className="space-y-4"><div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
      <div className="space-y-1"><span className="text-sm text-muted-foreground">Scope</span><Select value={selectedScope} onValueChange={value=>setScope(value as ActivityScope)}><SelectTrigger className="h-9 w-full"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="own">My linked activity</SelectItem>{isAdministrator&&<SelectItem value="all">All authorized activity</SelectItem>}</SelectContent></Select></div>
      <div className="space-y-1"><span className="text-sm text-muted-foreground">Server ID</span><Input className="h-9" value={draft} placeholder="All visible servers" onChange={event=>setDraft(event.target.value)}/></div>
      <div className="space-y-1"><span className="text-sm text-muted-foreground">Service filter</span><Input className="h-9" disabled value="Not available"/></div>
      <div className="space-y-1"><span className="text-sm text-muted-foreground">Start date filter</span><Input className="h-9" disabled value="Not available"/></div>
      <div className="space-y-1"><span className="text-sm text-muted-foreground">End date filter</span><Input className="h-9" disabled value="Not available"/></div>
    </div><div className="flex items-center gap-2"><Button size="sm" disabled={draft!==''&&!activityID(draft)} onClick={()=>setServer(draft||undefined)}>Apply</Button><Button variant="ghost" size="sm" onClick={()=>{setDraft('');setServer(undefined);setScope('own');}}>Clear</Button></div>
    <StreamingTable scope={selectedScope} server={server}/></CardContent></Card>;
}

export function StreamingHistoryFilters(){
  const {user,isAdministrator}=useAuth();
  return <HistoryFiltersForm key={user?.uuid??'anonymous'} isAdministrator={isAdministrator}/>;
}
