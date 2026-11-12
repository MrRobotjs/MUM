import {getAccessToken} from '../../store/authStore'
import {changeAdminRoleMembership,membershipTargets,fetchAdminRoleCandidates,type CandidateSnapshot} from '../../lib/adminRoleMemberships'
import { useState, useEffect, useRef } from 'react'
import { AdminRole, useAdminRoleMembers, useAdminRoleCandidates } from '../../hooks/useAdminRoles'
import { useAlerts } from '../../contexts'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
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

interface AdminRoleMembersTabProps {
  role: AdminRole
  onUpdate: () => Promise<void>
}

export const AdminRoleMembersTab = ({ role, onUpdate }: AdminRoleMembersTabProps) => {
  const { success, error: showError } = useAlerts()
  const [searchQuery, setSearchQuery] = useState('')
  const [addModalOpen, setAddModalOpen] = useState(false)
  const [selectedUsers, setSelectedUsers] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)
  const isAutoManaged = role.is_auto_managed

  const {actor,snapshot: memberSnapshot,members, loading: membersLoading, error: membersError, refresh: refreshMembers} = useAdminRoleMembers(role.id)
  const candidateRead=useAdminRoleCandidates(role.id,addModalOpen && role.member_assignment_available)
  const [selectionSnapshot,setSelectionSnapshot]=useState<CandidateSnapshot|null>(null)
  const active=useRef(true),pending=useRef(false),currentActor=useRef(actor),currentRole=useRef(role)
  currentActor.current=actor;currentRole.current=role
  useEffect(()=>{active.current=true;return()=>{active.current=false}},[])
  useEffect(()=>{setAddModalOpen(false);setSelectionSnapshot(null);setSelectedUsers([])},[actor,role.id])
  useEffect(()=>{if(addModalOpen && !selectionSnapshot && candidateRead.snapshot)setSelectionSnapshot(candidateRead.snapshot)},[addModalOpen,selectionSnapshot,candidateRead.snapshot])
  const filteredMembers = members.filter(member => member.username.toLowerCase().includes(searchQuery.toLowerCase()))
  const availableUsers=(selectionSnapshot?.candidates??[]).map(user=>({...user,display_name:user.username}))
  const candidateStale=Boolean(selectionSnapshot && (selectionSnapshot.actor_uuid!==actor || selectionSnapshot.role_id!==role.id || selectionSnapshot.snapshot_revision!==role.snapshot_revision || candidateRead.snapshot && candidateRead.snapshot.snapshot_revision>selectionSnapshot.snapshot_revision))
  const candidateUnavailable=Boolean(candidateRead.error)||candidateStale||!selectionSnapshot
  const isOwner = (userType: string) => userType === 'owner'
  const refreshCandidates=async()=>{
    if(pending.current || !role.member_assignment_available)return
    const owner=actor,token=getAccessToken();pending.current=true;setSubmitting(true);setSelectedUsers([])
    try{const [snapshot]=await Promise.all([candidateRead.refresh(),onUpdate()]);if(active.current&&currentActor.current===owner&&currentRole.current.id===role.id&&token===getAccessToken())setSelectionSnapshot(snapshot??null)}
    catch{if(active.current&&currentActor.current===owner&&currentRole.current.id===role.id&&token===getAccessToken())showError('Could not read complete current candidates. Try refreshing again.')}
    finally{pending.current=false;if(active.current)setSubmitting(false)}
  }
  const handleOpenAddModal = async () => {
    if (!actor || !role.member_assignment_available || pending.current) return
    const owner=actor,token=getAccessToken();pending.current=true;setSubmitting(true);setSelectedUsers([])
    try{const [snapshot]=await Promise.all([fetchAdminRoleCandidates(actor,role.id),onUpdate()]);if(active.current&&currentActor.current===owner&&currentRole.current.id===role.id&&token===getAccessToken()&&currentRole.current.member_assignment_available){setSelectionSnapshot(snapshot);setAddModalOpen(true)}}
    catch{if(active.current&&currentActor.current===owner&&currentRole.current.id===role.id&&token===getAccessToken())showError('Could not read complete current candidates. Try refreshing again.')}
    finally{pending.current=false;if(active.current)setSubmitting(false)}
  }
  const handleAddMembers = async () => {
    if(!actor||!role.member_assignment_available||pending.current||candidateUnavailable||!selectionSnapshot)return
    const owner=actor,token=getAccessToken();pending.current=true;setSubmitting(true)
    try{
      const targets=membershipTargets(selectionSnapshot.candidates,selectedUsers,'assign')
      await changeAdminRoleMembership(selectionSnapshot,'assign',targets)
      if(!active.current||currentActor.current!==owner||currentRole.current.id!==role.id||token!==getAccessToken())return
      success(`Added ${targets.length} member(s) to role '${role.name}'`)
      setAddModalOpen(false);setSelectedUsers([]);setSelectionSnapshot(null)
      await Promise.all([refreshMembers(),onUpdate()])
    }catch(error){if(active.current&&currentActor.current===owner&&currentRole.current.id===role.id&&token===getAccessToken())showError((error as Error).message)}
    finally{pending.current=false;if(active.current)setSubmitting(false)}
  }
  const handleRemoveMember = async (memberUuid:string,username:string) => {
    if(!actor||!role.member_changes_available||pending.current||!memberSnapshot||membersError||memberSnapshot.snapshot_revision!==role.snapshot_revision)return
    if(!window.confirm(`Remove ${username} from this role? Their other role assignments will stay.`))return
    const owner=actor,token=getAccessToken();pending.current=true;setSubmitting(true)
    try{
      await changeAdminRoleMembership(memberSnapshot,'remove',membershipTargets(members,[memberUuid],'remove'))
      if(!active.current||currentActor.current!==owner||currentRole.current.id!==role.id||token!==getAccessToken())return
      success(`Removed ${username} from role '${role.name}'`)
      await Promise.all([refreshMembers(),onUpdate()])
    }catch(error){if(active.current&&currentActor.current===owner&&currentRole.current.id===role.id&&token===getAccessToken())showError((error as Error).message)}
    finally{pending.current=false;if(active.current)setSubmitting(false)}
  }
  const toggleUserSelection = (userUuid: string) => {
    if(submitting||candidateUnavailable)return
    setSelectedUsers(previous=>previous.includes(userUuid)?previous.filter(id=>id!==userUuid):previous.length<100?[...previous,userUuid]:previous)
  }

  return (
    <div className="space-y-6">
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
                Review explicit role assignments. Manage eligible local accounts within your current role hierarchy.
              </p>
            </div>
          </div>
          {!isAutoManaged && (
            <Button disabled={!role.member_assignment_available || submitting} onClick={handleOpenAddModal}>
              <FontAwesomeIcon icon={faUserPlus} className="mr-2 size-4" />
              Add Member
            </Button>
          )}
        </div>

        {/* Stats Card */}
        <Alert variant="info">
          <FontAwesomeIcon icon={faCircleInfo} />
          <AlertTitle>Current Members</AlertTitle>
          <AlertDescription>
            {membersError ? 'Membership unavailable' : membersLoading ? 'Loading membership…' : `${members.length} explicit assignment${members.length !== 1 ? 's' : ''} to this role`}
          </AlertDescription>
        </Alert>

        {isAutoManaged && (
          <Alert variant="info">
            <FontAwesomeIcon icon={faCircleInfo} />
            <AlertTitle>Auto-managed membership</AlertTitle>
            <AlertDescription>
              Assignments for this role are managed by the system. Membership changes are unavailable here.
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
              <CardDescription>Search and review assigned admins.</CardDescription>
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

          {membersError ? <Alert variant="destructive"><AlertDescription>Could not read the complete membership. Refresh before reviewing.</AlertDescription><Button variant="outline" onClick={() => void refreshMembers()}>Refresh Members</Button></Alert> : membersLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner className="size-4 text-muted-foreground" />
              Loading members...
            </div>
          ) : filteredMembers.length === 0 ? (
            <div className="py-12 text-center">
              <FontAwesomeIcon icon={faUsersSlash} className="mb-4 text-4xl text-muted-foreground/30" />
              <h4 className="mb-2 text-lg font-semibold">No Members</h4>
              <p className="mb-4 text-sm text-muted-foreground">
                {searchQuery
                  ? 'No members match your search.'
                  : "This role doesn't have any members assigned yet."}
              </p>
              {!searchQuery && !isAutoManaged && (
                <Button disabled={!role.member_assignment_available || submitting} size="sm" onClick={handleOpenAddModal}>
                  <FontAwesomeIcon icon={faUserPlus} className="mr-2 size-4" />
                  Add First Member
                </Button>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              {filteredMembers.map((member) => {
                const memberIsOwner = isOwner(member.user_type)

                return (
                  <div
                    key={member.uuid}
                    className="flex items-center justify-between rounded-lg border border-border bg-background p-4 transition-colors hover:bg-accent/50"
                  >
                    <div className="flex items-center gap-4">
                      <Avatar className="size-12">
                        <AvatarImage src="" alt={member.username} />
                        <AvatarFallback>
                          {(member.username || member.uuid).charAt(0).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <div>
                        <div className="font-semibold">{member.username || member.uuid}</div>
                        {memberIsOwner && <Badge className="mt-1">Owner</Badge>}
                        {!memberIsOwner && <Badge variant="secondary" className="mt-1">Assigned</Badge>}
                      </div>
                    </div>
                    {!memberIsOwner && !isAutoManaged && (
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive hover:bg-destructive/10"
                          disabled={!role.member_changes_available || !member.can_remove || submitting || membersLoading || Boolean(membersError) || memberSnapshot?.snapshot_revision!==role.snapshot_revision}
                          onClick={() => handleRemoveMember(member.uuid, member.username || member.uuid)}
                        >
                          <FontAwesomeIcon icon={faUserMinus} className="mr-1 size-4" />
                          Remove
                        </Button>
                      </div>
                    )}
                    {memberIsOwner && (
                      <span className="text-xs text-muted-foreground">Cannot remove owner</span>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Add Member Modal */}
      <ResponsiveDialog
        open={addModalOpen}
        onOpenChange={open=>{if(!submitting)setAddModalOpen(open)}}
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
          <Button key="refresh" variant="outline" onClick={()=>void refreshCandidates()} disabled={submitting}>Refresh Candidates</Button>,
          <Button key="add" onClick={handleAddMembers} disabled={submitting || candidateUnavailable || !selectedUsers.length}>
            {submitting ? 'Adding...' : `Add ${selectedUsers.length} User(s)`}
          </Button>,
        ]}
      >
        <div className="space-y-4">
          {candidateRead.loading && !selectionSnapshot ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner className="size-4 text-muted-foreground" />Loading eligible accounts…</div> : candidateRead.error || candidateStale || !role.member_assignment_available ? <Alert variant="destructive"><AlertDescription>Role or candidate accounts changed or could not be read completely. Refresh candidates before selecting users.</AlertDescription></Alert> : availableUsers.length === 0 ? (
            <Alert variant="info">
              <FontAwesomeIcon icon={faCircleInfo} />
              <AlertDescription>
                No eligible unassigned local accounts were found. New grants require an active account with local credentials and unexpired access.
              </AlertDescription>
            </Alert>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                Select up to 100 local accounts to receive this role's permissions. Other role assignments remain unchanged.
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
                        disabled={submitting || candidateUnavailable}
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
                          <div className="flex items-center gap-2">
                            <div className="font-medium">{user.display_name}</div>
                            <Badge variant="outline" className="text-xs">Eligible account</Badge>
                          </div>

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
