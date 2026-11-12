import {requestJson} from '../util/apiClient';
import {getAccessToken} from '../store/authStore';
import {SERVICE_IDS} from '../config/serviceTypes';

export type ProviderFeatures = Record<string, {capabilities:string[]; features:string[]; supports_library_scoped_grants:boolean}>;
const known = new Set(SERVICE_IDS);
export async function fetchProviderFeatures():Promise<ProviderFeatures>{
 const token=getAccessToken();if(!token)throw Error('Administrator access is required.');
 const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),15000);
 try{
  const {data}=await requestJson<{data:unknown}>('/api/providers',{signal:abort.signal,retryAuthentication:false});
  if(token!==getAccessToken()||!Array.isArray(data)||data.length>SERVICE_IDS.length)throw Error('Provider metadata is unavailable. Refresh.');
  const result:ProviderFeatures={};
  for(const p of data){
   if(!p||!known.has(p.id)||Object.prototype.hasOwnProperty.call(result,p.id)||typeof p.enabled!=='boolean'||!Array.isArray(p.capabilities)||p.capabilities.length>64||p.capabilities.some((v:unknown)=>typeof v!=='string'||!/^[a-z][a-z0-9_.]{0,127}$/.test(v))||new Set(p.capabilities).size!==p.capabilities.length)throw Error('Invalid provider metadata.');
   // Provisioning grants and read/sync are not existing-user Edit grant changes.
   // The Go runtime has no session-message or legacy library-edit endpoint.
   result[p.id]={capabilities:p.enabled?[...p.capabilities]:[],features:[],supports_library_scoped_grants:p.enabled && p.capabilities.includes('users.libraries.update')};
  }
  return result;
 }finally{clearTimeout(timer);}
}
