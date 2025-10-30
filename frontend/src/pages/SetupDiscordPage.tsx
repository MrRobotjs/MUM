export default function SetupDiscordPage() {
  return (
    <div className="container mx-auto max-w-2xl p-6">
      <h1 className="text-2xl font-semibold mb-2">Discord Configuration</h1>
      <p className="text-sm text-gray-500 mb-6">
        Discord OAuth is optional. Configure it if you want invitees to link their Discord accounts.
      </p>

      <div className="card bg-base-200">
        <div className="card-body">
          <p className="mb-4">
            Configure Discord in the admin settings once your app base URL is set.
          </p>
          <a className="btn btn-primary" href="/admin/settings/discord">
            Open Discord Settings
          </a>
        </div>
      </div>
    </div>
  );
}

