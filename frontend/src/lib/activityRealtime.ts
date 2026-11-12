import {getAccessToken} from '../store/authStore';
import {onConnectionChange,subscribeToChannel} from './realtimeSocket';
import type {ActivityScope} from './activityHistory';

export function watchActivity(actor:string,scope:ActivityScope,refresh:()=>void){
 const token=getAccessToken(),channel=`activity.${actor}.${scope}`;
 if(!token||!['own','all'].includes(scope)||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(actor))return()=>{};
 let stopped=false,timer:ReturnType<typeof setTimeout>|undefined;
 const invalidate=()=>{if(stopped||getAccessToken()!==token||timer!==undefined)return;timer=setTimeout(()=>{timer=undefined;if(!stopped&&getAccessToken()===token)refresh();},100);};
 const connection=onConnectionChange(connected=>{if(connected)invalidate();});
 const unsubscribe=subscribeToChannel(channel,event=>{
  if(event.channel===channel&&event.type==='ActivityInvalidated'&&event.payload?.actor_uuid===actor&&event.payload?.scope===scope)invalidate();
 });
 return()=>{stopped=true;if(timer!==undefined)clearTimeout(timer);unsubscribe();connection();};
}
