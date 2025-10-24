import { useEffect, useState } from 'react';
import { Button } from '../index';

export type UserSettings = {
  uuid: string;
  notes?: string;
  is_active: boolean;
  is_discord_bot_whitelisted?: boolean;
  is_purge_whitelisted?: boolean;
  allow_downloads?: boolean;
  allow_4k_transcode?: boolean;
  access_expires_at?: string | null;
  libraries?: Array<{ id: string; name: string; selected: boolean }>;
};

type UserSettingsCardProps = {
  settings: UserSettings | null;
  loading?: boolean;
  error?: Error | null;
  onSave: (settings: Partial<UserSettings>) => Promise<void> | void;
};

export const UserSettingsCard = ({ settings, loading, error, onSave }: UserSettingsCardProps) => {
  const [notes, setNotes] = useState(settings?.notes ?? '');
  const [isDiscordBotWhitelisted, setIsDiscordBotWhitelisted] = useState(settings?.is_discord_bot_whitelisted ?? false);
  const [isPurgeWhitelisted, setIsPurgeWhitelisted] = useState(settings?.is_purge_whitelisted ?? false);
  const [allowDownloads, setAllowDownloads] = useState(settings?.allow_downloads ?? false);
  const [allow4kTranscode, setAllow4kTranscode] = useState(settings?.allow_4k_transcode ?? false);
  const [accessExpiration, setAccessExpiration] = useState(settings?.access_expires_at ?? '');
  const [clearAccessExpiration, setClearAccessExpiration] = useState(false);
  const [selectedLibraries, setSelectedLibraries] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (settings) {
      setNotes(settings.notes ?? '');
      setIsDiscordBotWhitelisted(settings.is_discord_bot_whitelisted ?? false);
      setIsPurgeWhitelisted(settings.is_purge_whitelisted ?? false);
      setAllowDownloads(settings.allow_downloads ?? false);
      setAllow4kTranscode(settings.allow_4k_transcode ?? false);
      setAccessExpiration(settings.access_expires_at ?? '');

      if (settings.libraries) {
        const selected = new Set(settings.libraries.filter((lib) => lib.selected).map((lib) => lib.id));
        setSelectedLibraries(selected);
      }
    }
  }, [settings]);

  useEffect(() => {
    if (clearAccessExpiration) {
      setAccessExpiration('');
    }
  }, [clearAccessExpiration]);

  if (loading) {
    return (
      <section className="card border border-base-300 bg-base-100 shadow-sm">
        <div className="card-body">
          <div className="flex items-center gap-2 text-sm text-base-content/60">
            <span className="loading loading-spinner loading-sm" />
            Loading user settings…
          </div>
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <section className="card border border-base-300 bg-base-100 shadow-sm">
        <div className="card-body text-sm text-error">Failed to load settings: {error.message}</div>
      </section>
    );
  }

  const handleSelectAllLibraries = () => {
    if (settings?.libraries) {
      const allIds = new Set(settings.libraries.map((lib) => lib.id));
      setSelectedLibraries(allIds);
    }
  };

  const handleDeselectAllLibraries = () => {
    setSelectedLibraries(new Set());
  };

  const handleToggleLibrary = (libraryId: string) => {
    setSelectedLibraries((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(libraryId)) {
        newSet.delete(libraryId);
      } else {
        newSet.add(libraryId);
      }
      return newSet;
    });
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      const payload: Partial<UserSettings> = {
        notes,
        is_discord_bot_whitelisted: isDiscordBotWhitelisted,
        is_purge_whitelisted: isPurgeWhitelisted,
        allow_downloads: allowDownloads,
        allow_4k_transcode: allow4kTranscode
      };

      if (clearAccessExpiration) {
        payload.access_expires_at = null;
      } else if (accessExpiration) {
        payload.access_expires_at = accessExpiration;
      }

      if (settings?.libraries) {
        payload.libraries = settings.libraries.map((lib) => ({
          ...lib,
          selected: selectedLibraries.has(lib.id)
        }));
      }

      await onSave(payload);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Notes Section */}
      <div className="bg-base-100 border border-base-300 rounded-lg shadow-sm overflow-hidden">
        <div className="bg-gradient-to-r from-yellow-50 dark:from-yellow-900/20 to-yellow-100 dark:to-yellow-800/20 p-4 border-b border-base-300">
          <h3 className="text-lg font-semibold flex items-center gap-2">
            <i className="fa-solid fa-sticky-note text-yellow-600 dark:text-yellow-400" />
            Notes & Comments
          </h3>
        </div>
        <div className="p-4">
          <div className="form-control">
            <label className="label" htmlFor="notes">
              <span className="label-text">Notes</span>
            </label>
            <span className="label-text text-sm text-base-content/70 mb-2 block">
              Add personal notes or important information about this user
            </span>
            <textarea
              id="notes"
              className="textarea textarea-bordered h-24 w-full bg-base-50 dark:bg-base-800/50 border-base-300 focus:border-primary focus:ring-2 focus:ring-primary/20"
              placeholder="Add any notes about this user..."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
            <p className="text-xs text-base-content/60 mt-2">Administrative notes are only visible to administrators</p>
          </div>
        </div>
      </div>

      {/* User Permissions Section */}
      <div className="bg-base-100 border border-base-300 rounded-lg shadow-sm overflow-hidden">
        <div className="bg-gradient-to-r from-blue-50 dark:from-blue-900/20 to-blue-100 dark:to-blue-800/20 p-4 border-b border-base-300">
          <h3 className="text-lg font-semibold flex items-center gap-2">
            <i className="fa-solid fa-user-cog text-blue-600 dark:text-blue-400" />
            User Permissions
          </h3>
        </div>
        <div className="p-4 space-y-4">
          {/* Discord Bot Whitelist */}
          <div className="p-4 rounded-lg border border-purple-200 dark:border-purple-500/30 bg-purple-50 dark:bg-purple-900/20">
            <div className="flex items-center justify-between">
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-2">
                  <i className="fa-brands fa-discord text-purple-600 dark:text-purple-400" />
                  <h5 className="font-medium text-purple-700 dark:text-purple-300">Discord Bot Whitelisted</h5>
                </div>
                <p className="text-sm text-purple-600 dark:text-purple-400">
                  Allow this user to interact with Discord bot features
                </p>
              </div>
              <input
                type="checkbox"
                className="toggle toggle-primary ml-4"
                checked={isDiscordBotWhitelisted}
                onChange={(e) => setIsDiscordBotWhitelisted(e.target.checked)}
              />
            </div>
          </div>

          {/* Purge Whitelist */}
          <div className="p-4 rounded-lg border border-yellow-200 dark:border-yellow-500/30 bg-yellow-50 dark:bg-yellow-900/20">
            <div className="flex items-center justify-between">
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-2">
                  <i className="fa-solid fa-shield text-yellow-600 dark:text-yellow-400" />
                  <h5 className="font-medium text-yellow-700 dark:text-yellow-300">Purge Whitelisted</h5>
                </div>
                <p className="text-sm text-yellow-600 dark:text-yellow-400">
                  Protect this user from automatic inactivity purges
                </p>
              </div>
              <input
                type="checkbox"
                className="toggle toggle-primary ml-4"
                checked={isPurgeWhitelisted}
                onChange={(e) => setIsPurgeWhitelisted(e.target.checked)}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Stream Permissions Section */}
      <div className="bg-base-100 border border-base-300 rounded-lg shadow-sm overflow-hidden">
        <div className="bg-gradient-to-r from-green-50 dark:from-green-900/20 to-green-100 dark:to-green-800/20 p-4 border-b border-base-300">
          <h3 className="text-lg font-semibold flex items-center gap-2">
            <i className="fa-solid fa-play text-green-600 dark:text-green-400" />
            Stream Permissions
          </h3>
        </div>
        <div className="p-4 space-y-4">
          {/* Downloads Permission (Disabled) */}
          <div className="p-4 rounded-lg border border-gray-200 dark:border-gray-500/30 bg-gray-50 dark:bg-gray-900/20 opacity-60 relative">
            <div className="absolute top-2 right-2">
              <div
                className="tooltip tooltip-left"
                data-tip="This setting can't be changed here due to a Plex API limitation. Please update 'Allow Sync' directly in Plex for now."
              >
                <i className="fa-solid fa-info-circle text-orange-500" />
              </div>
            </div>
            <div className="flex items-center justify-between pointer-events-none">
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-2">
                  <i className="fa-solid fa-download text-gray-500" />
                  <h5 className="font-medium text-gray-600 dark:text-gray-400">Allow Downloads</h5>
                </div>
                <p className="text-sm text-gray-500 dark:text-gray-500">
                  Allow user to download content for offline viewing
                </p>
              </div>
              <input type="checkbox" className="toggle toggle-primary ml-4" checked={allowDownloads} disabled />
            </div>
          </div>

          {/* 4K Transcode Permission */}
          <div className="p-4 rounded-lg border border-green-200 dark:border-green-500/30 bg-green-50 dark:bg-green-900/20">
            <div className="flex items-center justify-between">
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-2">
                  <i className="fa-solid fa-video text-green-600 dark:text-green-400" />
                  <h5 className="font-medium text-green-700 dark:text-green-300">Allow 4K Transcode</h5>
                </div>
                <p className="text-sm text-green-600 dark:text-green-400">
                  Allow transcoding of 4K content (high server load)
                </p>
              </div>
              <input
                type="checkbox"
                className="toggle toggle-primary ml-4"
                checked={allow4kTranscode}
                onChange={(e) => setAllow4kTranscode(e.target.checked)}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Access Duration Section */}
      <div className="bg-base-100 border border-base-300 rounded-lg shadow-sm overflow-hidden">
        <div className="bg-gradient-to-r from-red-50 dark:from-red-900/20 to-red-100 dark:to-red-800/20 p-4 border-b border-base-300">
          <h3 className="text-lg font-semibold flex items-center gap-2">
            <i className="fa-solid fa-calendar-times text-red-600 dark:text-red-400" />
            Access Expiration
          </h3>
        </div>
        <div className="p-4 space-y-4">
          {/* Info Banner */}
          <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-500/30 rounded-lg p-3">
            <div className="flex items-start gap-2">
              <i className="fa-solid fa-info-circle text-blue-600 dark:text-blue-400 mt-0.5" />
              <div className="text-sm text-blue-700 dark:text-blue-300">
                <p className="font-medium mb-1">Automatic Access Control</p>
                <p>Set an expiration date to automatically revoke user access. Leave blank for permanent access.</p>
              </div>
            </div>
          </div>

          {/* Access Expiration Input */}
          <div className="form-control">
            <label className="label" htmlFor="access_expiration">
              <span className="label-text">Access Expiration</span>
            </label>
            <span className="label-text text-sm text-base-content/70 mb-2 block">
              Choose when this user's access should expire
            </span>
            <input
              type="date"
              id="access_expiration"
              className="input input-bordered w-full max-w-sm bg-base-50 dark:bg-base-800/50 border-base-300 focus:border-primary focus:ring-2 focus:ring-primary/20"
              value={accessExpiration}
              onChange={(e) => setAccessExpiration(e.target.value)}
              disabled={clearAccessExpiration}
            />
            <p className="text-xs text-base-content/60 mt-2">
              User access will be automatically revoked at midnight on this date
            </p>
          </div>

          {/* Clear Expiration Option */}
          <div className="p-3 rounded-lg border border-orange-200 dark:border-orange-500/30 bg-orange-50 dark:bg-orange-900/20">
            <div className="form-control">
              <label className="label cursor-pointer justify-start">
                <input
                  type="checkbox"
                  className="checkbox checkbox-primary mr-3"
                  checked={clearAccessExpiration}
                  onChange={(e) => setClearAccessExpiration(e.target.checked)}
                />
                <div className="flex flex-col">
                  <span className="label-text font-medium">Clear Access Expiration</span>
                  <span className="text-xs text-orange-700 dark:text-orange-300">
                    Remove any existing expiration date and grant permanent access
                  </span>
                </div>
              </label>
            </div>
          </div>
        </div>
      </div>

      {/* Library Access Section */}
      {settings?.libraries && settings.libraries.length > 0 ? (
        <div className="bg-base-100 border border-base-300 rounded-lg shadow-sm overflow-hidden">
          <div className="bg-gradient-to-r from-primary/5 to-primary/10 p-4 border-b border-base-300">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold flex items-center gap-2">
                <i className="fa-solid fa-folder-open text-primary" />
                Library Access
              </h3>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleSelectAllLibraries}
                  className="inline-flex items-center rounded-md bg-green-50 dark:bg-green-400/10 px-2 py-1 text-xs font-medium text-green-700 dark:text-green-400 ring-1 ring-inset ring-green-600/20 dark:ring-green-500/20 gap-1 hover:bg-green-100 dark:hover:bg-green-400/20 transition-colors"
                >
                  <i className="fa-solid fa-check-square w-3 h-3" />
                  Select All
                </button>
                <button
                  type="button"
                  onClick={handleDeselectAllLibraries}
                  className="inline-flex items-center rounded-md bg-gray-50 dark:bg-gray-400/10 px-2 py-1 text-xs font-medium text-gray-700 dark:text-gray-400 ring-1 ring-inset ring-gray-600/20 dark:ring-gray-500/20 gap-1 hover:bg-gray-100 dark:hover:bg-gray-400/20 transition-colors"
                >
                  <i className="fa-solid fa-square w-3 h-3" />
                  Clear All
                </button>
              </div>
            </div>
          </div>
          <div className="p-4">
            <div className="space-y-4">
              {/* Header info */}
              <div className="flex items-center justify-between p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-500/30 rounded-lg">
                <div className="flex items-center gap-2">
                  <i className="fa-solid fa-folder w-4 h-4 text-blue-600 dark:text-blue-400" />
                  <span className="text-sm font-medium text-blue-700 dark:text-blue-300">
                    {settings.libraries.length} libraries available
                  </span>
                </div>
                <span className="text-xs text-blue-600 dark:text-blue-400">Select which libraries this user can access</span>
              </div>

              {/* Library list */}
              <div className="max-h-80 overflow-y-auto border border-base-300 rounded-lg bg-base-50 dark:bg-base-800/50">
                {settings.libraries.map((library) => (
                  <div key={library.id} className="form-control border-b border-base-300 last:border-b-0">
                    <label className="label cursor-pointer justify-start py-3 px-4 hover:bg-base-100 dark:hover:bg-base-700/50 transition-colors">
                      <input
                        type="checkbox"
                        className="checkbox checkbox-primary checkbox-sm"
                        checked={selectedLibraries.has(library.id)}
                        onChange={() => handleToggleLibrary(library.id)}
                      />
                      <div className="flex items-center gap-2 ml-3">
                        <i className="fa-solid fa-folder w-3 h-3 text-blue-500" />
                        <span className="label-text font-medium">{library.name}</span>
                      </div>
                    </label>
                  </div>
                ))}
              </div>

              {/* Help text */}
              <div className="bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-500/30 rounded-lg p-3">
                <div className="flex items-start gap-2">
                  <i className="fa-solid fa-lightbulb text-orange-600 dark:text-orange-400 mt-0.5" />
                  <div className="text-sm text-orange-700 dark:text-orange-300">
                    <p className="font-medium mb-1">Library Access Control</p>
                    <p>Changes will be applied to all connected media servers. Unselected libraries will be removed from user access.</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* Action Buttons */}
      <div className="flex items-center justify-end gap-3 pt-6 border-t border-base-300">
        <Button variant="primary" onClick={handleSubmit} disabled={submitting}>
          <i className="fa-solid fa-save w-4 h-4 mr-2" />
          {submitting ? 'Saving…' : 'Save Changes'}
        </Button>
      </div>
    </div>
  );
};

export default UserSettingsCard;
