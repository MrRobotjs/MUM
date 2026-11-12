import {ApiError,requestJson} from '../util/apiClient';
import {getAccessToken} from '../store/authStore';
import {fetchPersonalProfile} from './plexConnection';
export type EmailChangeInput={email:string;current_password:string;acknowledge_unverified_contact:boolean};
export function normalizeContactEmail(value:string):string{
 const email=value.trim();if(!email)return '';
 const parts=email.split('@');
 if(new TextEncoder().encode(email).length>254 || !/^[\x21-\x7e]+$/.test(email) || /["\\<>]/.test(email) || parts.length!==2 || !parts[0] || parts[0].length>64 || !parts[1] || parts[1].split('.').some(label=>!label || label.length>63 || !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(label)))throw Error('Use a bare ASCII email address of at most 254 bytes, or leave it empty to clear it.');
 return parts[0]+'@'+parts[1].toLowerCase();
}
export function emailChangePayload(user:string,revision:number,input:EmailChangeInput){
 const bytes=new TextEncoder().encode(input.current_password).length;
 if(!/^[0-9a-f-]{36}$/.test(user) || !Number.isSafeInteger(revision) || revision<1 || bytes<12 || bytes>1024 || input.acknowledge_unverified_contact!==true)throw Error('Provide the current local password and acknowledge the unverified contact address.');
 return {expected_user_uuid:user,profile_revision:revision,email:normalizeContactEmail(input.email),current_password:input.current_password,acknowledge_unverified_contact:true};
}
export async function changeOwnEmail(user:string,revision:number,input:EmailChangeInput){
 const body=emailChangePayload(user,revision,input),token=getAccessToken();
 const profile=await fetchPersonalProfile();
 if(profile.uuid!==user || token!==getAccessToken() || !profile.email_change_available || !profile.has_password || profile.profile_revision!==revision)throw Error('Your account or profile changed. Refresh your profile before editing.');
 try{
  const {data}=await requestJson<{data:{user_uuid:string;email:string|null;profile_revision:number;email_verified:false}}>('/api/account/email',{method:'PATCH',body:JSON.stringify(body),retryAuthentication:false});
  if(token!==getAccessToken() || data?.user_uuid!==user || data.profile_revision!==revision+1 || data.email!==(body.email||null) || data.email_verified!==false)throw Error('Unconfirmed result');
  return data;
 }catch(e){
  if(e instanceof ApiError && e.status===403 && (e.payload as {error?:{code?:string}})?.error?.code==='CURRENT_PASSWORD_INVALID')throw Error('Current local password could not be verified.');
  if(e instanceof ApiError && e.status===400)throw Error('Check the contact address, password and acknowledgment.');
  throw Error('Email change could not be confirmed. Refresh the profile before another attempt. No request was replayed.');
 }
}
