import { Suspense, lazy, useMemo, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';


import { useUserRoles, type UserRole } from '../hooks/useUserRoles';
import { PageHeader } from '../components';
import { Badge } from '@/components/common/Badge';
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Badge as UiBadge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableCaption,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { requestJson } from '../util/apiClient';
import { useAlerts, useTheme } from '../contexts';
import { cn } from '@/lib/utils';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { getReadableTextColor, resolveCssVarHex } from '@/lib/themeColors';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { Spinner } from '@/components/ui/spinner'
import { useResolvedIconDefinition } from '@/hooks/useResolvedIconDefinition';
import { Label } from '@/components/ui/label'
import { PRESET_ROLE_COLORS, ROLE_BADGE_STYLE_OPTIONS, type RoleBadgeStyle } from '@/components/roles/roleFormConstants'
import {
  faTag,
  faTags,
  faPenToSquare,
  faTrashCan,
  faCircleInfo,
  faTriangleExclamation,
  faList,
  faPalette,
  faAlignLeft,
  faIdBadge,
  faIcons,
  faStar,
  faXmark,
  faGrip,
  faPaintbrush,
  faCheck,
} from '@fortawesome/free-solid-svg-icons';
import type { FontAwesomeBrowserIcon } from '@/components/icons/FontAwesomeIconBrowser'

const FontAwesomeIconBrowser = lazy(() => import('@/components/icons/FontAwesomeIconBrowser'))

type RoleFormValues = {
  name: string;
  description: string;
  color: string;
  icon: string;
  badge_style: RoleBadgeStyle;
};

const isAutoManagedRole = (role: UserRole) => Boolean(role.is_auto_managed);

export const AdminSettingsUserRolesPage = () => {
  const navigate = useNavigate();
  const { roles, loading, error, refresh } = useUserRoles(false, true);
  const { success, error: showError } = useAlerts();
  const { theme } = useTheme();
  const iconInputRef = useRef<HTMLInputElement | null>(null)
  const themePrimaryHex = useMemo(
    () => resolveCssVarHex('--primary', '#3b82f6'),
    [theme]
  );
  const [modalOpen, setModalOpen] = useState(false);
  const [editingRole, setEditingRole] = useState<UserRole | null>(null);
  const [iconBrowseOpen, setIconBrowseOpen] = useState(false)
  const [formValues, setFormValues] = useState<RoleFormValues>({
    name: '',
    description: '',
    color: themePrimaryHex,
    icon: '',
    badge_style: 'default',
  });
  const [submitting, setSubmitting] = useState(false);
  const isDefaultColorSelected = formValues.color.toLowerCase() === themePrimaryHex.toLowerCase()
  const presetColors = PRESET_ROLE_COLORS

  const RoleIconCircle = ({ iconClass, color }: { iconClass?: string | null; color: string }) => {
    const resolved = useResolvedIconDefinition(iconClass);
    return (
      <FontAwesomeIcon icon={resolved ?? faTag} style={{ color }} />
    );
  };

  const handleCreate = () => {
    setEditingRole(null);
    setFormValues({
      name: '',
      description: '',
      color: themePrimaryHex,
      icon: '',
      badge_style: 'default',
    });
    setModalOpen(true);
  };

  const handleEdit = (role: UserRole) => {
    navigate({
      to: '/admin/settings/user-roles/$roleId/edit',
      params: { roleId: String(role.id) },
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);

    try {
      const endpoint = editingRole
        ? `/api/v2/user-roles/${editingRole.id}`
        : '/api/v2/user-roles';
      const method = editingRole ? 'PATCH' : 'POST';

      await requestJson(endpoint, {
        method,
        body: JSON.stringify(formValues),
      });

      success(editingRole ? 'Role updated successfully' : 'Role created successfully');
      setModalOpen(false);
      await refresh();
    } catch (err) {
      showError(`Failed to save role: ${(err as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (role: UserRole) => {
    if (isAutoManagedRole(role)) {
      showError(`Cannot delete the ${role.name} role`)
      return
    }
    if (!confirm(`Are you sure you want to delete "${role.name}"?`)) {
      return;
    }

    try {
      await requestJson(`/api/v2/user-roles/${role.id}`, {
        method: 'DELETE',
      });
      success('Role deleted successfully');
      await refresh();
    } catch (err) {
      showError(`Failed to delete role: ${(err as Error).message}`);
    }
  };

  const formId = 'user-role-form';

  const handleBrowseOpenChange = (nextOpen: boolean) => {
    setIconBrowseOpen(nextOpen)
  }

  const handleIconSelect = (icon: FontAwesomeBrowserIcon) => {
    const prefix =
      icon.prefix === 'brands' ? 'fa-brands' : icon.prefix === 'regular' ? 'fa-regular' : 'fa-solid'
    setFormValues((prev) => ({ ...prev, icon: `${prefix} fa-${icon.iconName}` }))
    setIconBrowseOpen(false)
  }

  const renderRoleForm = () => (
    <form id={formId} onSubmit={handleSubmit} className="space-y-6">
      <Alert variant="info">
        <FontAwesomeIcon icon={faCircleInfo} className="h-4 w-4" />
        <AlertTitle>Role Configuration</AlertTitle>
        <AlertDescription>
          Customize the role&apos;s name, description, and visual appearance. User roles are cosmetic and do not grant permissions.
        </AlertDescription>
      </Alert>

      <div className="space-y-4">
        <h4 className="flex items-center gap-2 text-lg font-medium">
          <FontAwesomeIcon icon={faIdBadge} className="text-sm text-primary" />
          Basic Settings
        </h4>

        <div className="rounded-lg border border-border bg-card p-4 transition-colors hover:border-border/60">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <FontAwesomeIcon icon={faTag} className="size-4 text-primary" />
              <Label htmlFor="name" className="font-medium">Role Name</Label>
              <UiBadge variant="destructive" className="text-xs">Required</UiBadge>
            </div>
          </div>
          <Input
            id="name"
            value={formValues.name}
            onChange={(event) => setFormValues((prev) => ({ ...prev, name: event.target.value }))}
            required
            className="h-11"
            placeholder="VIP Member"
          />
          <p className="mt-1 text-xs text-muted-foreground">A unique name for this visual role</p>
        </div>

        <div className="rounded-lg border border-border bg-card p-4 transition-colors hover:border-border/60">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <FontAwesomeIcon icon={faAlignLeft} className="size-4 text-sky-600 dark:text-sky-400" />
              <Label htmlFor="description" className="font-medium">Description</Label>
              <UiBadge variant="secondary" className="text-xs">Optional</UiBadge>
            </div>
          </div>
          <Textarea
            id="description"
            value={formValues.description}
            onChange={(event) => setFormValues((prev) => ({ ...prev, description: event.target.value }))}
            rows={3}
            className="min-h-[88px]"
            placeholder="Short description shown alongside the badge."
          />
          <p className="mt-1 text-xs text-muted-foreground">Displayed as helper text in role previews</p>
        </div>
      </div>

      <div className="space-y-4">
        <h4 className="flex items-center gap-2 text-lg font-medium">
          <FontAwesomeIcon icon={faPalette} className="text-sm text-amber-600 dark:text-amber-400" />
          Visual Appearance
        </h4>

        <div className="rounded-lg border border-border bg-card p-4 transition-colors hover:border-border/60">
          <div className="mb-3 space-y-1">
            <div className="flex items-center gap-2">
              <FontAwesomeIcon icon={faPalette} className="size-4 text-amber-600 dark:text-amber-400" />
              <Label className="font-medium">Role Color</Label>
            </div>
          </div>

          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              className={cn(
                'relative flex size-16 shrink-0 items-center justify-center rounded-md border transition-all',
                isDefaultColorSelected ? 'border-transparent' : 'border-transparent hover:border-border'
              )}
              style={{ backgroundColor: themePrimaryHex }}
              title="Default color"
              onClick={() => setFormValues((prev) => ({ ...prev, color: themePrimaryHex }))}
            >
              {isDefaultColorSelected && (
                <FontAwesomeIcon
                  icon={faCheck}
                  className="size-6 drop-shadow-sm"
                  style={{ color: getReadableTextColor(themePrimaryHex) }}
                />
              )}
              <span className="sr-only">Default color</span>
            </button>

            <div
              className={cn(
                'relative flex size-16 shrink-0 items-center justify-center rounded-md border transition-all',
                isDefaultColorSelected ? 'border-border/60 bg-transparent' : 'border-transparent shadow-sm'
              )}
              style={{ backgroundColor: isDefaultColorSelected ? 'transparent' : formValues.color }}
            >
              <FontAwesomeIcon
                icon={faPaintbrush}
                className="absolute right-1 top-1 size-4 drop-shadow-md"
                style={{ color: getReadableTextColor(formValues.color) }}
              />
              <Input
                id="color"
                type="color"
                value={formValues.color}
                onChange={(event) => setFormValues((prev) => ({ ...prev, color: event.target.value }))}
                className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                aria-label="Choose badge color"
              />
            </div>

            <div className="grid grid-cols-8 gap-1.5 pt-0.5 md:grid-cols-10">
              {presetColors.map((preset) => {
                const isSelected = preset.hex.toLowerCase() === formValues.color.toLowerCase();
                return (
                  <button
                    key={preset.hex}
                    type="button"
                    className={cn(
                      'relative flex size-7 items-center justify-center rounded-md transition-all',
                      isSelected ? 'scale-110 z-10' : 'hover:scale-110 hover:z-10'
                    )}
                    style={{ backgroundColor: preset.hex }}
                    title={preset.label}
                    onClick={() => setFormValues((prev) => ({ ...prev, color: preset.hex }))}
                  >
                    {isSelected && (
                      <FontAwesomeIcon
                        icon={faCheck}
                        className="size-4 drop-shadow-sm"
                        style={{ color: getReadableTextColor(preset.hex) }}
                      />
                    )}
                    <span className="sr-only">{preset.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Selected</span>
            <span className="font-mono uppercase">{formValues.color}</span>
          </div>
        </div>

        <div className="rounded-lg border border-border bg-card p-4 transition-colors hover:border-border/60">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <FontAwesomeIcon icon={faIcons} className="size-4 text-indigo-600 dark:text-indigo-400" />
              <Label htmlFor="icon" className="font-medium">Icon</Label>
              <UiBadge variant="secondary" className="text-xs">Optional</UiBadge>
            </div>
          </div>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Input
                id="icon"
                ref={iconInputRef}
                value={formValues.icon}
                onChange={(event) => setFormValues((prev) => ({ ...prev, icon: event.target.value }))}
                placeholder="e.g. fa-solid fa-star"
                className="h-11 pr-10 font-mono text-xs"
              />
              {formValues.icon && (
                <button
                  type="button"
                  onClick={() => setFormValues((prev) => ({ ...prev, icon: '' }))}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  <FontAwesomeIcon icon={faXmark} className="size-4" />
                </button>
              )}
            </div>
            <Button variant="outline" className="h-11 gap-2" type="button" onClick={() => handleBrowseOpenChange(true)}>
              <FontAwesomeIcon icon={faGrip} className="size-4" />
              Browse Icons
            </Button>
            <Suspense
              fallback={(
                <ResponsiveDialog
                  open={iconBrowseOpen}
                  onOpenChange={handleBrowseOpenChange}
                  title="Browse icons"
                  description="Choose a Font Awesome style and icon."
                >
                  <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
                    Loading icon browser...
                  </div>
                </ResponsiveDialog>
              )}
            >
              <FontAwesomeIconBrowser
                open={iconBrowseOpen}
                onOpenChange={handleBrowseOpenChange}
                onSelect={handleIconSelect}
                renderStyleBadge={({ isActive, label, StyleIcon }) => (
                  <Badge
                    color={isActive ? 'bg-primary' : 'bg-muted/60'}
                    className={cn(
                      'rounded-full px-3 py-1 text-xs font-medium gap-1',
                      isActive ? 'text-primary-foreground' : 'text-muted-foreground'
                    )}
                    hover={false}
                  >
                    <StyleIcon className="text-[0.65rem]" />
                    {label}
                  </Badge>
                )}
              />
            </Suspense>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Search and select an icon from the FontAwesome library.
          </p>
        </div>

        <div className="rounded-lg border border-border bg-card p-4 transition-colors hover:border-border/60">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <FontAwesomeIcon icon={faStar} className="size-4 text-purple-600 dark:text-purple-400" />
              <Label className="font-medium">Badge Style</Label>
            </div>
            <UiBadge variant="secondary" className="text-xs">Optional</UiBadge>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            {ROLE_BADGE_STYLE_OPTIONS.map((option) => {
              const isSelected = formValues.badge_style === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setFormValues((prev) => ({ ...prev, badge_style: option.value }))}
                  aria-pressed={isSelected}
                  className={cn(
                    'flex flex-col items-start gap-2 rounded-lg border p-3 text-left transition',
                    isSelected
                      ? 'border-primary bg-primary/5 shadow-sm'
                      : 'border-border bg-muted/30 hover:border-border/60'
                  )}
                >
                  <Badge
                    hexColor={formValues.color}
                    iconClass={formValues.icon || null}
                    roleKind="user"
                    badgeStyle={option.value}
                    className="rounded-full px-3 py-1 text-xs"
                    hover={false}
                  >
                    {formValues.name || 'Role Name'}
                  </Badge>
                  <div>
                    <div className="text-xs font-semibold text-foreground">{option.label}</div>
                    <div className="text-[10px] text-muted-foreground">{option.description}</div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="rounded-lg border border-dashed border-border bg-muted/40 p-4">
          <p className="text-xs font-medium uppercase text-muted-foreground">Live preview</p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Badge
              hexColor={formValues.color}
              iconClass={formValues.icon || null}
              roleKind="user"
              badgeStyle={formValues.badge_style}
              className="rounded-full px-3 py-1 text-sm shadow-sm"
              hover={false}
            >
              {formValues.name || 'Role Name'}
            </Badge>
            <span className="text-xs text-muted-foreground">
              {formValues.description || 'Description preview text'}
            </span>
          </div>
        </div>
      </div>
    </form>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="User Roles"
        description="Manage visual/cosmetic roles for users (badges, colors)"
        actions={
          <Button size="sm" onClick={handleCreate}>
            Create Role
          </Button>
        }
      />

      {error && (
        <Alert variant="destructive">
          <FontAwesomeIcon icon={faTriangleExclamation} className="h-4 w-4" />
          <AlertTitle>Unable to load roles</AlertTitle>
          <AlertDescription>{(error as Error).message}</AlertDescription>
        </Alert>
      )}

      <Alert variant="info">
        <FontAwesomeIcon icon={faCircleInfo} className="h-4 w-4" />
        <AlertTitle>Visual roles only</AlertTitle>
        <AlertDescription>
          User roles are cosmetic and do not grant permissions. Use Admin Roles to manage access
          levels.
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/20">
              <FontAwesomeIcon icon={faList} className="size-5 text-primary" />
            </div>
            <div>
              <CardTitle className="mb-1 text-xl font-semibold">Existing Roles</CardTitle>
              <CardDescription>Badges and colors available to assign to users</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Spinner className="size-4 text-muted-foreground" />
            </div>
          ) : (
            <div className="w-full min-w-0 rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Role</TableHead>
                    <TableHead>Color</TableHead>
                    <TableHead>Members</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {roles.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="py-8 text-center">
                        <div className="text-muted-foreground">
                          <FontAwesomeIcon icon={faTags} className="mb-2 text-2xl text-muted-foreground/30" />
                          <p className="text-sm">No user roles found. Create roles to assign visual badges to users.</p>
                        </div>
                      </TableCell>
                    </TableRow>
                  ) : (
                    roles.map((role) => (
                      <TableRow key={role.id}>
                        <TableCell>
                          <div className="flex items-center gap-3">
                            <div
                              className="flex size-10 shrink-0 items-center justify-center rounded-full border-2"
                              style={{
                                backgroundColor: `${role.color || '#808080'}20`,
                                borderColor: `${role.color || '#808080'}40`,
                              }}
                            >
                              <RoleIconCircle iconClass={role.icon} color={role.color || '#808080'} />
                            </div>
                            <div>
                              <div className="flex items-center gap-2">
                                <div className="font-medium">{role.name}</div>
                                {isAutoManagedRole(role) && (
                                  <UiBadge variant="secondary">Auto-managed</UiBadge>
                                )}
                              </div>
                              {role.description && (
                                <p className="text-sm text-muted-foreground">{role.description}</p>
                              )}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          {role.color ? (
                            <div className="flex items-center gap-2">
                              <span
                                className="size-6 rounded-full border-2 border-border"
                                style={{ backgroundColor: role.color }}
                              />
                              <span className="font-mono text-xs text-muted-foreground">{role.color}</span>
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">Default</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <span className="text-sm text-muted-foreground">
                            {role.user_count || 0}
                          </span>
                        </TableCell>
                        <TableCell>
                          <span className="text-sm text-muted-foreground">
                            {new Date(role.created_at).toLocaleDateString()}
                          </span>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-2">
                            <Button variant="ghost" size="sm" onClick={() => handleEdit(role)}>
                              <FontAwesomeIcon icon={faPenToSquare} className="mr-1 size-3" />
                              <span className="hidden md:inline">Edit</span>
                            </Button>
                            {!isAutoManagedRole(role) && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-destructive hover:bg-destructive/10"
                                onClick={() => handleDelete(role)}
                              >
                                <FontAwesomeIcon icon={faTrashCan} className="mr-1 size-3" />
                                <span className="hidden md:inline">Delete</span>
                              </Button>
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

      <ResponsiveDialog
        open={modalOpen}
        onOpenChange={setModalOpen}
        title={editingRole ? 'Edit User Role' : 'Create User Role'}
        contentClassName="max-w-4xl"
        footer={[
          <Button
            key="cancel"
            type="button"
            variant="outline"
            onClick={() => setModalOpen(false)}
            disabled={submitting}
          >
            Cancel
          </Button>,
          <Button key="save" type="submit" form={formId} disabled={submitting}>
            {submitting ? 'Saving…' : editingRole ? 'Update Role' : 'Create Role'}
          </Button>,
        ]}
      >
        {renderRoleForm()}
      </ResponsiveDialog>
    </div>
  );
};

export default AdminSettingsUserRolesPage;
