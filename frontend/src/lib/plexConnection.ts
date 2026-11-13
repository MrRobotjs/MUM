import { ApiError, requestJson } from '../util/apiClient';

export type PersonalProfile = { uuid: string; username: string; email: string | null; user_type: string; has_password: boolean; force_password_change: boolean; last_login_at: string | null; plex_authorization_enabled: boolean; profile_changes_available: false; password_change_available: boolean; email_change_available: boolean; profile_revision: number; email_verified: false };
export type PlexConnection = { id: string; account_id: string; username: string; status: 'active'; verified_at?: string };
export type PlexChallenge = { id: string; status: 'pending' | 'verified'; expires_at: string; revision: number; authorization_url?: string; account?: {id: string; username: string} };
export type PlexConnectionState = { phase: 'loading' | 'ready' | 'pending' | 'verified' | 'connected' | 'expired' | 'uncertain' | 'error'; busy: boolean; enabled: boolean; connection: PlexConnection | null; challenge: PlexChallenge | null; error: string | null };
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const accountID = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value)<=9223372036854775807n;
export function plexAuthorizationURL(value: unknown): string {
 if (typeof value !== 'string') throw new Error('Invalid Plex authorization destination');
 const url = new URL(value);
 if (url.origin !== 'https://app.plex.tv' || url.pathname !== '/auth' || url.search || url.username || url.password || !url.hash.startsWith('#?')) throw new Error('Invalid Plex authorization destination');
 const params = new URLSearchParams(url.hash.slice(2));
 const keys = [...params.keys()].sort();
 if (keys.join(',') !== ['clientID','code','context[device][product]'].sort().join(',') || !uuid(params.get('clientID')) || !/^[a-zA-Z0-9_-]{16,128}$/.test(params.get('code') ?? '') || params.get('context[device][product]') !== 'MUM') throw new Error('Invalid Plex authorization destination');
 return url.href;
}
export async function fetchPersonalProfile(): Promise<PersonalProfile> {
 const {data:p} = await requestJson<{data:PersonalProfile}>('/api/account/profile');
 if (!p || !uuid(p.uuid) || typeof p.username !== 'string' || !['owner','local'].includes(p.user_type) || typeof p.plex_authorization_enabled !== 'boolean' || p.profile_changes_available !== false || typeof p.password_change_available !== 'boolean' || typeof p.email_change_available !== 'boolean' || !Number.isSafeInteger(p.profile_revision) || p.profile_revision<1 || p.email_verified!==false || typeof p.has_password !== 'boolean' || typeof p.force_password_change !== 'boolean' || p.email !== null && typeof p.email !== 'string' || p.last_login_at !== null && typeof p.last_login_at !== 'string') throw new Error('Invalid personal profile');
 return p;
}
function connection(value: unknown): PlexConnection | null {
 if (value === null) return null;
 const c = value as PlexConnection;
 if (!c || !uuid(c.id) || !accountID(c.account_id) || typeof c.username !== 'string' || !c.username || c.status !== 'active') throw new Error('Invalid Plex connection');
 return {id:c.id,account_id:c.account_id,username:c.username,status:'active',verified_at:c.verified_at};
}
function challenge(value: unknown, expected?: string): PlexChallenge {
 const c = value as PlexChallenge;
 if (!c || !uuid(c.id) || expected !== undefined && c.id !== expected || !['pending','verified'].includes(c.status) || !Number.isSafeInteger(c.revision) || c.revision < 1 || typeof c.expires_at!=='string' || !Number.isFinite(Date.parse(c.expires_at))) throw new Error('Invalid Plex authorization');
 const result: PlexChallenge = {id:c.id,status:c.status,expires_at:c.expires_at,revision:c.revision};
 if (c.authorization_url !== undefined) result.authorization_url = plexAuthorizationURL(c.authorization_url);
 if (c.status === 'verified') {
  if (!c.account || !accountID(c.account.id) || typeof c.account.username !== 'string' || !c.account.username) throw new Error('Invalid Plex account preview');
  result.account = {id:c.account.id,username:c.account.username};
 }
 return result;
}

// Memory-only state, explicit network actions and no mutation replay. Disposal
// invalidates late results after logout, account changes or navigation.
export class PlexConnectionController {
 state: PlexConnectionState = {phase:'loading',busy:false,enabled:false,connection:null,challenge:null,error:null};
 private generation = 0;
 private disposed = false;
 private pollAfter = 0;
 constructor(private owner: string, private changed: (state:PlexConnectionState)=>void, private now = () => Date.now()) {}
 private publish(next: Partial<PlexConnectionState>) { if (!this.disposed) {this.state = {...this.state,...next}; this.changed(this.state);} }
 dispose() {this.disposed = true;this.generation++;this.state = {...this.state,challenge:null,connection:null};}
 private valid(run:number) {return !this.disposed && run === this.generation;}
 private async currentOwner() {
  const profile = await fetchPersonalProfile();
  if (profile.uuid !== this.owner) throw new Error('The signed-in account changed. Reopen your account page.');
  return profile;
 }
 expire() {
  if (this.state.challenge && Date.parse(this.state.challenge.expires_at) <= this.now()) this.publish({phase:'expired',challenge:null,error:'Plex authorization expired. Start a new connection.'});
 }
 async reload() {
  if (this.disposed || this.state.busy) return;
  const run = ++this.generation;this.publish({busy:true,error:null});
  try {
   const [profile,response] = await Promise.all([this.currentOwner(),requestJson<{data:unknown}>('/api/plex/connection')]);
   const c = connection(response.data);
   if (this.valid(run)) this.publish({phase:c?'connected':'ready',enabled:profile.plex_authorization_enabled,connection:c,challenge:null});
  } catch {if(this.valid(run))this.publish({phase:'error',enabled:false,connection:null,challenge:null,error:'Could not load the current Plex connection. Check your session and try again.'});}
  finally {if(this.valid(run))this.publish({busy:false});}
 }
 private async action(kind:'start'|'poll'|'confirm'|'disconnect') {
  if (this.disposed || this.state.busy) return;
  this.expire();
  const current = this.state;
  if (kind==='start' && (!current.enabled || current.connection || !['ready','expired','error'].includes(current.phase))) return;
  if (kind==='poll' && (current.phase!=='pending' || !current.challenge || this.now()<this.pollAfter)) return;
  if (kind==='confirm' && (current.phase!=='verified' || !current.challenge?.account)) return;
  if (kind==='disconnect' && (current.phase!=='connected' || !current.connection)) return;
  const run = ++this.generation;this.publish({busy:true,error:null});
  let sent = false;
  try {
   const profile = await this.currentOwner();if (!this.valid(run)) return;
   this.publish({enabled:profile.plex_authorization_enabled});
   if (kind!=='disconnect' && !profile.plex_authorization_enabled) throw new Error('Plex connections are disabled by an administrator.');
   let path = '/api/plex/authorizations';let body:object = {};
   if (kind==='poll') {path += `/${current.challenge!.id}/poll`;this.pollAfter = this.now()+2000;}
   if (kind==='confirm') {path += `/${current.challenge!.id}/confirm`;body = {expected_account_id:current.challenge!.account!.id};}
   if (kind==='disconnect') path = `/api/plex/connections/${current.connection!.id}/revoke`;
   sent = true;
   const response = await requestJson<{data:unknown}>(path,{method:'POST',body:JSON.stringify(body)});
   if (!this.valid(run)) return;
   if (kind==='start' || kind==='poll') {
    const c = challenge(response.data,kind==='poll'?current.challenge!.id:undefined);
    if (kind==='start' && (c.status!=='pending' || !c.authorization_url || Date.parse(c.expires_at)>this.now()+905000)) throw new Error('Invalid initial authorization');
    if (kind==='poll' && (c.revision<current.challenge!.revision || Date.parse(c.expires_at)>Date.parse(current.challenge!.expires_at))) throw new Error('Authorization changed unexpectedly');
    if (c.status==='pending' && kind==='poll') c.authorization_url = current.challenge!.authorization_url;
    if (c.status==='verified') delete c.authorization_url;
    this.publish({phase:c.status,challenge:c});this.expire();
   } else if (kind==='confirm') {
    const c = connection(response.data);
    if (!c || c.account_id!==current.challenge!.account!.id) throw new Error('Unexpected confirmed account');
    this.publish({phase:'connected',connection:c,challenge:null});
   } else {
    const result = response.data as {id:string;status:string;scope:string};
    if (result?.id!==current.connection!.id || result.status!=='revoked' || result.scope!=='local_connection') throw new Error('Unexpected disconnect result');
    this.publish({phase:'ready',connection:null,challenge:null});
   }
  } catch(error) {
   if (!this.valid(run)) return;
   const known = error instanceof ApiError && error.status>=400 && error.status<500 && error.status!==409;
   if (sent && !known) this.publish({phase:'uncertain',challenge:null,error:'The result is uncertain. Check the current connection before starting another action.'});
   else this.publish({error:sent?'The request was rejected. Check approval, your session and provider availability before trying again.':'Could not verify your account or provider availability. Refresh connection status.'});
  } finally {if(this.valid(run))this.publish({busy:false});}
 }
 /**
  * One click, as in Flask: start, open the Plex page (open), check every 2
  * seconds until Plex approves, then link the approved account. It stops if
  * the Plex window is closed first (closed), on any refusal, or when disposed.
  */
 async connect(open:(url:string)=>void, closed:()=>boolean, wait:(ms:number)=>Promise<void> = ms => new Promise(resolve => setTimeout(resolve,ms))) {
  const run = ++this.connecting;
  const current = () => run===this.connecting && !this.disposed;
  // Read each time: the phase changes across the awaits below.
  const phase = () => this.state.phase;
  await this.start();
  if (!current() || phase()!=='pending' || !this.state.challenge?.authorization_url) return;
  open(this.state.challenge.authorization_url);
  while (current() && phase()==='pending') {
   await wait(2100);
   if (!current()) return;
   this.expire();
   if (phase()!=='pending') break;
   await this.poll();
   if (current() && phase()==='pending' && closed()) {
    this.publish({phase:'expired',challenge:null,error:'The Plex window was closed before you approved. Connect again to retry.'});
    return;
   }
  }
  if (current() && phase()==='verified') await this.confirm();
 }
 private connecting = 0;
 start(){return this.action('start');}
 poll(){return this.action('poll');}
 confirm(){return this.action('confirm');}
 disconnect(){return this.action('disconnect');}
}
