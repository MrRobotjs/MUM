import {useState} from 'react';
import {useAuth} from '../contexts/AuthContext';
import {useAlerts} from '../contexts/AlertContext';
import {TerminateSessionModal} from '../components/streaming/TerminateSessionModal';
import {terminateStream} from '../lib/streamTerminate';
import type {ActiveSession} from '../types/streaming';
import {Button} from '../components/ui/button';
import {StreamingSettingsModal} from '../components/dashboard/StreamingSettingsModal';
import {PageHeader} from '../components';
import {ActiveStreamsCard} from '../components/streaming/ActiveStreamsCard';
import {StreamingSessionsMap} from '../components/streaming/StreamingSessionsMap';
import {useLiveStreams} from '../hooks/useLiveStreams';
import {usePlaybackClock} from '../hooks/usePlaybackClock';
import {readStreamDisplayDefaults} from '../lib/liveStreams';
import type {ViewMode,StreamCardStyle} from '../types/streaming';

export const StreamingPage=()=> {
 const [settingsOpen,setSettingsOpen]=useState(false);
 const streams=useLiveStreams();
 const liveData=usePlaybackClock(streams.data);
 const [defaults,setDefaults]=useState(()=>readStreamDisplayDefaults(streams.actor));
 const [viewMode,setViewMode]=useState<ViewMode>(defaults.default_grouping),[style,setStyle]=useState<StreamCardStyle>(defaults.default_card_style);
 const updated=streams.data?new Date(streams.data.read_at):null;
 // Only the owner and full administrators stop streams (the server checks too).
 const {isAdministrator}=useAuth();
 const {success,error}=useAlerts();
 const [terminating,setTerminating]=useState<ActiveSession|null>(null),[terminateMessage,setTerminateMessage]=useState(''),[stopping,setStopping]=useState(false);
 const confirmTerminate=async()=>{
  if(!terminating||stopping)return;
  const target=terminating;setStopping(true);
  try{await terminateStream(target.session_key,terminateMessage);success(`Stopped ${target.user}'s stream.`);setTerminating(null);void streams.refresh();}
  catch(err){error(err instanceof Error&&err.message?err.message:'The stream could not be stopped.');}
  finally{setStopping(false);}
 };
 return <div className="space-y-6">
  <PageHeader title="Streams" description="Monitor real-time playback across all connected media servers." actions={<Button variant="outline" onClick={()=>setSettingsOpen(true)}>Streaming Settings</Button>}/>
  <div className="space-y-4">
   <ActiveStreamsCard key={streams.scopeKey} sessionsData={liveData??null} viewMode={viewMode} onViewModeChange={setViewMode} streamCardStyle={style} onStreamCardStyleChange={setStyle} defaultViewMode={defaults.default_grouping} defaultStreamCardStyle={defaults.default_card_style} onSaveDisplayDefaults={value=>{setDefaults(value);setViewMode(value.default_grouping);setStyle(value.default_card_style);if(streams.actor)try{window.localStorage.setItem(`streamDisplaySettings:${streams.actor}`,JSON.stringify(value));}catch{/* device storage is optional */}}} onManualRefresh={()=>{void streams.refresh().catch(()=>{});}} manualRefreshLoading={streams.loading} loading={streams.loading} bootstrapping={streams.loading} wsTruthActive={Boolean(streams.isConnected&&streams.data?.sessions.some(s=>s.source==='ws'))} isConnected={streams.isConnected} lastUpdateAt={updated} lastWsUpdateAt={null} lastHttpUpdateAt={streams.isConnected?null:updated} sessionMonitoringInterval={streams.isConnected?null:5} onTerminateSession={isAdministrator?session=>{setTerminateMessage('');setTerminating(session);}:undefined}/>
   {streams.error&&<p className="text-sm text-destructive">Streams could not be refreshed. Use refresh to retry.</p>}
   {Boolean(streams.data?.unavailable_sources.length)&&<p className="text-sm text-muted-foreground">Sources without fresh observations: {streams.data?.unavailable_sources.join(', ')}. Check activity monitoring in Advanced settings.</p>}
  </div>
  <div className="space-y-4"><StreamingSessionsMap key={streams.scopeKey} sessions={streams.data?.sessions??[]}/></div>
  <StreamingSettingsModal open={settingsOpen} onClose={()=>setSettingsOpen(false)}/>
  <TerminateSessionModal open={terminating!==null} session={terminating} message={terminateMessage} onMessageChange={setTerminateMessage} onClose={()=>{if(!stopping)setTerminating(null);}} onConfirm={()=>{void confirmTerminate();}}/>
</div>;
};
export default StreamingPage;
