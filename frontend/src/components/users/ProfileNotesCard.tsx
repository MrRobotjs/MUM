import {useEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import {useAuth} from '../../contexts/AuthContext';
import {getAuthSnapshot,subscribeToAuthStore} from '../../store/authStore';
import {ProfileNotesEditor,validNotes} from '../../lib/profileNotes';
import {Card,CardContent} from '../ui/card';
import {ConfirmAction,SettingHeader,SettingNotice,type Notice} from './AccountSettings';
import {Button} from '../ui/button';
import {Textarea} from '../ui/textarea';
import {Label} from '../ui/label';

export function ProfileNotesCard({target,refreshUser}:{target:string;refreshUser:()=>Promise<unknown>}){
  const {user,isAdministrator}=useAuth(),session=useSyncExternalStore(subscribeToAuthStore,getAuthSnapshot);
  const actor=isAdministrator&&session.accessToken?user?.uuid:undefined;
  const visible=useRef<ProfileNotesEditor|null>(null);
  const editor=useMemo(()=>{const value:ProfileNotesEditor=new ProfileNotesEditor(actor??'',target,()=>visible.current===value);return value;},[actor,target,session.accessToken]);
  visible.current=editor;
  const [,redraw]=useState(0),[notice,setNotice]=useState<{editor:ProfileNotesEditor;value:Notice}|null>(null),[replacing,setReplacing]=useState(false);
  const update=()=>{if(editor.current())redraw(x=>x+1);};
  const say=(value:Notice)=>{if(editor.current())setNotice({editor,value});};
  useEffect(()=>{
    visible.current=editor;
    if(actor&&!editor.busy)void editor.load().then(update).catch(error=>{if(editor.current()){say({text:String(error.message),error:true});update();}});
    update();
    return()=>{if(visible.current===editor)visible.current=null;};
  },[editor,actor]);
  // Reading again replaces an unsaved draft, so that asks first.
  const read=()=>{if(editor.busy||!editor.current())return;if(editor.needsRead||editor.base&&editor.draft!==editor.base.notes)setReplacing(true);else void load();};
  const load=async()=>{
    setReplacing(false);if(editor.busy||!editor.current())return;
    const pending=editor.load();update();
    try{await pending;say(null);}
    catch(error){say({text:String(error instanceof Error?error.message:error),error:true});}
    finally{update();}
  };
  const save=async(event:React.FormEvent)=>{
    event.preventDefault();if(editor.busy||!editor.current())return;
    const pending=editor.save();update();
    try{await pending;if(!editor.current())return;say({text:'Notes saved.'});
      try{await refreshUser();}catch{say({text:'Notes saved. Reload the profile to refresh its display.'});}
    }catch(error){say({text:String(error instanceof Error?error.message:error),error:true});}
    finally{update();}
  };
  const bound=editor.current()&&!!editor.base;
  return <Card>
    <SettingHeader title="Notes" summary={bound?'':editor.busy?'Loading…':'Unavailable'} info={<>
      <p>Keep track of context for this user: preferences, escalations and notes from other admins.</p>
      <p>Notes can hold up to 16 KB of text.</p>
    </>}/>
    <CardContent>
      {bound&&<form className="space-y-4" onSubmit={event=>void save(event)}>
        <div className="space-y-2"><Label htmlFor="profile-notes" className="sr-only">Notes</Label><Textarea id="profile-notes" rows={4} value={editor.draft} disabled={editor.busy||editor.needsRead} onChange={event=>{if(editor.current()&&!editor.busy&&!editor.needsRead){editor.draft=event.target.value;update();}}} placeholder="e.g., Prefers 1080p remux, invited from Discord, local-only for now..."/></div>
        {!validNotes(editor.draft)&&<p className="text-sm text-destructive">Notes exceed the 16 KB limit or contain unsupported characters.</p>}
        <Button type="submit" disabled={editor.busy||editor.needsRead||!validNotes(editor.draft)||editor.draft===editor.base?.notes}>{editor.busy?'Saving…':'Save notes'}</Button>
      </form>}
      <SettingNotice notice={notice?.editor===editor?notice.value:editor.needsRead?{text:'Read the saved notes before editing again.',error:true}:null} busy={editor.busy||!actor} onRetry={read}/>
    </CardContent>
    <ConfirmAction open={replacing} onOpenChange={setReplacing} title="Replace your draft?" confirmLabel="Read saved notes" busy={editor.busy} onConfirm={()=>void load()}>
      Reading the saved notes replaces the text you have not saved.
    </ConfirmAction>
  </Card>;
}
