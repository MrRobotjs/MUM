import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  IconInfoCircle,
  IconAlertTriangle,
  IconList,
  IconPalette,
  IconDroplet,
  IconSparkles,
} from '@tabler/icons-react';

import { useUserRoles, type UserRole } from '../hooks/useUserRoles';
import { PageHeader } from '../components';
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
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
import { useAlerts } from '../contexts';
import { cn } from '@/lib/utils';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';

type RoleFormValues = {
  name: string;
  description: string;
  color: string;
  icon: string;
};

const presetColors: Array<{ hex: string; label: string }> = [
  { hex: '#f04747', label: 'Red' },
  { hex: '#faa61a', label: 'Orange' },
  { hex: '#fee75c', label: 'Yellow' },
  { hex: '#57f287', label: 'Green' },
  { hex: '#5865f2', label: 'Blurple' },
  { hex: '#eb459e', label: 'Pink' },
  { hex: '#9c84ef', label: 'Purple' },
  { hex: '#808080', label: 'Gray' },
];

const isAutoManagedRole = (role: UserRole) => Boolean(role.is_auto_managed);

const getTextColorForBackground = (hex: string) => {
  const sanitized = hex.replace('#', '');
  if (sanitized.length !== 6) return '#ffffff';
  const r = parseInt(sanitized.slice(0, 2), 16);
  const g = parseInt(sanitized.slice(2, 4), 16);
  const b = parseInt(sanitized.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? '#111827' : '#ffffff';
};

export const AdminSettingsUserRolesPage = () => {
  const navigate = useNavigate();
  const { roles, loading, error, refresh } = useUserRoles(false);
  const { success, error: showError } = useAlerts();
  const [modalOpen, setModalOpen] = useState(false);
  const [editingRole, setEditingRole] = useState<UserRole | null>(null);
  const [formValues, setFormValues] = useState<RoleFormValues>({
    name: '',
    description: '',
    color: '#3b82f6',
    icon: '',
  });
  const [submitting, setSubmitting] = useState(false);

  const handleCreate = () => {
    setEditingRole(null);
    setFormValues({
      name: '',
      description: '',
      color: '#3b82f6',
      icon: '',
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
        ? `/admin/api/v2/user-roles/${editingRole.id}`
        : '/admin/api/v2/user-roles';
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
      await requestJson(`/admin/api/v2/user-roles/${role.id}`, {
        method: 'DELETE',
      });
      success('Role deleted successfully');
      await refresh();
    } catch (err) {
      showError(`Failed to delete role: ${(err as Error).message}`);
    }
  };

  const formId = 'user-role-form';

  const renderRoleForm = () => (
    <form id={formId} onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-2">
        <label className="text-sm font-medium text-foreground" htmlFor="name">
          Role Name
        </label>
        <Input
          id="name"
          value={formValues.name}
          onChange={(event) =>
            setFormValues({ ...formValues, name: event.target.value })
          }
          required
          placeholder="VIP Member"
        />
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium text-foreground" htmlFor="description">
          Description
        </label>
        <Textarea
          id="description"
          value={formValues.description}
          onChange={(event) =>
            setFormValues({ ...formValues, description: event.target.value })
          }
          placeholder="Short description shown alongside the badge."
          rows={3}
        />
      </div>

      <div className="space-y-3">
        <label className="text-sm font-medium text-foreground" htmlFor="color">
          Color
        </label>
        <div className="rounded-lg border border-border bg-muted/40 p-4">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-4">
              <span
                className="flex size-12 items-center justify-center rounded-full border border-white/40 shadow"
                style={{ backgroundColor: formValues.color }}
              >
                <IconDroplet className="h-6 w-6 text-white/80 drop-shadow" />
              </span>
              <div className="space-y-1">
                <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <IconPalette className="h-4 w-4" />
                  Selected Color
                </div>
                <p className="font-mono text-xs uppercase text-muted-foreground">
                  {formValues.color}
                </p>
              </div>
            </div>
            <Input
              id="color"
              type="color"
              value={formValues.color}
              onChange={(event) =>
                setFormValues({ ...formValues, color: event.target.value })
              }
              className="h-12 w-20 cursor-pointer rounded-md border border-border bg-background p-1 shadow-sm sm:h-10"
              aria-label="Custom color picker"
            />
          </div>

          <div className="mt-4">
            <p className="text-xs font-medium uppercase text-muted-foreground">
              Preset colors
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {presetColors.map((preset) => {
                const isSelected = preset.hex.toLowerCase() === formValues.color.toLowerCase();
                return (
                  <button
                    key={preset.hex}
                    type="button"
                    className={cn(
                      'flex size-9 items-center justify-center rounded-full border-2 transition',
                      isSelected
                        ? 'border-primary ring-2 ring-primary/40'
                        : 'border-transparent hover:border-border'
                    )}
                    style={{ backgroundColor: preset.hex }}
                    title={preset.label}
                    onClick={() => setFormValues({ ...formValues, color: preset.hex })}
                  >
                    <span className="sr-only">{preset.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium text-foreground" htmlFor="icon">
          Icon (FontAwesome)
        </label>
        <Input
          id="icon"
          value={formValues.icon}
          onChange={(event) =>
            setFormValues({ ...formValues, icon: event.target.value })
          }
          placeholder="fa-star"
        />
        <p className="text-xs text-muted-foreground">
          Use FontAwesome class names (e.g., fa-star, fa-crown).
        </p>
      </div>

      <div className="rounded-lg border border-dashed border-border bg-muted/40 p-4">
        <p className="text-xs font-medium uppercase text-muted-foreground">Live preview</p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <span
            className="inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-medium shadow-sm"
            style={{
              backgroundColor: formValues.color,
              color: getTextColorForBackground(formValues.color),
            }}
          >
            {formValues.icon ? <i className={`fa-solid ${formValues.icon}`} /> : <IconSparkles className="h-4 w-4" />}
            {formValues.name || 'Role Name'}
          </span>
          <span className="text-xs text-muted-foreground">
            {formValues.description || 'Description preview text'}
          </span>
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
          <IconAlertTriangle />
          <AlertTitle>Unable to load roles</AlertTitle>
          <AlertDescription>{(error as Error).message}</AlertDescription>
        </Alert>
      )}

      <Alert variant="info">
        <IconInfoCircle />
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
              <IconList className="size-5 text-primary" />
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
              <span className="inline-flex size-4 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border">
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
                          <i className="fa-solid fa-tags mb-2 text-2xl text-muted-foreground/30" />
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
                              {role.icon ? (
                                <i className={`fa-solid ${role.icon}`} style={{ color: role.color || '#808080' }} />
                              ) : (
                                <i className="fa-solid fa-tag" style={{ color: role.color || '#808080' }} />
                              )}
                            </div>
                            <div>
                              <div className="font-medium">{role.name}</div>
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
                              <i className="fa-solid fa-pen-to-square mr-1 size-3" />
                              <span className="hidden md:inline">Edit</span>
                            </Button>
                            {!isAutoManagedRole(role) && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-destructive hover:bg-destructive/10"
                                onClick={() => handleDelete(role)}
                              >
                                <i className="fa-solid fa-trash-can mr-1 size-3" />
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
        description="Define a visual badge that can be assigned to users."
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
