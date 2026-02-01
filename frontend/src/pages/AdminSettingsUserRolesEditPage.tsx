import { useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faArrowLeft, faPalette, faPen, faUsers, faCircleExclamation } from '@fortawesome/free-solid-svg-icons'
import { useUserRoles } from '../hooks/useUserRoles'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { UserRoleDisplayTab } from '../components/roles/UserRoleDisplayTab'
import { UserRoleMembersTab } from '../components/roles/UserRoleMembersTab'
import { Spinner } from '@/components/ui/spinner'

export const AdminSettingsUserRolesEditPage = () => {
  const { roleId } = useParams({ from: '/admin/settings/user-roles/$roleId/edit' })
  const navigate = useNavigate()
  const search = useSearch({ from: '/admin/settings/user-roles/$roleId/edit' })
  const { roles, loading, refresh } = useUserRoles(false, true)

  const activeTab = (search as any).tab || 'display'
  const role = roles.find((r) => r.id === roleId)

  const handleTabChange = (value: string) => {
    navigate({ search: (prev: any) => ({ ...prev, tab: value }) })
  }

  const handleBack = () => {
    navigate({ to: '/admin/settings/user-roles' })
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
          <AlertTitle>Role not found</AlertTitle>
          <AlertDescription>The requested role could not be found.</AlertDescription>
        </Alert>
        <Button onClick={handleBack} variant="outline">
          <FontAwesomeIcon icon={faArrowLeft} className="mr-2 size-4" />
          Back to Role List
        </Button>
      </div>
    )
  }

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
            <h1 className="text-2xl font-bold">Edit User Role</h1>
            <p className="text-sm text-muted-foreground">
              Manage display settings for <strong>{role.name}</strong>
            </p>
          </div>
        </div>

      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <TabsList className="w-full justify-start">
          <TabsTrigger value="display">
            <FontAwesomeIcon icon={faPalette} className="mr-2 size-4" />
            Display Settings
          </TabsTrigger>
          <TabsTrigger value="members">
            <FontAwesomeIcon icon={faUsers} className="mr-2 size-4" />
            Members ({role.user_count || 0})
          </TabsTrigger>
        </TabsList>

        <div className="mt-6 min-h-[400px]">
          <TabsContent value="display" className="mt-0">
            <UserRoleDisplayTab role={role} onUpdate={refresh} />
          </TabsContent>

          <TabsContent value="members" className="mt-0">
            <UserRoleMembersTab role={role} onUpdate={refresh} />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  )
}

export default AdminSettingsUserRolesEditPage
