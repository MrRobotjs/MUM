import { useState, useEffect } from 'react'
import { IconShieldHalf, IconDeviceFloppy, IconInfoCircle } from '@tabler/icons-react'
import { AdminRole, AdminPermission } from '../../hooks/useAdminRoles'
import { useAlerts } from '../../contexts'
import { requestJson } from '../../util/apiClient'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'

interface AdminRolePermissionsTabProps {
  role: AdminRole
  permissions: AdminPermission[]
  onUpdate: () => Promise<void>
}

// Define the permission structure matching the backend
const PERMISSIONS_STRUCTURE: Record<
  string,
  {
    label: string
    icon: string
    children: Record<string, { label: string; description: string }>
  }
> = {
  Users: {
    label: 'Users',
    icon: 'user-shield',
    children: {
      view_user: { label: 'View User', description: 'Can view user profile.' },
      edit_user: {
        label: 'Edit User',
        description: 'Can edit user details, notes, whitelists, and library access.',
      },
      delete_user: {
        label: 'Delete User',
        description: 'Can permanently remove users from MUM and the Plex server.',
      },
      purge_users: { label: 'Purge Users', description: 'Can use the inactivity purge feature.' },
      mass_edit_users: {
        label: 'Mass Edit Users',
        description: 'Can perform bulk actions like assigning libraries or whitelisting.',
      },
    },
  },
  Invites: {
    label: 'Invites',
    icon: 'ticket',
    children: {
      create_invites: { label: 'Create Invites', description: 'Can create new invite links.' },
      delete_invites: { label: 'Delete Invites', description: 'Can delete existing invite links.' },
      edit_invites: {
        label: 'Edit Invites',
        description: 'Can modify settings for existing invites.',
      },
    },
  },
  Admins: {
    label: 'Admins & Roles',
    icon: 'users-gear',
    children: {
      view_admins_tab: {
        label: 'View Admin Management Section',
        description: 'Allows user to see the "Admins" and "Roles" tabs in settings.',
      },
      create_admin: { label: 'Create Admin', description: 'Can create new administrator accounts.' },
      edit_admin: {
        label: 'Edit Admin',
        description: 'Can edit other administrators. (roles, reset password etc.)',
      },
      delete_admin: {
        label: 'Delete Admin',
        description: 'Can delete other non-primary administrators.',
      },
      create_role: { label: 'Create Role', description: 'Can create new administrator roles.' },
      edit_role: {
        label: 'Edit Role Permissions',
        description: "Can edit a role's name, color, and permissions.",
      },
      delete_role: { label: 'Delete Roles', description: 'Can delete roles that are not in use.' },
    },
  },
  Streams: {
    label: 'Streams',
    icon: 'play',
    children: {
      view_streaming: {
        label: 'View Streams',
        description: 'Can access the "Active Streams" page.',
      },
      kill_stream: { label: 'Terminate Stream', description: "Can stop a user's active stream." },
    },
  },
  EventLogs: {
    label: 'Application Logs',
    icon: 'file-text',
    children: {
      view_logs: {
        label: 'View Application Logs',
        description: 'Can access the full "Application Logs" page in settings.',
      },
      clear_logs: {
        label: 'Clear Application Logs',
        description: 'Can erase the full "Application Logs".',
      },
    },
  },
  Libraries: {
    label: 'Libraries',
    icon: 'library',
    children: {
      view_libraries: {
        label: 'View Libraries',
        description: 'Can access the libraries page and view library information.',
      },
      sync_libraries: {
        label: 'Sync Libraries',
        description: 'Can synchronize libraries from media servers.',
      },
    },
  },
  MediaServers: {
    label: 'Media Servers',
    icon: 'server',
    children: {
      view_servers: {
        label: 'View Servers',
        description: 'Can access the "Media Servers" page to view configured servers.',
      },
      edit_servers: {
        label: 'Edit Servers',
        description: 'Can add, edit, or remove media server configurations.',
      },
    },
  },
}

export const AdminRolePermissionsTab = ({
  role,
  permissions,
  onUpdate,
}: AdminRolePermissionsTabProps) => {
  const { success, error: showError } = useAlerts()
  const [submitting, setSubmitting] = useState(false)

  // Map permission names to IDs
  const permissionNameToId = Object.fromEntries(permissions.map((p) => [p.name, p.id]))

  // Track selected permission names
  const [selectedPermissions, setSelectedPermissions] = useState<Set<string>>(new Set())

  useEffect(() => {
    const rolePermissionNames = new Set(role.permissions?.map((p) => p.name) || [])
    setSelectedPermissions(rolePermissionNames)
  }, [role])

  const togglePermission = (permissionName: string) => {
    setSelectedPermissions((prev) => {
      const next = new Set(prev)
      if (next.has(permissionName)) {
        next.delete(permissionName)
      } else {
        next.add(permissionName)
      }

      // Auto-check view_admins_tab if any admin permission is selected
      if (permissionName !== 'view_admins_tab') {
        const adminPermissions = Object.keys(PERMISSIONS_STRUCTURE.Admins.children).filter(
          (name) => name !== 'view_admins_tab'
        )
        const anyAdminChecked = adminPermissions.some((name) => next.has(name))
        if (anyAdminChecked) {
          next.add('view_admins_tab')
        } else {
          next.delete('view_admins_tab')
        }
      }

      return next
    })
  }

  const toggleCategory = (category: string, checked: boolean) => {
    setSelectedPermissions((prev) => {
      const next = new Set(prev)
      const categoryPermissions = Object.keys(PERMISSIONS_STRUCTURE[category].children)

      categoryPermissions.forEach((permName) => {
        if (checked) {
          next.add(permName)
        } else {
          next.delete(permName)
        }
      })

      return next
    })
  }

  const isCategoryChecked = (category: string) => {
    const categoryPermissions = Object.keys(PERMISSIONS_STRUCTURE[category].children)
    return categoryPermissions.some((name) => selectedPermissions.has(name))
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    setSubmitting(true)

    try {
      const permissionIds = Array.from(selectedPermissions)
        .map((name) => permissionNameToId[name])
        .filter((id) => id !== undefined)

      await requestJson(`/admin/api/v2/admin-roles/${role.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          permission_ids: permissionIds,
        }),
      })
      success('Permissions saved successfully')
      await onUpdate()
    } catch (err) {
      showError(`Failed to save permissions: ${(err as Error).message}`)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Permissions Overview Section */}
      <div className="rounded-lg border border-border bg-card/30 p-6">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-success/20">
            <IconShieldHalf className="size-5 text-success" />
          </div>
          <div>
            <h2 className="mb-1 text-xl font-semibold">Role Permissions</h2>
            <p className="text-sm text-muted-foreground">
              Configure what actions members of this role can perform
            </p>
          </div>
        </div>

        {/* Info Card */}
        <Alert variant="info">
          <IconInfoCircle />
          <AlertTitle>Permission Guidelines</AlertTitle>
          <AlertDescription>
            Select the permissions that members of this role will have. Admin ID 1 automatically
            has all permissions regardless of role assignments.
          </AlertDescription>
        </Alert>
      </div>

      {/* Permission Categories */}
      <div className="space-y-4">
        {Object.entries(PERMISSIONS_STRUCTURE).map(([category, data]) => {
          const categoryChecked = isCategoryChecked(category)

          return (
            <div key={category} className="rounded-lg border border-border bg-card/30 p-6">
              {/* Category Header */}
              <div className="mb-4 flex items-center gap-3">
                <Label className="flex cursor-pointer items-center gap-3">
                  <Checkbox
                    checked={categoryChecked}
                    onCheckedChange={(checked) => toggleCategory(category, checked === true)}
                  />
                  <div className="flex items-center gap-3">
                    <div className="flex size-8 items-center justify-center rounded-full bg-primary/20">
                      <i className={`fa-solid fa-${data.icon} text-sm text-primary`} />
                    </div>
                    <div>
                      <h3 className="text-lg font-semibold">{data.label}</h3>
                    </div>
                  </div>
                </Label>
              </div>

              {/* Individual Permissions */}
              <div className="ml-11 space-y-3">
                {Object.entries(data.children).map(([permKey, permData]) => {
                  // Hide view_admins_tab as it's implicit
                  if (permKey === 'view_admins_tab') return null

                  return (
                    <Label
                      key={permKey}
                      className="flex cursor-pointer items-start gap-3 rounded-lg p-3 hover:bg-accent/50"
                      title={permData.description}
                    >
                      <Switch
                        checked={selectedPermissions.has(permKey)}
                        onCheckedChange={() => togglePermission(permKey)}
                        className="mt-1"
                      />
                      <div className="flex-1">
                        <span className="block text-sm font-medium">{permData.label}</span>
                        <p className="mt-1 text-xs text-muted-foreground">{permData.description}</p>
                      </div>
                    </Label>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>

      {/* Save Button */}
      <div className="flex items-center justify-end gap-3 border-t border-border pt-6">
        <Button type="submit" disabled={submitting} size="lg">
          <IconDeviceFloppy className="mr-2 size-4" />
          {submitting ? 'Saving...' : 'Save Permissions'}
        </Button>
      </div>
    </form>
  )
}
