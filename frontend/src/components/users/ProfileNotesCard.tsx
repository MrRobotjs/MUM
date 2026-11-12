import {useEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import {useAuth} from '../../contexts/AuthContext';
import {getAuthSnapshot,subscribeToAuthStore} from '../../store/authStore';
import {ProfileNotesEditor,validNotes} from '../../lib/profileNotes';
import {Card,CardHeader,CardTitle,CardDescription,CardContent} from '../ui/card';
import {Button} from '../ui/button';
import {Textarea} from '../ui/textarea';
import {Label} from '../ui/label';

export function ProfileNotesCard({target,refreshUser}:{target:string;refreshUser:()=>Promise<unknown>}){
  const {user,isAdministrator}=useAuth(),session=useSyncExternalStore(subscribeToAuthStore,getAuthSnapshot);
  const actor=isAdministrator&&session.accessToken?user?.uuid:undefined;
  const visible=useRef<ProfileNotesEditor|null>(null);
  const editor=useMemo(()=>{const value:ProfileNotesEditor=new ProfileNotesEditor(actor??'',target,()=>visible.current===value);return value;},[actor,target,session.accessToken]);
  visible.current=editor;
  const [,redraw]=useState(0),[notice,setNotice]=useState<{editor:ProfileNotesEditor;text:string}|null>(null);
  const update=()=>{if(editor.current())redraw(x=>x+1);};
  useEffect(()=>{
    visible.current=editor;
    if(actor&&!editor.busy)void editor.load().then(update).catch(error=>{if(editor.current()){setNotice({editor,text:String(error.message)});update();}});
    update();
    return()=>{if(visible.current===editor)visible.current=null;};
  },[editor,actor]);
  const read=async()=>{
    if(editor.busy||!editor.current())return;
    if((editor.needsRead||editor.base&&editor.draft!==editor.base.notes)&&!window.confirm('Read saved notes and replace this draft? No save will be retried.'))return;
    const pending=editor.load();update();
    try{await pending;if(editor.current())setNotice({editor,text:'Saved notes read. Make a new explicit edit if needed.'});}
    catch(error){if(editor.current())setNotice({editor,text:String(error instanceof Error?error.message:error)});}
    finally{update();}
  };
  const save=async()=>{
    if(editor.busy||!editor.current())return;
    const pending=editor.save();update();
    try{await pending;if(!editor.current())return;setNotice({editor,text:'Notes saved.'});
      try{await refreshUser();}catch{if(editor.current())setNotice({editor,text:'Notes saved. Reload the profile to refresh its display.'});}
    }catch(error){if(editor.current())setNotice({editor,text:String(error instanceof Error?error.message:error)});}
    finally{update();}
  };
  const bound=editor.current()&&!!editor.base;
  return <Card className="border-border shadow-sm"><CardHeader><CardTitle>Profile Settings</CardTitle><CardDescription>Profile notes can be edited here. Other settings are unavailable.</CardDescription></CardHeader><CardContent className="space-y-4">
    {notice?.editor===editor&&<p className="text-sm text-muted-foreground" role="status">{notice.text}</p>}
    {bound?<><Label htmlFor="profile-notes">Notes</Label><Textarea id="profile-notes" rows={4} value={editor.draft} disabled={editor.busy||editor.needsRead} onChange={event=>{if(editor.current()&&!editor.busy&&!editor.needsRead){editor.draft=event.target.value;update();}}} placeholder="e.g., Prefers 1080p remux, invited from Discord, local-only for now..."/><p className="text-xs text-muted-foreground">Keep track of context for this user (preferences, escalations, notes from other admins).</p></>:<p className="text-sm text-muted-foreground">{editor.busy?'Loading user settings…':'Current notes are unavailable.'}</p>}
    {bound&&!validNotes(editor.draft)&&<p className="text-sm text-destructive">Notes exceed the 16 KB limit or contain unsupported characters.</p>}
    <div className="flex justify-end gap-3"><Button variant="outline" disabled={editor.busy||!actor} onClick={()=>void read()}>Read saved notes</Button><Button disabled={!bound||editor.busy||editor.needsRead||!validNotes(editor.draft)||editor.draft===editor.base?.notes} onClick={()=>void save()}>{editor.busy&&bound?'Saving…':'Save Notes'}</Button></div>
  </CardContent></Card>;
}
