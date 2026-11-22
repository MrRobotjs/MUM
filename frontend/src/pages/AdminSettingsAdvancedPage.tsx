import {ActivityMonitoringSettings} from '../components/settings/ActivityMonitoringSettings';
import {PageHeader} from '../components';

export const AdminSettingsAdvancedPage = () => <div className="space-y-6">
  <PageHeader title="Advanced Settings" description="Configure monitoring settings" />
  <ActivityMonitoringSettings />
</div>;

export default AdminSettingsAdvancedPage;
