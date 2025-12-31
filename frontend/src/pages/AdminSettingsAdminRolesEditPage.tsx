import { useEffect, useState } from 'react'
import { useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { IconArrowLeft, IconPalette, IconKey, IconUsers, IconPencil, IconAlertCircle, IconInfoCircle } from '@tabler/icons-react'
import { useAdminRoles, useAdminPermissions } from '../hooks/useAdminRoles'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { AdminRoleDisplayTab } from '../components/roles/AdminRoleDisplayTab'
import { AdminRolePermissionsTab } from '../components/roles/AdminRolePermissionsTab'
import { AdminRoleMembersTab } from '../components/roles/AdminRoleMembersTab'

export const AdminSettingsAdminRolesEditPage = () => {
  const { roleId } = useParams({ from: '/admin/settings/admin-roles/$roleId/edit' })
  const navigate = useNavigate()
  const search = useSearch({ from: '/admin/settings/admin-roles/$roleId/edit' })
  const { roles, loading, refresh } = useAdminRoles(true, true)
  const { permissions } = useAdminPermissions()

  const activeTab = (search as any).tab || 'display'
  const role = roles.find((r) => r.id === roleId)

  const handleTabChange = (value: string) => {
    navigate({ search: (prev: any) => ({ ...prev, tab: value }) })
  }

  const handleBack = () => {
    navigate({ to: '/admin/settings/admin-roles' })
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="inline-flex size-4 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
          Loading role...
        </div>
      </div>
    )
  }

  if (!role) {
    return (
      <div className="space-y-6">
        <Alert variant="destructive">
          <IconAlertCircle />
          <AlertTitle>Role not found</AlertTitle>
          <AlertDescription>The requested role could not be found.</AlertDescription>
        </Alert>
        <Button onClick={handleBack} variant="outline">
          <IconArrowLeft className="mr-2 size-4" />
          Back to Role List
        </Button>
      </div>
    )
  }

  const isAutoManaged = role.is_auto_managed

  return (
    <div className="space-y-6">
      {/* Navigation */}
      <div className="flex items-center">
        <Button variant="ghost" size="sm" onClick={handleBack}>
          <IconArrowLeft className="mr-2 size-4" />
          Back to Role List
        </Button>
      </div>

      {/* Header */}
      <div className="space-y-4">
        <div className="flex items-center gap-4">
          <div className="flex size-12 shrink-0 items-center justify-center rounded-full bg-primary/20">
            <IconPencil className="size-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">Edit Role</h1>
            <p className="text-sm text-muted-foreground">
              Manage settings and permissions for <strong>{role.name}</strong>
            </p>
          </div>
        </div>

        {/* Staff Role Notice */}
        {isAutoManaged && (
          <Alert variant="info">
            <IconInfoCircle />
            <AlertTitle>Automatically Managed Role</AlertTitle>
            <AlertDescription>
              This role is automatically managed by the system. It is assigned based on admin
              role membership and does not grant additional permissions. You can customize its
              appearance only.
            </AlertDescription>
          </Alert>
        )}
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <TabsList className="w-full justify-start">
          <TabsTrigger value="display">
            <IconPalette className="mr-2 size-4" />
            Display Settings
          </TabsTrigger>
          {!isAutoManaged && (
            <>
              <TabsTrigger value="permissions">
                <IconKey className="mr-2 size-4" />
                Permissions
              </TabsTrigger>
              <TabsTrigger value="members">
                <IconUsers className="mr-2 size-4" />
                Members ({role.users?.length || 0})
              </TabsTrigger>
            </>
          )}
        </TabsList>

        <div className="mt-6 min-h-[400px]">
          <TabsContent value="display" className="mt-0">
            <AdminRoleDisplayTab role={role} onUpdate={refresh} />
          </TabsContent>

          {!isAutoManaged && (
            <>
              <TabsContent value="permissions" className="mt-0">
                <AdminRolePermissionsTab
                  role={role}
                  permissions={permissions}
                  onUpdate={refresh}
                />
              </TabsContent>

              <TabsContent value="members" className="mt-0">
                <AdminRoleMembersTab role={role} onUpdate={refresh} />
              </TabsContent>
            </>
          )}
        </div>
      </Tabs>
    </div>
  )
}

export default AdminSettingsAdminRolesEditPage
