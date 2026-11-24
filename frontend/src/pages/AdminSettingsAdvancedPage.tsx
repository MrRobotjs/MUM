import {PageHeader} from '../components';
import {ImageCacheSettings} from '../components/settings/ImageCacheSettings';

export const AdminSettingsAdvancedPage = () => <div className="space-y-6">
  <PageHeader title="Advanced Settings" description="Configure storage and advanced options." />
  <ImageCacheSettings />
</div>;

export default AdminSettingsAdvancedPage;
