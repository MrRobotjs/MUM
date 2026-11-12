import {ApiError,requestJson} from '../util/apiClient';
import {getAccessToken,clearAccessToken} from '../store/authStore';
import {fetchPersonalProfile} from './plexConnection';
export type PasswordChangeInput={current_password:string;new_password:string;confirm_password:string;acknowledge_revoke_sessions:boolean};
export function passwordChangePayload(user:string,input:PasswordChangeInput){
 const bytes=(value:string)=>new TextEncoder().encode(value).length;
 if(!/^[0-9a-f-]{36}$/.test(user) || bytes(input.current_password)<12 || bytes(input.current_password)>1024 || bytes(input.new_password)<12 || bytes(input.new_password)>1024 || input.new_password!==input.confirm_password || input.new_password===input.current_password || input.acknowledge_revoke_sessions!==true)throw Error('Enter matching different passwords of 12–1024 bytes and acknowledge signing out all sessions.');
 return {expected_user_uuid:user,...input};
}
export async function changeOwnPassword(user:string,input:PasswordChangeInput){
 const body=passwordChangePayload(user,input),token=getAccessToken();
 const profile=await fetchPersonalProfile();
 if(profile.uuid!==user || token!==getAccessToken() || !profile.password_change_available || !profile.has_password)throw Error('Your account or session changed. Reopen your profile.');
 try{
  const {data}=await requestJson<{data:{user_uuid:string;password_changed:boolean;sessions_revoked:boolean;reauthentication_required:boolean}}>('/api/account/password',{method:'POST',body:JSON.stringify(body),retryAuthentication:false});
  if(token!==getAccessToken())throw Error('Session changed');
  clearAccessToken();
  if(data?.user_uuid!==user || data.password_changed!==true || data.sessions_revoked!==true || data.reauthentication_required!==true)throw Error('Unconfirmed result');
 }catch(error){
  const known=error instanceof ApiError && (error.status===400 || error.status===403 && (error.payload as {error?:{code?:string}})?.error?.code==='CURRENT_PASSWORD_INVALID');
  if(known)throw Error(error instanceof ApiError && error.status===403?'Current local password could not be verified.':'Check the password lengths, confirmation and sign-out acknowledgment.');
  if(token===getAccessToken())clearAccessToken();
  throw Error('Password change could not be confirmed. Sign in again, trying the new password first. No request was replayed.');
 }
}
