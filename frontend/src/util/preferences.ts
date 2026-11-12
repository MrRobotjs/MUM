export const PREFERENCE_EVENT='mum:preference-change';
export type PreferenceChangeDetail={user_uuid:string;key:'stream_counter';value:boolean};
type PreferenceStorage=Pick<Storage,'getItem'|'setItem'>;
export function localPreferenceKey(user:string){if(!/^[0-9a-f-]{36}$/.test(user))throw Error('Invalid preference owner');return `mum.preferences.${user}.stream_counter`;}
function deviceStorage():PreferenceStorage|undefined{try{return window.localStorage;}catch{return undefined;}}
export function readLocalCounter(user:string,storage=deviceStorage()):boolean{try{return storage?.getItem(localPreferenceKey(user))==='true';}catch{return false;}}
export function writeLocalCounter(user:string,value:boolean,storage=deviceStorage()){
 if(typeof value!=='boolean' || !storage)throw Error('Device preference storage is unavailable.');
 try{storage.setItem(localPreferenceKey(user),JSON.stringify(value));}catch{throw Error('Device preference storage could not save the setting.');}
}
export function emitPreferenceChange(user:string,value:boolean){if(typeof window!=='undefined')window.dispatchEvent(new CustomEvent<PreferenceChangeDetail>(PREFERENCE_EVENT,{detail:{user_uuid:user,key:'stream_counter',value}}));}
