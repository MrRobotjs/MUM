import {displayCalendarDayDifference,formatDisplayTimestamp,type DisplayValues} from './accountDisplay';
/** Display the date only when the next run falls on a different day in the viewer's timezone. */
export function formatNextRunTime(value:string|null,now:string,settings:DisplayValues|undefined,locale?:string):string {
 if (!value) return '—';
 const days=displayCalendarDayDifference(value,now,settings);
 if (days===null) return '—';
 return formatDisplayTimestamp(value,settings,days===0?'time':'datetime','—',locale);
}

/** Format a whole number of seconds using compact, readable duration units. */
export function formatTaskInterval(value:unknown):string {
 if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return '—';
 if (value === 0) return '0s';
 let remaining=value;
 const parts:string[]=[];
 for (const [size,label] of [[86400,'d'],[3600,'hr'],[60,'m'],[1,'s']] as const) {
  const count=Math.floor(remaining/size);
  if (count) parts.push(`${count}${label}`);
  remaining%=size;
 }
 return parts.join(' ');
}
