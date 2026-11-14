import { useEffect, useState } from 'react'
import { useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faArrowLeft, faPalette, faKey, faUsers, faPen, faCircleExclamation, faCircleInfo } from '@fortawesome/free-solid-svg-icons'
import { useAdminRoleDetail, useAdminPermissions } from '../hooks/useAdminRoles'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { AdminRoleDisplayTab } from '../components/roles/AdminRoleDisplayTab'
import { AdminRolePermissionsTab } from '../components/roles/AdminRolePermissionsTab'
import { AdminRoleMembersTab } from '../components/roles/AdminRoleMembersTab'
import { Spinner } from '@/components/ui/spinner'

export const AdminSettingsAdminRolesEditPage = () => {
  const { roleId } = useParams({ from: '/admin/settings/admin-roles/$roleId/edit' })
  const navigate = useNavigate()
  const search = useSearch({ from: '/admin/settings/admin-roles/$roleId/edit' })
  const { role, loading, error, refresh, actor } = useAdminRoleDetail(roleId)
  const { permissions } = useAdminPermissions()

  const activeTab = (search as any).tab || 'display'

  const handleTabChange = (value: string) => {
    navigate({ href: `/admin/settings/admin-roles/${encodeURIComponent(roleId)}/edit?tab=${encodeURIComponent(value)}` })
  }

  const handleBack = () => {
    navigate({ to: '/admin/settings/admin-roles' })
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="size-4 text-muted-foreground" />
          Loading role...
        </div>
      </div>
    )
  }

  if (!role) {
    return (
      <div className="space-y-6">
        <Alert variant="destructive">
          <FontAwesomeIcon icon={faCircleExclamation} className="h-4 w-4" />
          <AlertTitle>{error ? 'Role unavailable' : 'Role not found'}</AlertTitle>
          <AlertDescription>The requested role could not be read with your current session. Return to the role list and refresh.</AlertDescription>
        </Alert>
        <Button onClick={handleBack} variant="outline">
          <FontAwesomeIcon icon={faArrowLeft} className="mr-2 size-4" />
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
          <FontAwesomeIcon icon={faArrowLeft} className="mr-2 size-4" />
          Back to Role List
        </Button>
      </div>

      {/* Header */}
      <div className="space-y-4">
        <div className="flex items-center gap-4">
          <div className="flex size-12 shrink-0 items-center justify-center rounded-full bg-primary/20">
            <FontAwesomeIcon icon={faPen} className="size-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">Edit Admin Role</h1>
            <p className="text-sm text-muted-foreground">
              Manage display settings, permissions and members for <strong>{role.name}</strong>
            </p>
          </div>
        </div>

        {/* Staff Role Notice */}
        {isAutoManaged && (
          <Alert variant="info">
            <FontAwesomeIcon icon={faCircleInfo} className="h-4 w-4" />
            <AlertTitle>Automatically Managed Role</AlertTitle>
            <AlertDescription>
              This role is managed by the system. Effective access comes from its persisted permissions. Role and membership changes are unavailable here.
            </AlertDescription>
          </Alert>
        )}
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <TabsList className="w-full justify-start overflow-x-auto">
          <TabsTrigger value="display">
            <FontAwesomeIcon icon={faPalette} className="mr-2 size-4" />
            Display Settings
          </TabsTrigger>
          <TabsTrigger value="permissions">
              <FontAwesomeIcon icon={faKey} className="mr-2 size-4" />
              Permissions
          </TabsTrigger>
          <TabsTrigger value="members">
            <FontAwesomeIcon icon={faUsers} className="mr-2 size-4" />
            Members ({role.user_count ?? 0})
          </TabsTrigger>
        </TabsList>

        <div className="mt-6 min-h-[400px]">
          <TabsContent value="display" className="mt-0">
            <fieldset disabled={!role.mutations_available}><AdminRoleDisplayTab key={`${actor}-${role.id}`} role={role} onUpdate={refresh} /></fieldset>
          </TabsContent>

          <TabsContent value="permissions" className="mt-0">
              <fieldset disabled={!role.mutations_available}><AdminRolePermissionsTab key={`${actor}-${role.id}`}
                role={role}
                permissions={permissions}
                onUpdate={refresh}
              /></fieldset>
          </TabsContent>

          <TabsContent value="members" className="mt-0">
            <AdminRoleMembersTab key={`${actor}-${role.id}`} role={role} onUpdate={refresh} />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  )
}

export default AdminSettingsAdminRolesEditPage
