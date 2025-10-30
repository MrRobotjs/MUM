export default function SetupPluginsPage() {
  return (
    <div className="container mx-auto max-w-2xl p-6">
      <h1 className="text-2xl font-semibold mb-2">Service Plugins</h1>
      <p className="text-sm text-gray-500 mb-6">
        Enable and configure your media service plugins, then add servers.
      </p>

      <div className="card bg-base-200">
        <div className="card-body">
          <p className="mb-4">
            Continue to the Plugins settings to enable Plex, Jellyfin, or Emby and add your server(s).
          </p>
          <a className="btn btn-primary" href="/admin/settings/plugins">
            Open Plugins Settings
          </a>
        </div>
      </div>
    </div>
  );
}

