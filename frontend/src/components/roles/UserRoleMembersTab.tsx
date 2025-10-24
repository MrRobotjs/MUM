import { useState } from 'react'
import { IconUsers, IconUserPlus, IconUserMinus, IconSearch } from '@tabler/icons-react'
import useSWR from 'swr'
import { UserRole } from '../../hooks/useUserRoles'
import { useAlerts } from '../../contexts'
import { requestJson } from '../../util/apiClient'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { ResponsiveDialog } from '@/components/ui/responsive-dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'

interface UserRoleMembersTabProps {
  role: UserRole
  onUpdate: () => Promise<void>
}

interface RoleMember {
  uuid: string
  username: string
  user_type: string
  email: string
}

interface LocalUser {
  id: number
  uuid: string
  username: string
  display_name: string
  email: string | null
  user_type: string
  user_roles: string[]
}

export const UserRoleMembersTab = ({ role, onUpdate }: UserRoleMembersTabProps) => {
  const { success, error: showError } = useAlerts()
  const [searchQuery, setSearchQuery] = useState('')
  const [addModalOpen, setAddModalOpen] = useState(false)
  const [selectedUsers, setSelectedUsers] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)

  // Fetch role members
  const {
    data: membersData,
    mutate: refreshMembers,
    isLoading: membersLoading,
  } = useSWR<{ data: RoleMember[] }>(`/admin/api/v1/user-roles/${role.id}/users`, requestJson)

  // Fetch all local users (for adding new members)
  const { data: localUsersData } = useSWR<{ data: LocalUser[] }>(
    '/admin/api/v1/users?user_type=local&page_size=1000',
    requestJson
  )

  const members = membersData?.data || []
  const localUsers = localUsersData?.data || []

  // Filter members by search query
  const filteredMembers = members.filter((member) =>
    member.username.toLowerCase().includes(searchQuery.toLowerCase())
  )

  // Get local users not already in this role
  const memberUuids = new Set(members.map((m) => m.uuid))
  const availableUsers = localUsers.filter((user) => !memberUuids.has(user.uuid))

  const handleAddMembers = async () => {
    if (selectedUsers.length === 0) {
      showError('Please select at least one user to add')
      return
    }

    setSubmitting(true)
    try {
      await Promise.all(
        selectedUsers.map((userUuid) =>
          requestJson(`/admin/api/v1/user-roles/${role.id}/users`, {
            method: 'POST',
            body: JSON.stringify({ user_uuid: userUuid }),
          })
        )
      )

      success(`Added ${selectedUsers.length} user(s) to role '${role.name}'`)
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
    if (!window.confirm(`Remove ${username} from this role?`)) {
      return
    }

    try {
      await requestJson(`/admin/api/v1/user-roles/${role.id}/users/${memberUuid}`, {
        method: 'DELETE',
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
                Manage users assigned to this role
              </p>
            </div>
          </div>
          <Button onClick={() => setAddModalOpen(true)}>
            <IconUserPlus className="mr-2 size-4" />
            Add User
          </Button>
        </div>

        {/* Stats Card */}
        <Alert variant="info">
          <div className="flex items-center gap-3">
            <div className="flex size-6 shrink-0 items-center justify-center rounded-full bg-info/20">
              <i className="fa-solid fa-chart-simple text-xs text-info" />
            </div>
            <div>
              <AlertTitle>Current Members</AlertTitle>
              <AlertDescription>
                {members.length} user{members.length !== 1 ? 's' : ''} assigned to this role
              </AlertDescription>
            </div>
          </div>
        </Alert>
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
            {!searchQuery && (
              <Button size="sm" onClick={() => setAddModalOpen(true)}>
                <IconUserPlus className="mr-2 size-4" />
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
                    {member.email && (
                      <div className="text-sm text-muted-foreground">{member.email}</div>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:bg-destructive/10"
                    onClick={() => handleRemoveMember(member.uuid, member.username)}
                  >
                    <IconUserMinus className="mr-1 size-4" />
                    Remove
                  </Button>
                </div>
              </div>
            ))}
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
              <AlertDescription>
                All local users are already members of this role.
              </AlertDescription>
            </Alert>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                Select local users to add to this role. This is a cosmetic badge and does not grant permissions.
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
                          {user.email && (
                            <div className="text-xs text-muted-foreground">{user.email}</div>
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
