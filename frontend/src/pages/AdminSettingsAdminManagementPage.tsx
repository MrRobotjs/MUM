import { useState, useEffect } from 'react'
import { IconUserPlus, IconPencil, IconKey, IconTrash, IconSearch, IconShield, IconLock, IconUsersGroup, IconAlertCircle, IconCheck, IconInfoCircle } from '@tabler/icons-react'
import { requestJson } from '../util/apiClient'
import { useAlerts } from '../contexts'
import { useAuth } from '../contexts/AuthContext'
import { PageHeader } from '../components'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent } from '@/components/ui/card'
import { ResponsiveDialog } from '@/components/ui/responsive-dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'

type AdminRole = {
  id: string
  name: string
  description?: string
  position?: number
  color?: string | null
  icon?: string | null
}

type Admin = {
  id: number
  uuid?: string
  username: string
  display_name: string
  user_type: string
  email?: string | null
  last_login_at?: string | null
  admin_roles: AdminRole[]
}

type AdminRoleOption = {
  id: string
  name: string
  color?: string | null
  icon?: string | null
}

const AdminSettingsAdminManagementPage = () => {
  const [admins, setAdmins] = useState<Admin[]>([])
  const [filteredAdmins, setFilteredAdmins] = useState<Admin[]>([])
  const [roles, setRoles] = useState<AdminRoleOption[]>([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [showEditModal, setShowEditModal] = useState(false)
  const [showResetPasswordModal, setShowResetPasswordModal] = useState(false)
  const [selectedAdmin, setSelectedAdmin] = useState<Admin | null>(null)

  // Form states
  const [createUsername, setCreateUsername] = useState('')
  const [createPassword, setCreatePassword] = useState('')
  const [createConfirmPassword, setCreateConfirmPassword] = useState('')
  const [createRoleIds, setCreateRoleIds] = useState<string[]>([])

  const [editRoleIds, setEditRoleIds] = useState<string[]>([])

  const [resetPassword, setResetPassword] = useState('')
  const [resetConfirmPassword, setResetConfirmPassword] = useState('')

  const [submitting, setSubmitting] = useState(false)

  const { success, error: showError } = useAlerts()
  const { user: currentUser } = useAuth()

  useEffect(() => {
    fetchAdmins()
    fetchRoles()
  }, [])

  useEffect(() => {
    filterAdmins()
  }, [searchQuery, admins])

  const fetchAdmins = async () => {
    try {
      setLoading(true)
      const response = await requestJson<{ data: Admin[] }>('/admin/api/v2/admins')
      setAdmins(response.data || [])
    } catch (error) {
      showError(`Failed to load admins: ${error}`)
    } finally {
      setLoading(false)
    }
  }

  const fetchRoles = async () => {
    try {
      const response = await requestJson<{ data: AdminRoleOption[] }>('/admin/api/v2/admin-roles')
      setRoles(response.data || [])
    } catch (error) {
      console.error('Failed to load roles:', error)
    }
  }

  const filterAdmins = () => {
    if (!searchQuery.trim()) {
      setFilteredAdmins(admins)
      return
    }

    const query = searchQuery.toLowerCase()
    const filtered = admins.filter((admin) => {
      const nameMatch = admin.username?.toLowerCase().includes(query) || admin.display_name?.toLowerCase().includes(query)
      const emailMatch = admin.email?.toLowerCase().includes(query)
      const typeMatch = admin.user_type?.toLowerCase().includes(query)
      const rolesMatch = admin.admin_roles?.some((role) => role.name.toLowerCase().includes(query))
      return nameMatch || emailMatch || typeMatch || rolesMatch
    })

    setFilteredAdmins(filtered)
  }

  const handleCreateAdmin = async (e: React.FormEvent) => {
    e.preventDefault()

    if (createPassword !== createConfirmPassword) {
      showError('Passwords do not match')
      return
    }

    try {
      setSubmitting(true)
      await requestJson('/admin/api/v2/admins', {
        method: 'POST',
        body: JSON.stringify({
          username: createUsername,
          password: createPassword,
          role_ids: createRoleIds
        })
      })

      success(`Administrator ${createUsername} has been created successfully`)

      setShowCreateModal(false)
      setCreateUsername('')
      setCreatePassword('')
      setCreateConfirmPassword('')
      setCreateRoleIds([])
      await fetchAdmins()
    } catch (error) {
      showError(`Failed to create admin: ${error}`)
    } finally {
      setSubmitting(false)
    }
  }

  const handleEditAdmin = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!selectedAdmin) return

    try {
      setSubmitting(true)
      await requestJson(`/admin/api/v2/admins/${selectedAdmin.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          role_ids: editRoleIds
        })
      })

      success(`Roles updated for ${selectedAdmin.username}`)

      setShowEditModal(false)
      setSelectedAdmin(null)
      setEditRoleIds([])
      await fetchAdmins()
    } catch (error) {
      showError(`Failed to update admin: ${error}`)
    } finally {
      setSubmitting(false)
    }
  }

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!selectedAdmin) return

    if (resetPassword !== resetConfirmPassword) {
      showError('Passwords do not match')
      return
    }

    try {
      setSubmitting(true)
      await requestJson(`/admin/api/v2/admins/${selectedAdmin.id}/reset-password`, {
        method: 'POST',
        body: JSON.stringify({
          password: resetPassword
        })
      })

      success(`Password has been reset for ${selectedAdmin.username}`)

      setShowResetPasswordModal(false)
      setSelectedAdmin(null)
      setResetPassword('')
      setResetConfirmPassword('')
    } catch (error) {
      showError(`Failed to reset password: ${error}`)
    } finally {
      setSubmitting(false)
    }
  }

  const handleDeleteAdmin = async (admin: Admin) => {
    if (!window.confirm(`Are you sure you want to delete ${admin.username}? This action cannot be undone.`)) {
      return
    }

    try {
      await requestJson(`/admin/api/v2/admins/${admin.id}`, {
        method: 'DELETE'
      })

      success(`${admin.username} has been deleted`)
      await fetchAdmins()
    } catch (error) {
      showError(`Failed to delete admin: ${error}`)
    }
  }

  const openEditModal = (admin: Admin) => {
    setSelectedAdmin(admin)
    setEditRoleIds(admin.admin_roles.map((r) => r.id))
    setShowEditModal(true)
  }

  const openResetPasswordModal = (admin: Admin) => {
    setSelectedAdmin(admin)
    setResetPassword('')
    setResetConfirmPassword('')
    setShowResetPasswordModal(true)
  }

  const toggleCreateRole = (roleId: string) => {
    setCreateRoleIds((prev) =>
      prev.includes(roleId) ? prev.filter((id) => id !== roleId) : [...prev, roleId]
    )
  }

  const toggleEditRole = (roleId: string) => {
    setEditRoleIds((prev) =>
      prev.includes(roleId) ? prev.filter((id) => id !== roleId) : [...prev, roleId]
    )
  }

  const isOwner = (admin: Admin) => admin.user_type === 'owner'
  const isCurrentUser = (admin: Admin) => currentUser?.id === admin.id
  const canEdit = (admin: Admin) => !isOwner(admin) && !isCurrentUser(admin)
  const canDelete = (admin: Admin) => !isOwner(admin) && !isCurrentUser(admin)

  const getInitials = (name: string): string => {
    return name ? name[0].toUpperCase() : 'A'
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Administrator Management"
        description="Manage administrator accounts and their permissions"
        actions={
          <Button onClick={() => setShowCreateModal(true)}>
            <IconUserPlus className="mr-2 size-4" />
            Create New Admin
          </Button>
        }
      />

      {/* Admins Overview */}
      <Card>
        <CardContent className="p-6">
          <div className="mb-6 flex items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/20">
              <IconUsersGroup className="size-5 text-primary" />
            </div>
            <div>
              <h2 className="mb-1 text-xl font-semibold">System Administrators</h2>
              <p className="text-sm text-muted-foreground">
                {admins.length} administrator{admins.length !== 1 ? 's' : ''} configured
              </p>
            </div>
          </div>

          <Alert variant="info">
            <IconInfoCircle />
            <AlertTitle>Admin Guidelines</AlertTitle>
            <AlertDescription>
              The primary owner cannot be edited or deleted. You cannot modify your own account for security reasons.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>

      {/* Admins List */}
      <Card>
        <CardContent className="p-6">
          <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <div className="flex size-8 items-center justify-center rounded-full bg-secondary/20">
                <i className="fa-solid fa-list text-sm text-secondary" />
              </div>
              <h3 className="text-lg font-semibold">Administrators List</h3>
            </div>

            <div className="relative w-full sm:w-auto">
              <IconSearch className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="text"
                placeholder="Search administrators..."
                className="w-full pl-10 sm:w-64"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-12">
              <span className="inline-flex size-4 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>ID</TableHead>
                    <TableHead>Administrator</TableHead>
                    <TableHead>Account Type</TableHead>
                    <TableHead>Assigned Roles</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredAdmins.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="py-8 text-center">
                        <div className="text-muted-foreground">
                          <IconSearch className="mx-auto mb-2 size-6" />
                          <p className="text-sm">
                            {searchQuery ? `No administrators found matching "${searchQuery}"` : 'No administrators found'}
                          </p>
                        </div>
                      </TableCell>
                    </TableRow>
                  ) : (
                    filteredAdmins.map((admin) => (
                      <TableRow key={admin.id}>
                        {/* ID */}
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <div
                              className={`flex size-6 items-center justify-center rounded-full ${
                                isOwner(admin) ? 'bg-amber-100/20' : 'bg-blue-100/20'
                              }`}
                            >
                              {isOwner(admin) ? (
                                <i className="fa-solid fa-crown text-xs text-amber-600 dark:text-amber-400" />
                              ) : (
                                <i className="fa-solid fa-user-tie text-xs text-blue-600 dark:text-blue-400" />
                              )}
                            </div>
                            <span className="font-mono text-sm">{admin.id}</span>
                          </div>
                        </TableCell>

                        {/* Administrator */}
                        <TableCell>
                          <div className="flex items-center gap-3">
                            <Avatar className={isOwner(admin) ? 'bg-amber-100/20 text-amber-600 dark:text-amber-400' : 'bg-primary/20 text-primary'}>
                              <AvatarFallback>
                                {isOwner(admin) ? (
                                  <i className="fa-solid fa-crown" />
                                ) : (
                                  getInitials(admin.username)
                                )}
                              </AvatarFallback>
                            </Avatar>
                            <div>
                              <div className="font-medium">{admin.username}</div>
                              {admin.email && <div className="text-sm text-muted-foreground">{admin.email}</div>}
                            </div>
                          </div>
                        </TableCell>

                        {/* Account Type */}
                        <TableCell>
                          <Badge
                            variant="outline"
                            style={{
                              backgroundColor: isOwner(admin) ? '#faa61a20' : '#5865f220',
                              color: isOwner(admin) ? '#faa61a' : '#5865f2',
                              borderColor: isOwner(admin) ? '#faa61a40' : '#5865f240'
                            }}
                          >
                            <i className={`mr-1 size-3 ${isOwner(admin) ? 'fa-solid fa-crown' : 'fa-solid fa-user-tie'}`} />
                            {isOwner(admin) ? 'Owner' : 'Staff'}
                          </Badge>
                        </TableCell>

                        {/* Assigned Roles */}
                        <TableCell>
                          {isOwner(admin) ? (
                            <Badge
                              variant="outline"
                              style={{
                                backgroundColor: '#faa61a20',
                                color: '#faa61a',
                                borderColor: '#faa61a40'
                              }}
                            >
                              <i className="fa-solid fa-key mr-1 size-3" />
                              All Permissions
                            </Badge>
                          ) : admin.admin_roles.length > 0 ? (
                            <div className="flex flex-wrap gap-1">
                              {admin.admin_roles.map((role) => (
                                <Badge
                                  key={role.id}
                                  variant="outline"
                                  style={{
                                    backgroundColor: `${role.color || '#808080'}20`,
                                    color: role.color || '#808080',
                                    borderColor: `${role.color || '#808080'}40`
                                  }}
                                >
                                  {role.icon && <i className={`${role.icon} mr-1 size-3`} />}
                                  {role.name}
                                </Badge>
                              ))}
                            </div>
                          ) : (
                            <span className="text-xs italic text-muted-foreground">No admin roles assigned</span>
                          )}
                        </TableCell>

                        {/* Actions */}
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-2">
                            {isOwner(admin) ? (
                              <Button variant="ghost" size="sm" disabled>
                                <IconShield className="mr-1 size-4" />
                                <span className="hidden md:inline">Protected</span>
                              </Button>
                            ) : isCurrentUser(admin) ? (
                              <Button variant="ghost" size="sm" disabled>
                                <IconLock className="mr-1 size-4" />
                                <span className="hidden md:inline">Locked</span>
                              </Button>
                            ) : (
                              <>
                                <Button variant="ghost" size="sm" onClick={() => openEditModal(admin)} title="Edit Administrator">
                                  <IconPencil className="mr-1 size-4" />
                                  <span className="hidden md:inline">Edit</span>
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="text-amber-600 dark:text-amber-400 hover:bg-amber-50 dark:bg-amber-400/10"
                                  onClick={() => openResetPasswordModal(admin)}
                                  title="Reset Password"
                                >
                                  <IconKey className="mr-1 size-4" />
                                  <span className="hidden md:inline">Reset</span>
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="text-destructive hover:bg-destructive/10"
                                  onClick={() => handleDeleteAdmin(admin)}
                                  title="Delete Administrator"
                                >
                                  <IconTrash className="mr-1 size-4" />
                                  <span className="hidden md:inline">Delete</span>
                                </Button>
                              </>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Create Admin Modal */}
      <ResponsiveDialog
        open={showCreateModal}
        onOpenChange={setShowCreateModal}
        title="Create New Administrator"
        contentClassName="max-w-2xl"
        footer={[
          <Button key="cancel" variant="outline" onClick={() => setShowCreateModal(false)}>
            Cancel
          </Button>,
          <Button key="submit" type="submit" form="create-admin-form" disabled={submitting}>
            {submitting && <span className="mr-2 inline-flex size-4 animate-spin rounded-full border-2 border-background border-t-transparent" />}
            <IconUserPlus className="mr-2 size-4" />
            Create Admin
          </Button>
        ]}
      >
        <Alert variant="info" className="mb-6">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-blue-100/20">
              <IconAlertCircle className="size-4 text-blue-600 dark:text-blue-400" />
            </div>
            <div>
              <AlertTitle>Administrator Account</AlertTitle>
              <AlertDescription>
                Create a new administrator account with full system access. The new admin will be required to change their password on first login for security.
              </AlertDescription>
            </div>
          </div>
        </Alert>

        <form id="create-admin-form" onSubmit={handleCreateAdmin} className="space-y-6">
          {/* Account Details */}
          <div className="space-y-4">
            <h4 className="flex items-center gap-2 text-lg font-medium">
              <i className="fa-solid fa-user text-sm text-green-600 dark:text-green-400" />
              Account Details
            </h4>

            <div className="space-y-2">
              <Label htmlFor="create-username">Username</Label>
              <Input
                id="create-username"
                type="text"
                value={createUsername}
                onChange={(e) => setCreateUsername(e.target.value)}
                required
              />
              <p className="text-xs text-muted-foreground">Choose a unique username for the administrator account</p>
            </div>
          </div>

          {/* Security Settings */}
          <div className="space-y-4">
            <h4 className="flex items-center gap-2 text-lg font-medium">
              <i className="fa-solid fa-shield-halved text-sm text-amber-600 dark:text-amber-400" />
              Security Settings
            </h4>

            <div className="space-y-2">
              <Label htmlFor="create-password">Password</Label>
              <Input
                id="create-password"
                type="password"
                value={createPassword}
                onChange={(e) => setCreatePassword(e.target.value)}
                required
                minLength={8}
              />
              <p className="text-xs text-muted-foreground">Create a temporary password (minimum 8 characters)</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="create-confirm-password">Confirm Password</Label>
              <Input
                id="create-confirm-password"
                type="password"
                value={createConfirmPassword}
                onChange={(e) => setCreateConfirmPassword(e.target.value)}
                required
              />
              <p className="text-xs text-muted-foreground">Re-enter the password to confirm</p>
            </div>

            <Alert className="border-amber-500/30 bg-amber-50 dark:bg-amber-400/10">
              <div className="flex items-start gap-2">
                <i className="fa-solid fa-exclamation-triangle mt-0.5 text-sm text-amber-600 dark:text-amber-400" />
                <div>
                  <AlertTitle>Security Notice</AlertTitle>
                  <AlertDescription>
                    The new administrator will be required to change this temporary password on their first login.
                  </AlertDescription>
                </div>
              </div>
            </Alert>
          </div>

          {/* Roles */}
          {roles.length > 0 && (
            <div className="space-y-4">
              <h4 className="flex items-center gap-2 text-lg font-medium">
                <i className="fa-solid fa-key text-sm text-primary" />
                Assign Roles (Optional)
              </h4>

              <div className="space-y-3 rounded-lg border p-4">
                {roles.map((role) => (
                  <Label key={role.id} className="flex cursor-pointer items-center gap-3 rounded p-2 hover:bg-accent">
                    <Checkbox
                      checked={createRoleIds.includes(role.id)}
                      onCheckedChange={() => toggleCreateRole(role.id)}
                    />
                    <span>{role.name}</span>
                  </Label>
                ))}
              </div>
            </div>
          )}
        </form>
      </ResponsiveDialog>

      {/* Edit Admin Modal */}
      <ResponsiveDialog
        open={showEditModal}
        onOpenChange={setShowEditModal}
        title={`Edit Admin: ${selectedAdmin?.username || ''}`}
        contentClassName="max-w-2xl"
        footer={[
          <Button key="cancel" variant="outline" onClick={() => setShowEditModal(false)}>
            Cancel
          </Button>,
          <Button key="submit" type="submit" form="edit-admin-form" disabled={submitting}>
            {submitting && <span className="mr-2 inline-flex size-4 animate-spin rounded-full border-2 border-background border-t-transparent" />}
            <IconCheck className="mr-2 size-4" />
            Save Changes
          </Button>
        ]}
      >
        <form id="edit-admin-form" onSubmit={handleEditAdmin} className="space-y-4">
          <h4 className="flex items-center gap-2 text-lg font-medium">
            <i className="fa-solid fa-key text-sm text-green-600 dark:text-green-400" />
            Permissions & Roles
          </h4>

          <div className="rounded-lg border p-4">
            {roles.length > 0 ? (
              <div className="space-y-3">
                {roles.map((role) => (
                  <Label key={role.id} className="flex cursor-pointer items-center gap-3 rounded p-2 hover:bg-accent">
                    <Checkbox
                      checked={editRoleIds.includes(role.id)}
                      onCheckedChange={() => toggleEditRole(role.id)}
                    />
                    <span>{role.name}</span>
                  </Label>
                ))}
              </div>
            ) : (
              <div className="py-4 text-center">
                <i className="fa-solid fa-users-slash mb-2 text-2xl text-muted-foreground/30" />
                <p className="text-sm text-muted-foreground">No roles exist yet.</p>
              </div>
            )}
          </div>
        </form>
      </ResponsiveDialog>

      {/* Reset Password Modal */}
      <ResponsiveDialog
        open={showResetPasswordModal}
        onOpenChange={setShowResetPasswordModal}
        title={`Reset Password for ${selectedAdmin?.username || ''}`}
        footer={[
          <Button key="cancel" variant="outline" onClick={() => setShowResetPasswordModal(false)}>
            Cancel
          </Button>,
          <Button key="submit" type="submit" form="reset-password-form" variant="default" disabled={submitting} className="bg-amber-100 hover:bg-amber-100/90">
            {submitting && <span className="mr-2 inline-flex size-4 animate-spin rounded-full border-2 border-background border-t-transparent" />}
            <IconKey className="mr-2 size-4" />
            Reset Password
          </Button>
        ]}
      >
        <form id="reset-password-form" onSubmit={handleResetPassword} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="reset-password">New Password</Label>
            <Input
              id="reset-password"
              type="password"
              value={resetPassword}
              onChange={(e) => setResetPassword(e.target.value)}
              required
              minLength={8}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="reset-confirm-password">Confirm New Password</Label>
            <Input
              id="reset-confirm-password"
              type="password"
              value={resetConfirmPassword}
              onChange={(e) => setResetConfirmPassword(e.target.value)}
              required
            />
          </div>
        </form>
      </ResponsiveDialog>
    </div>
  )
}

export default AdminSettingsAdminManagementPage
