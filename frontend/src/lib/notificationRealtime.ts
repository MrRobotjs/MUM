import {getAccessToken} from '../store/authStore';
import {onConnectionChange,subscribeToChannel} from './realtimeSocket';

// Hints only trigger reads. They never change receipts, clear uncertain actions,
// carry notice contents or automatically retry a mutation.
export function watchNotificationInbox(actor:string,refresh:()=>void){
 const token=getAccessToken(),channel=`notifications.${actor}`;
 if(!token||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(actor))return()=>{};
 let stopped=false,timer:ReturnType<typeof setTimeout>|undefined;
 const invalidate=()=>{if(stopped||getAccessToken()!==token||timer!==undefined)return;timer=setTimeout(()=>{timer=undefined;if(!stopped&&getAccessToken()===token)refresh();},100);};
 const connection=onConnectionChange(connected=>{if(connected)invalidate();});
 const unsubscribe=subscribeToChannel(channel,event=>{
  if(event.channel===channel&&event.type==='NotificationInvalidated'&&event.payload?.actor_uuid===actor)invalidate();
 });
 return()=>{stopped=true;if(timer!==undefined)clearTimeout(timer);unsubscribe();connection();};
}
