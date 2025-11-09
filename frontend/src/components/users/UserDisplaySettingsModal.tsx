import { useState, useEffect } from 'react';
import { useAlerts } from '../../contexts/AlertContext';
import { Switch } from '../ui/switch';
import { Label } from '../ui/label';
import { Button } from '../ui/button';
import { ResponsiveDialog } from '../ui/responsive-dialog';

interface UserDisplaySettings {
  show_user_notes: boolean;
  show_email_section: boolean;
  show_added_section: boolean;
  show_streamed_section: boolean;
  show_libraries_section: boolean;
  show_roles_section: boolean;
  preferred_view: 'cards' | 'table';
  auto_sync_users: boolean;
}

interface UserDisplaySettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const UserDisplaySettingsModal = ({ isOpen, onClose }: UserDisplaySettingsModalProps) => {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const { success, error: showError } = useAlerts();

  // Settings state
  const [showUserNotes, setShowUserNotes] = useState(false);
  const [showEmailSection, setShowEmailSection] = useState(true);
  const [showAddedSection, setShowAddedSection] = useState(true);
  const [showStreamedSection, setShowStreamedSection] = useState(true);
  const [showLibrariesSection, setShowLibrariesSection] = useState(true);
  const [showRolesSection, setShowRolesSection] = useState(true);
  const [preferredView, setPreferredView] = useState<'cards' | 'table'>('cards');
  const [autoSyncUsers, setAutoSyncUsers] = useState(false);

  // Load settings when modal opens
  useEffect(() => {
    if (isOpen) {
      loadSettings();
    }
  }, [isOpen]);

  const loadSettings = () => {
    setLoading(true);
    try {
      const savedSettings = localStorage.getItem('userDisplaySettings');
      if (savedSettings) {
        const settings: UserDisplaySettings = JSON.parse(savedSettings);
        setShowUserNotes(settings.show_user_notes ?? false);
        setShowEmailSection(settings.show_email_section ?? true);
        setShowAddedSection(settings.show_added_section ?? true);
        setShowStreamedSection(settings.show_streamed_section ?? true);
        setShowLibrariesSection(settings.show_libraries_section ?? true);
        setShowRolesSection(settings.show_roles_section ?? true);
        setPreferredView(settings.preferred_view ?? 'cards');
        setAutoSyncUsers(settings.auto_sync_users ?? false);
      }
    } catch (err) {
      console.error('Failed to load settings from localStorage:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = () => {
    setSaving(true);
    try {
      const settings: UserDisplaySettings = {
        show_user_notes: showUserNotes,
        show_email_section: showEmailSection,
        show_added_section: showAddedSection,
        show_streamed_section: showStreamedSection,
        show_libraries_section: showLibrariesSection,
        show_roles_section: showRolesSection,
        preferred_view: preferredView,
        auto_sync_users: autoSyncUsers
      };

      localStorage.setItem('userDisplaySettings', JSON.stringify(settings));

      success('User display settings have been updated. Refresh the page to see changes.');

      onClose();
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const ToggleOption = ({
    icon,
    iconColor,
    label,
    description,
    checked,
    onChange,
  }: {
    icon: string;
    iconColor: string;
    label: string;
    description: string;
    checked: boolean;
    onChange: (checked: boolean) => void;
  }) => (
    <div className="bg-base-200/30 rounded-lg p-4 border border-base-300 hover:border-base-300/60 transition-colors">
      <div className="flex items-center justify-between gap-4">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <i className={`fa-solid ${icon} ${iconColor} text-sm`} />
            <Label htmlFor={label} className="font-medium text-base-content cursor-pointer">
              {label}
            </Label>
          </div>
          <p className="text-sm text-base-content/60">{description}</p>
        </div>
        <Switch
          id={label}
          checked={checked}
          onCheckedChange={onChange}
        />
      </div>
    </div>
  );

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      onClose();
    }
  };

  const footer = [
    <Button
      key="cancel"
      type="button"
      variant="outline"
      onClick={onClose}
      disabled={saving}
    >
      Cancel
    </Button>,
    <Button
      key="save"
      type="button"
      onClick={handleSave}
      disabled={saving}
    >
      {saving ? (
        <>
          <span className="loading loading-spinner loading-xs" />
          Saving...
        </>
      ) : (
        <>
          <i className="fa-solid fa-save" />
          Save Settings
        </>
      )}
    </Button>,
  ];

  const body = loading ? (
    <div className="flex items-center justify-center py-8">
      <span className="loading loading-spinner loading-lg" />
    </div>
  ) : (
    <div className="space-y-6">
      {/* Description Card */}
      <div className="bg-base-200/50 rounded-lg p-4 border border-base-300">
        <div className="flex items-start gap-3">
          <div className="w-8 h-8 rounded-full bg-info/20 flex items-center justify-center flex-shrink-0 mt-0.5">
            <i className="fa-solid fa-info text-info text-sm" />
          </div>
          <div>
            <h4 className="font-medium text-base-content mb-1">Personalization</h4>
            <p className="text-sm text-base-content/70 leading-relaxed">
              Configure how the user interface displays information and behaves to match your preferences.
              These settings only affect your view.
            </p>
          </div>
        </div>
      </div>

      {/* Card Display Options */}
      <div className="space-y-3">
        <h4 className="font-medium text-base-content text-lg mb-3">Card Display Options</h4>

        <ToggleOption
          icon="fa-sticky-note"
          iconColor="text-warning"
          label="Show User Notes on Cards"
          description="Display user notes directly on user cards for quick reference"
          checked={showUserNotes}
          onChange={setShowUserNotes}
        />

        <ToggleOption
          icon="fa-envelope"
          iconColor="text-blue-500"
          label="Show Email Section"
          description="Display email information on user cards"
          checked={showEmailSection}
          onChange={setShowEmailSection}
        />

        <ToggleOption
          icon="fa-calendar-plus"
          iconColor="text-green-500"
          label="Show Added Section"
          description="Display when the user was added to the system"
          checked={showAddedSection}
          onChange={setShowAddedSection}
        />

        <ToggleOption
          icon="fa-play"
          iconColor="text-purple-500"
          label="Show Streamed Section"
          description="Display streaming activity and statistics"
          checked={showStreamedSection}
          onChange={setShowStreamedSection}
        />

        <ToggleOption
          icon="fa-folder"
          iconColor="text-orange-500"
          label="Show Libraries Section"
          description="Display library access and permissions"
          checked={showLibrariesSection}
          onChange={setShowLibrariesSection}
        />

        <ToggleOption
          icon="fa-user-tag"
          iconColor="text-red-500"
          label="Show Roles Section"
          description="Display user roles and permissions"
          checked={showRolesSection}
          onChange={setShowRolesSection}
        />

        {/* Preferred View */}
        <div className="bg-base-200/30 rounded-lg p-4 border border-base-300 hover:border-base-300/60 transition-colors">
          <div className="flex items-center justify-between">
            <div className="flex-1">
              <div className="flex justify-between mb-1 items-center">
                <div className="flex items-center gap-2">
                  <i className="fa-solid fa-eye text-secondary text-sm" />
                  <h5 className="font-medium text-base-content">Preferred Default View</h5>
                </div>
                <select
                  className="select select-bordered select-sm max-w-fit"
                  value={preferredView}
                  onChange={(e) => setPreferredView(e.target.value as 'cards' | 'table')}
                >
                  <option value="cards">Cards</option>
                  <option value="table">Table</option>
                </select>
              </div>
              <p className="text-sm text-base-content/60">
                Choose how users are displayed by default when loading the page
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Behavior Settings */}
      <div className="space-y-3">
        <h4 className="font-medium text-base-content text-lg mb-3">Behavior Settings</h4>

        <ToggleOption
          icon="fa-sync"
          iconColor="text-success"
          label="Auto-sync Users on Page Load"
          description="Automatically sync users from all services when visiting this page"
          checked={autoSyncUsers}
          onChange={setAutoSyncUsers}
        />
      </div>
    </div>
  );

  return (
    <ResponsiveDialog
      open={isOpen}
      onOpenChange={handleOpenChange}
      title="User Display Settings"
      description="Configure how the user interface displays information and behaves to match your preferences."
      footer={footer}
      contentClassName="max-w-2xl"
      bodyClassName="px-0"
    >
      {body}
    </ResponsiveDialog>
  );
};
