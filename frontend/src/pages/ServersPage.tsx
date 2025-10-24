import { useState } from 'react';
import { useServers, type Server } from '../hooks/useServers';
import { ServerModal, type ServerFormValues } from '../components/servers/ServerModal';
import { Table, type Column, Button, PageHeader } from '../components';
import { requestJson } from '../util/apiClient';
import { useAlerts } from '../contexts';

const buildServerPayload = (values: ServerFormValues) => {
  const payload: Record<string, unknown> = {
    server_nickname: values.server_nickname,
    server_name: values.server_name || null,
    service_type: values.service_type,
    url: values.url,
    public_url: values.public_url || null,
    is_active: values.is_active,
    overseerr_enabled: values.overseerr_enabled ?? false,
    overseerr_url: values.overseerr_url || null,
  };

  if (values.api_key) {
    payload.api_key = values.api_key;
  }

  if (values.overseerr_api_key) {
    payload.overseerr_api_key = values.overseerr_api_key;
  }

  if (values.service_type === 'plex') {
    payload.websocket_refresh_interval = values.websocket_refresh_interval ?? 30;
  }

  return payload;
};

export const ServersPage = () => {
  const { servers, loading, error, refresh } = useServers({ includeStatus: true });
  const { success, error: showError } = useAlerts();
  const [modalOpen, setModalOpen] = useState(false);
  const [editingServer, setEditingServer] = useState<Server | null>(null);
  const [actionLoading, setActionLoading] = useState<number | null>(null);

  const handleCreate = () => {
    setEditingServer(null);
    setModalOpen(true);
  };

  const handleEdit = (server: Server) => {
    setEditingServer(server);
    setModalOpen(true);
  };

  const handleSubmit = async (values: ServerFormValues) => {
    const endpoint = editingServer
      ? `/admin/api/v1/servers/${editingServer.id}`
      : '/admin/api/v1/servers';
    const method = editingServer ? 'PATCH' : 'POST';

    await requestJson(endpoint, {
      method,
      body: JSON.stringify(buildServerPayload(values)),
    });

    success(editingServer ? 'Server updated successfully' : 'Server created successfully');
    await refresh();
  };

  const handleDelete = async (server: Server) => {
    if (!confirm(`Are you sure you want to delete "${server.server_nickname}"?`)) {
      return;
    }

    try {
      await requestJson(`/admin/api/v1/servers/${server.id}`, {
        method: 'DELETE',
      });
      success('Server deleted successfully');
      await refresh();
    } catch (err) {
      showError(`Failed to delete server: ${(err as Error).message}`);
    }
  };

  const handleSyncLibraries = async (server: Server) => {
    setActionLoading(server.id);
    try {
      await requestJson(`/admin/api/v1/servers/${server.id}/sync-libraries`, {
        method: 'POST',
      });
      success('Library sync started');
      await refresh();
    } catch (err) {
      showError(`Failed to sync libraries: ${(err as Error).message}`);
    } finally {
      setActionLoading(null);
    }
  };

  const handleSyncUsers = async (server: Server) => {
    setActionLoading(server.id);
    try {
      await requestJson(`/admin/api/v1/servers/${server.id}/sync-users`, {
        method: 'POST',
      });
      success('User sync started');
      await refresh();
    } catch (err) {
      showError(`Failed to sync users: ${(err as Error).message}`);
    } finally {
      setActionLoading(null);
    }
  };

  const handleTestConnection = async (server: Server) => {
    setActionLoading(server.id);
    try {
      const response = await requestJson<{ data: { online: boolean; server_info?: unknown } }>(
        `/admin/api/v1/servers/${server.id}/test`,
        { method: 'POST' }
      );
      if (response.data?.online) {
        success('Connection test successful');
      } else {
        showError('Connection test failed - server appears offline');
      }
    } catch (err) {
      showError(`Connection test failed: ${(err as Error).message}`);
    } finally {
      setActionLoading(null);
    }
  };

  const columns: Column<Server>[] = [
    {
      key: 'server_nickname',
      header: 'Nickname',
      sortable: true,
      render: (server) => (
        <div>
          <div className="font-medium">{server.server_nickname}</div>
          {server.server_name && (
            <div className="text-xs text-base-content/60">{server.server_name}</div>
          )}
        </div>
      ),
    },
    {
      key: 'service_type',
      header: 'Type',
      sortable: true,
      render: (server) => (
        <span className="badge badge-outline uppercase">{server.service_type}</span>
      ),
    },
    {
      key: 'url',
      header: 'URL',
      render: (server) => (
        <a
          href={server.url}
          target="_blank"
          rel="noopener noreferrer"
          className="link link-primary text-sm"
        >
          {server.url}
        </a>
      ),
    },
    {
      key: 'is_active',
      header: 'Status',
      render: (server) => (
        <span
          className={`badge ${server.is_active ? 'badge-success' : 'badge-error'}`}
        >
          {server.is_active ? 'Active' : 'Inactive'}
        </span>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      render: (server) => (
        <div className="flex items-center gap-1">
          <Button
            size="xs"
            variant="ghost"
            onClick={() => handleTestConnection(server)}
            disabled={actionLoading === server.id}
          >
            {actionLoading === server.id ? '...' : 'Test'}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => handleSyncLibraries(server)}
            disabled={actionLoading === server.id}
          >
            Sync Libs
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => handleSyncUsers(server)}
            disabled={actionLoading === server.id}
          >
            Sync Users
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => handleEdit(server)}
          >
            Edit
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => handleDelete(server)}
          >
            Delete
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Media Servers"
        description="Manage your Plex, Jellyfin, Emby, and other media server connections"
        actions={
          <Button variant="primary" size="sm" onClick={handleCreate}>
            Add Server
          </Button>
        }
      />

      {error && (
        <div className="alert alert-error">
          <span>Failed to load servers: {(error as Error).message}</span>
        </div>
      )}

      <div className="rounded-xl border border-base-300 bg-base-100 p-4 shadow-sm">
        <Table
          data={servers}
          columns={columns}
          keyExtractor={(server) => server.id}
          loading={loading}
          emptyMessage="No servers configured. Add your first server to get started."
          hoverable
          size="sm"
        />
      </div>

      <ServerModal
        open={modalOpen}
        onClose={() => {
          setModalOpen(false);
          setEditingServer(null);
        }}
        initialValues={editingServer || undefined}
        onSubmit={handleSubmit}
      />
    </div>
  );
};

export default ServersPage;
