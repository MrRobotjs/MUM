import { faCircleNodes, faLayerGroup, faTowerBroadcast, faUsers, type IconDefinition } from '@fortawesome/free-solid-svg-icons';

// What the Media Servers cards call each media service feature, grouped by
// area. The server decides which features a service supports
// (server/media_service_features.go); this is only how they read.

export type MediaServiceFeatureGroup = Readonly<{ title: string; icon: IconDefinition; features: readonly (readonly [key: string, label: string])[] }>;

export const MEDIA_SERVICE_FEATURE_GROUPS: readonly MediaServiceFeatureGroup[] = [
  { title: 'Users', icon: faUsers, features: [['users.sync', 'Sync accounts'], ['users.invites', 'Invites'], ['users.library_access', 'Library access']] },
  { title: 'Libraries', icon: faLayerGroup, features: [['libraries.sync', 'Sync libraries'], ['libraries.titles', 'Browse titles'], ['libraries.collections', 'Collections']] },
  { title: 'Activity', icon: faTowerBroadcast, features: [['activity.live', 'Live streams'], ['activity.stop', 'Stop streams'], ['activity.history_import', 'Import play history']] },
  { title: 'Extras', icon: faCircleNodes, features: [['extras.overseerr', 'Overseerr requests'], ['extras.download_labels', 'Download labels'], ['extras.resources', 'Server resources']] },
];
