import {useEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react'
import { UserRole } from '../../hooks/useUserRoles'
import { useAlerts } from '../../contexts'
import {UserRoleMembersController} from '../../lib/userRoleMembers'
import {useAuth} from '../../contexts/AuthContext'
import {getAuthSnapshot,subscribeToAuthStore} from '../../store/authStore'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { ResponsiveDialog } from '@/components/ui/responsive-dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { Spinner } from '@/components/ui/spinner'
import {
  faCircleInfo,
  faMagnifyingGlass,
  faUserMinus,
  faUserPlus,
  faUsers,
  faUsersSlash
} from '@fortawesome/free-solid-svg-icons'

type UserRoleMembersTabProps={role:UserRole;onUpdate:()=>Promise<void>}
export const UserRoleMembersTab=({role,onUpdate}:UserRoleMembersTabProps)=>{
 const {user,isOwner}=useAuth(),session=useSyncExternalStore(subscribeToAuthStore,getAuthSnapshot),actor=isOwner&&session.accessToken?user?.uuid:undefined;
 const {success,error:showError}=useAlerts(),visible=useRef<UserRoleMembersController|null>(null);
 const controller=useMemo(()=>{const value:UserRoleMembersController=new UserRoleMembersController(actor??'',role.id,()=>visible.current===value);return value;},[actor,role.id,session.accessToken]);visible.current=controller;
 const [,redraw]=useState(0),[searchQuery,setSearchQuery]=useState(''),[addModalOpen,setAddModalOpen]=useState(false),[selectedUsers,setSelectedUsers]=useState<string[]>([]),[notice,setNotice]=useState<{controller:UserRoleMembersController;text:string}|null>(null);
 const update=()=>{if(controller.current())redraw(x=>x+1)};
 useEffect(()=>{visible.current=controller;if(actor&&!controller.busy)void controller.load().then(update).catch(error=>{if(controller.current()){setNotice({controller,text:String(error.message)});update();}});update();return()=>{if(visible.current===controller)visible.current=null}},[actor,controller]);
 const read=async()=>{if(controller.busy||!controller.current())return;setAddModalOpen(false);setSelectedUsers([]);const pending=controller.load();update();try{await pending;if(controller.current())setNotice({controller,text:'Saved members read. No change was retried.'})}catch(error){if(controller.current())setNotice({controller,text:String(error instanceof Error?error.message:error)})}finally{update()}};
 const page=controller.current()?controller.base:null,submitting=controller.busy,membersLoading=controller.busy&&!page;
 const allUsers=page?.items.map(row=>({...row,username:row.username||row.uuid,display_name:row.username||row.uuid,detail:[row.user_type,row.service_type,row.server_nickname,row.uuid].filter(Boolean).join(' · ')}))??[];
 const members=allUsers.filter(row=>row.is_member),filteredMembers=members.filter(row=>row.username.toLowerCase().includes(searchQuery.toLowerCase())||row.uuid.includes(searchQuery.toLowerCase()));
 const availableUsers=allUsers.filter(row=>!row.is_member&&row.can_change),hasEligibleUsers=allUsers.some(row=>row.can_change),isAutoManagedRole=page?.is_auto_managed??role.is_auto_managed;
 const canAdd=!!page?.mutations_available&&availableUsers.length>0&&!controller.busy&&!controller.needsRead;
 const write=async(operation:'add'|'remove',ids:string[])=>{
  if(controller.busy||!controller.current())return;
  const pending=controller.change(operation,ids,(p,chosen)=>window.confirm(`${operation==='add'?'Add':'Remove'} ${chosen.map(row=>`${row.username||'Account'} (${row.user_type}, ${row.uuid})`).join(', ')} ${operation==='add'?'to':'from'} visual role “${p.role_name}”? Other labels, account links, administrator permissions and media policies are unchanged.`));update();
  try{const result=await pending;if(!result||!controller.current())return;setAddModalOpen(false);setSelectedUsers([]);success('Role membership saved');try{await onUpdate()}catch{if(controller.current())showError('Role membership saved. Read saved members to refresh its display.')}}
  catch(error){if(controller.current()){setAddModalOpen(false);setNotice({controller,text:String(error instanceof Error?error.message:error)})}}finally{update()}
 };
 const handleAddMembers=()=>write('add',[...selectedUsers]);
 const handleRemoveMember=(id:string,_username:string)=>write('remove',[id]);
 const toggleUserSelection=(id:string)=>setSelectedUsers(previous=>previous.includes(id)?previous.filter(value=>value!==id):previous.length<100?[...previous,id]:previous);
 const handleOpenAddModal=()=>{if(!canAdd)return;setSelectedUsers([]);setAddModalOpen(true)};
  return (
    <div className="space-y-6">
      {!actor&&<Alert variant="info"><AlertTitle>Owner access required</AlertTitle><AlertDescription>Role-member browsing and service-label changes are available to the owner. Delegated administrators can manage lower human accounts from their profiles.</AlertDescription></Alert>}
      {notice?.controller===controller&&<Alert variant="info"><AlertDescription>{notice.text}</AlertDescription></Alert>}
      <Button variant="outline" disabled={!actor||controller.busy} onClick={()=>void read()}>Read saved members</Button>
      {/* Members Overview Section */}
      <div className="space-y-4 rounded-lg border border-border bg-card p-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/20">
              <FontAwesomeIcon icon={faUsers} className="size-5 text-primary" />
            </div>
            <div>
              <h2 className="mb-1 text-xl font-semibold">Role Members</h2>
              <p className="text-sm text-muted-foreground">
                Manage users assigned to this role
              </p>
            </div>
          </div>
          {!!page?.mutations_available && (
            <Button disabled={!canAdd} onClick={handleOpenAddModal}>
              <FontAwesomeIcon icon={faUserPlus} className="mr-2 size-4" />
              Add User
            </Button>
          )}
        </div>

        {/* Stats Card */}
        <Alert variant="info">
          <FontAwesomeIcon icon={faCircleInfo} />
          <AlertTitle>Current Members</AlertTitle>
          <AlertDescription>
            {page?members.length:'Unknown'} user{members.length !== 1 ? 's' : ''} assigned to this role
          </AlertDescription>
        </Alert>
        {isAutoManagedRole && (
          <Alert variant="info">
            <FontAwesomeIcon icon={faCircleInfo} />
            <AlertTitle>Auto-managed role</AlertTitle>
            <AlertDescription>
              Automatic role membership cannot be edited here.
            </AlertDescription>
          </Alert>
        )}
      </div>

      {/* Members List Section */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/20">
              <FontAwesomeIcon icon={faUsers} className="size-5 text-primary" />
            </div>
            <div>
              <CardTitle className="mb-1 text-xl font-semibold">Member List</CardTitle>
              <CardDescription>Search and review assigned members.</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <Label className="text-sm font-medium">Search Members</Label>
            <div className="relative">
              <FontAwesomeIcon icon={faMagnifyingGlass} className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="text"
                placeholder="Search current members..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="h-11 pl-10"
              />
            </div>
          </div>

          {membersLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner className="size-4 text-muted-foreground" />
              Loading members...
            </div>
          ) : !page ? <p className="text-sm text-muted-foreground">Saved members are unavailable. Read saved members before selecting accounts.</p> : filteredMembers.length === 0 ? (
            <div className="py-12 text-center">
              <FontAwesomeIcon icon={faUsersSlash} className="mb-4 text-4xl text-muted-foreground/30" />
              <h4 className="mb-2 text-lg font-semibold">No Members</h4>
              <p className="mb-4 text-sm text-muted-foreground">
                {searchQuery
                  ? 'No members match your search.'
                  : "This role doesn't have any members assigned yet."}
              </p>
              {!searchQuery && page.mutations_available && (
                <Button size="sm" disabled={!canAdd} onClick={handleOpenAddModal}>
                  <FontAwesomeIcon icon={faUserPlus} className="mr-2 size-4" />
                  Add First Member
                </Button>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              {filteredMembers.map((member) => (
                <div
                  key={member.uuid}
                  className="flex items-center justify-between rounded-lg border border-border bg-background p-4 transition-colors hover:bg-accent/50"
                >
                  <div className="flex items-center gap-4">
                    <Avatar className="size-12">
                      <AvatarImage src="" alt={member.username} />
                      <AvatarFallback>
                        {member.username.charAt(0).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <div>
                      <div className="font-semibold">{member.username}</div>
                      {member.detail && (
                        <div className="text-sm text-muted-foreground">{member.detail}</div>
                      )}
                    </div>
                  </div>
                  {member.can_change && !!page?.mutations_available && (
                    <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:bg-destructive/10"
                      disabled={controller.busy||controller.needsRead}
                      onClick={() => void handleRemoveMember(member.uuid, member.username)}
                    >
                      <FontAwesomeIcon icon={faUserMinus} className="mr-1 size-4" />
                      Remove
                    </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Add Member Modal */}
      <ResponsiveDialog
        open={addModalOpen}
        onOpenChange={setAddModalOpen}
        title="Add Users to Role"
        footer={[
          <Button
            key="cancel"
            variant="outline"
            onClick={() => setAddModalOpen(false)}
            disabled={submitting}
          >
            Cancel
          </Button>,
          <Button key="add" onClick={()=>void handleAddMembers()} disabled={submitting||controller.needsRead||!page||selectedUsers.length===0}>
            {submitting ? 'Adding...' : `Add ${selectedUsers.length} User(s)`}
          </Button>,
        ]}
      >
        <div className="space-y-4">
          {availableUsers.length === 0 ? (
            <Alert variant="info">
              <FontAwesomeIcon icon={faCircleInfo} />
              <AlertDescription>
                {hasEligibleUsers
                  ? 'All eligible users are already members of this role.'
                  : 'No editable candidates are available. Protected accounts and pending work cannot be changed here.'}
              </AlertDescription>
            </Alert>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                Select up to 100 identities from this complete saved selection. Visual labels do not grant permissions.
              </p>

              <div className="max-h-96 space-y-2 overflow-y-auto">
                {availableUsers.map((user) => {
                  const checkboxId = `user-${user.uuid}`
                  const isSelected = selectedUsers.includes(user.uuid)

                  return (
                    <div
                      key={user.uuid}
                      className="flex items-center gap-3 rounded-lg border border-border p-3 hover:bg-accent/50"
                    >
                      <Checkbox
                        id={checkboxId}
                        checked={isSelected}
                        disabled={controller.busy||controller.needsRead||selectedUsers.length>=100&&!isSelected}
                        onCheckedChange={() => toggleUserSelection(user.uuid)}
                      />
                      <Label htmlFor={checkboxId} className="flex flex-1 cursor-pointer items-center gap-3">
                        <Avatar className="size-10">
                          <AvatarImage src="" alt={user.display_name} />
                          <AvatarFallback>
                            {user.display_name.charAt(0).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                        <div className="flex-1">
                          <div className="font-medium">{user.display_name}</div>
                          {user.detail && (
                            <div className="text-xs text-muted-foreground">{user.detail}</div>
                          )}
                        </div>
                      </Label>
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </div>
      </ResponsiveDialog>
    </div>
  )
}
