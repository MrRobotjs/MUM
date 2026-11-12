import {useEffect,useMemo,useRef,useState} from 'react';
import {advanceLiveStreams,playbackBaseline,type LiveStreamsData,type PlaybackBaseline} from '../lib/liveStreams';

// Advances playing sessions once a second between updates, like the Flask page.
// requestAnimationFrame avoids background-tab timer clamping; it commits only
// when the wall-clock second changes.
export function usePlaybackClock(data:LiveStreamsData|undefined):LiveStreamsData|undefined{
 const previous=useRef<PlaybackBaseline|undefined>(undefined);
 const baseline=useMemo(()=>{if(!data)return undefined;const next=playbackBaseline(data,previous.current);previous.current=next;return next;},[data]);
 const [now,setNow]=useState(()=>Date.now());
 const ticking=Boolean(data?.sessions.some(s=>s.state==='playing'));
 useEffect(()=>{
  if(!ticking)return;
  let frame=0,second=-1;
  const loop=()=>{const current=Date.now(),s=Math.floor(current/1000);if(s!==second){second=s;setNow(current);}frame=window.requestAnimationFrame(loop);};
  frame=window.requestAnimationFrame(loop);
  return()=>window.cancelAnimationFrame(frame);
 },[ticking]);
 return useMemo(()=>data&&baseline?advanceLiveStreams(data,baseline,now):data,[data,baseline,now]);
}
