import {displayCalendarDayDifference,formatDisplayTimestamp,type DisplayValues} from './accountDisplay';
/** Display the date only when the next run falls on a different day in the viewer's timezone. */
export function formatNextRunTime(value:string|null,now:string,settings:DisplayValues|undefined,locale?:string):string {
 if (!value) return '—';
 const days=displayCalendarDayDifference(value,now,settings);
 if (days===null) return '—';
 return formatDisplayTimestamp(value,settings,days===0?'time':'datetime','—',locale);
}
