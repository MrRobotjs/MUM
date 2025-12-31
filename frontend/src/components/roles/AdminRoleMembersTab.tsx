import { useState, useEffect } from 'react'
import { IconUsers, IconUserPlus, IconUserMinus, IconSearch, IconSave, IconInfoCircle } from '@tabler/icons-react'
import useSWR from 'swr'
import { AdminRole } from '../../hooks/useAdminRoles'
import { useAlerts } from '../../contexts'
import { requestJson } from '../../util/apiClient'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { ResponsiveDialog } from '@/components/ui/responsive-dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'

interface AdminRoleMembersTabProps {
  role: AdminRole
  onUpdate: () => Promise<void>
}

interface RoleMember {
  uuid: string
  username: string
  user_type: string
  email: string
  is_active: boolean
}

interface Admin {
  id: number
  uuid: string
  username: string
  display_name: string
  user_type: string
  admin_roles: Array<{
    id: string
    name: string
  }>
}

interface LocalUser {
  id: number
  uuid: string
  username: string
  display_name: string
  email: string | null
  user_type: string
  admin_roles: string[]
}

export const AdminRoleMembersTab = ({ role, onUpdate }: AdminRoleMembersTabProps) => {
  const { success, error: showError } = useAlerts()
  const [searchQuery, setSearchQuery] = useState('')
  const [addModalOpen, setAddModalOpen] = useState(false)
  const [selectedUsers, setSelectedUsers] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)
  const isAutoManaged = role.is_auto_managed

  // Fetch role members
  const {
    data: membersData,
    mutate: refreshMembers,
    isLoading: membersLoading,
  } = useSWR<{ data: RoleMember[] }>(`/admin/api/v2/admin-roles/${role.id}/users`, requestJson)

  // Fetch all admins (for existing members)
  const { data: adminsData } = useSWR<{ data: Admin[] }>('/admin/api/v2/admins', requestJson)

  // Fetch all local users (for adding new members)
  const { data: localUsersData } = useSWR<{ data: LocalUser[] }>(
    '/admin/api/v2/users?user_type=local&page_size=100',
    requestJson
  )

  const members = membersData?.data || []
  const allAdmins = adminsData?.data || []
  const localUsers = localUsersData?.data || []

  // Filter members by search query
  const filteredMembers = members.filter((member) =>
    member.username.toLowerCase().includes(searchQuery.toLowerCase())
  )

  // Get local users not already in this role
  const memberUuids = new Set(members.map((m) => m.uuid))
  const availableUsers = localUsers.filter((user) => !memberUuids.has(user.uuid))

  const handleAddMembers = async () => {
    if (isAutoManaged) {
      showError('Members for this role are managed automatically.')
      return
    }
    if (selectedUsers.length === 0) {
      showError('Please select at least one user to add')
      return
    }

    setSubmitting(true)
    try {
      // Fetch all roles once to map role names to IDs
      const allRolesResponse = await requestJson<{ data: AdminRole[] }>('/admin/api/v2/admin-roles?include_permissions=false')
      const allRoles = allRolesResponse.data

      // Get the current role IDs for each selected user and add this role
      const updates = await Promise.all(
        selectedUsers.map(async (userUuid) => {
          // Find the user in the local users list to get their ID
          const user = localUsers.find((u) => u.uuid === userUuid)
          if (!user) {
            console.warn(`User not found: ${userUuid}`)
            return null
          }

          // Map role names to IDs
          const currentRoleIds = user.admin_roles
            .map((roleName) => allRoles.find((r) => r.name === roleName)?.id)
            .filter((id): id is string => id !== undefined)

          // Add the new role if not already present
          const newRoleIds = currentRoleIds.includes(role.id)
            ? currentRoleIds
            : [...currentRoleIds, role.id]

          return requestJson(`/admin/api/v2/admins/${user.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ role_ids: newRoleIds }),
          })
        })
      )

      const successCount = updates.filter((u) => u !== null).length
      const failedCount = selectedUsers.length - successCount

      if (successCount > 0) {
        success(`Added ${successCount} member(s) to role '${role.name}'${failedCount > 0 ? `. ${failedCount} user(s) could not be added.` : ''}`)
      } else {
        showError('No users were added.')
      }

      setAddModalOpen(false)
      setSelectedUsers([])
      await refreshMembers()
      await onUpdate()
    } catch (err) {
      showError(`Failed to add members: ${(err as Error).message}`)
    } finally {
      setSubmitting(false)
    }
  }

  const handleRemoveMember = async (memberUuid: string, username: string) => {
    if (isAutoManaged) {
      showError('Members for this role are managed automatically.')
      return
    }
    if (
      !window.confirm(`Remove ${username} from this role? They will lose all permissions from this role.`)
    ) {
      return
    }

    try {
      // Find the admin by UUID
      const admin = allAdmins.find((a) => a.uuid === memberUuid)
      if (!admin) {
        showError('Admin not found')
        return
      }

      // Remove this role from their roles
      const currentRoleIds = admin.admin_roles.map((r) => r.id)
      const newRoleIds = currentRoleIds.filter((id) => id !== role.id)

      await requestJson(`/admin/api/v2/admins/${admin.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ role_ids: newRoleIds }),
      })

      success(`Removed ${username} from role '${role.name}'`)
      await refreshMembers()
      await onUpdate()
    } catch (err) {
      showError(`Failed to remove member: ${(err as Error).message}`)
    }
  }

  const toggleUserSelection = (userUuid: string) => {
    setSelectedUsers((prev) =>
      prev.includes(userUuid) ? prev.filter((id) => id !== userUuid) : [...prev, userUuid]
    )
  }

  const isOwner = (userType: string) => userType === 'OWNER'

  return (
    <div className="space-y-6">
      {/* Members Overview Section */}
      <div className="rounded-lg border border-border bg-card/30 p-6">
        <div className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/20">
              <IconUsers className="size-5 text-primary" />
            </div>
            <div>
              <h2 className="mb-1 text-xl font-semibold">Role Members</h2>
              <p className="text-sm text-muted-foreground">
                Manage administrators assigned to this role
              </p>
            </div>
          </div>
          <Button onClick={() => setAddModalOpen(true)} disabled={isAutoManaged}>
            <IconUserPlus className="mr-2 size-4" />
            Add Admin
          </Button>
        </div>

        {/* Stats Card */}
        <Alert variant="info">
          <IconInfoCircle />
          <AlertTitle>Current Members</AlertTitle>
          <AlertDescription>
            {members.length} administrator{members.length !== 1 ? 's' : ''} assigned to this role
          </AlertDescription>
        </Alert>

        {isAutoManaged && (
          <Alert variant="info" className="mt-4">
            <IconInfoCircle />
            <AlertTitle>Auto-managed membership</AlertTitle>
            <AlertDescription>
              Members for this role are managed by the system. Add or remove admin roles to
              adjust membership.
            </AlertDescription>
          </Alert>
        )}
      </div>

      {/* Members List Section */}
      <div className="rounded-lg border border-border bg-card/30 p-6">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex size-8 items-center justify-center rounded-full bg-secondary/20">
            <i className="fa-solid fa-list text-sm text-secondary" />
          </div>
          <div>
            <h3 className="text-lg font-semibold">Member List</h3>
          </div>
        </div>

        {/* Search Bar */}
        <div className="mb-6">
          <Label className="mb-2 text-sm font-medium">Search Members</Label>
          <div className="relative">
            <IconSearch className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="text"
              placeholder="Search current members..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-11 pl-10"
            />
          </div>
        </div>

        {/* Members List */}
        {membersLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span className="inline-flex size-4 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
            Loading members...
          </div>
        ) : filteredMembers.length === 0 ? (
          <div className="py-12 text-center">
            <i className="fa-solid fa-users-slash mb-4 text-4xl text-muted-foreground/30" />
            <h4 className="mb-2 text-lg font-semibold">No Members</h4>
            <p className="mb-4 text-sm text-muted-foreground">
              {searchQuery
                ? 'No members match your search.'
                : "This role doesn't have any members assigned yet."}
            </p>
            {!searchQuery && !isAutoManaged && (
              <Button size="sm" onClick={() => setAddModalOpen(true)}>
                <IconUserPlus className="mr-2 size-4" />
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
                        {member.username.charAt(0).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <div>
                      <div className="font-semibold">{member.username}</div>
                      {memberIsOwner && <Badge className="mt-1">Owner</Badge>}
                      {!memberIsOwner && <Badge variant="secondary" className="mt-1">Admin</Badge>}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {!memberIsOwner && !isAutoManaged ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:bg-destructive/10"
                        onClick={() => handleRemoveMember(member.uuid, member.username)}
                      >
                        <IconUserMinus className="mr-1 size-4" />
                        Remove
                      </Button>
                    ) : !memberIsOwner && isAutoManaged ? (
                      <span className="text-xs text-muted-foreground">Auto-managed</span>
                    ) : (
                      <span className="text-xs text-muted-foreground">Cannot remove owner</span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

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
          <Button key="add" onClick={handleAddMembers} disabled={submitting}>
            {submitting ? 'Adding...' : `Add ${selectedUsers.length} User(s)`}
          </Button>,
        ]}
      >
        <div className="space-y-4">
          {availableUsers.length === 0 ? (
            <Alert variant="info">
              <IconInfoCircle />
              <AlertDescription>
                All local users are already members of this role.
              </AlertDescription>
            </Alert>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                Select local users to add to this role. They will inherit all permissions from
                this role and become administrators.
              </p>

              <div className="max-h-96 space-y-2 overflow-y-auto">
                {availableUsers.map((user) => {
                  const checkboxId = `user-${user.uuid}`
                  const isSelected = selectedUsers.includes(user.uuid)
                  const isAdmin = user.admin_roles.length > 0

                  return (
                    <div
                      key={user.uuid}
                      className="flex items-center gap-3 rounded-lg border border-border p-3 hover:bg-accent/50"
                    >
                      <Checkbox
                        id={checkboxId}
                        checked={isSelected}
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
                            {!isAdmin && (
                              <Badge variant="outline" className="text-xs">
                                Not an admin
                              </Badge>
                            )}
                          </div>
                          {isAdmin && (
                            <div className="text-xs text-muted-foreground">
                              Current roles: {user.admin_roles.join(', ')}
                            </div>
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
