// Shared destinations keep route templates and their parameters together.
// Server arguments are already-resolved URL nicknames, never numeric IDs.
export const appPaths = {
  user: '/admin/users/$uuid',
  server: '/admin/servers/$serverId',
  serverUsers: '/admin/servers/$serverId/users',
  serverUser: '/admin/servers/$serverId/users/$uuid',
  serverLibraries: '/admin/servers/$serverId/libraries',
  serverHistory: '/admin/servers/$serverId/history',
  serverGraphs: '/admin/servers/$serverId/graphs',
  serverResources: '/admin/servers/$serverId/resources',
  library: '/admin/servers/$serverId/libraries/$libraryId',
  media: '/admin/servers/$serverId/libraries/$libraryId/$mediaId',
  episode: '/admin/servers/$serverId/libraries/$libraryId/$mediaId/episodes/$episodeId',
  mediaService: '/admin/settings/media-servers/$serviceId',
  serverAdd: '/admin/settings/media-servers/$serviceId/servers/add',
  serverEdit: '/admin/settings/media-servers/$serviceId/servers/$serverId/edit',
} as const;

type ID = string | number;
export const appLinks = {
  user: (uuid: string) => ({to: appPaths.user, params: {uuid}}),
  server: (serverId: string) => ({to: appPaths.server, params: {serverId}}),
  serverUsers: (serverId: string) => ({to: appPaths.serverUsers, params: {serverId}}),
  serverUser: (serverId: string, uuid: string) => ({to: appPaths.serverUser, params: {serverId, uuid}}),
  serverLibraries: (serverId: string) => ({to: appPaths.serverLibraries, params: {serverId}}),
  serverHistory: (serverId: string) => ({to: appPaths.serverHistory, params: {serverId}}),
  serverGraphs: (serverId: string) => ({to: appPaths.serverGraphs, params: {serverId}}),
  serverResources: (serverId: string) => ({to: appPaths.serverResources, params: {serverId}}),
  library: (serverId: string, libraryId: ID) => ({to: appPaths.library, params: {serverId, libraryId: String(libraryId)}}),
  media: (serverId: string, libraryId: ID, mediaId: ID) => ({to: appPaths.media, params: {serverId, libraryId: String(libraryId), mediaId: String(mediaId)}}),
  episode: (serverId: string, libraryId: ID, mediaId: ID, episodeId: ID) => ({to: appPaths.episode, params: {serverId, libraryId: String(libraryId), mediaId: String(mediaId), episodeId: String(episodeId)}}),
  mediaService: (serviceId: string) => ({to: appPaths.mediaService, params: {serviceId}}),
  serverAdd: (serviceId: string) => ({to: appPaths.serverAdd, params: {serviceId}}),
  serverEdit: (serviceId: string, serverId: string) => ({to: appPaths.serverEdit, params: {serviceId, serverId}}),
};

export const LOGIN_PATH = "/login";
export const HOME_PATH = "/home";
export const ACCOUNT_PATH = "/account";

export type UserProfilePathInput = {
  uuid: string;
  username?: string | null;
  server_nickname?: string | null;
};

const encodeSegment = (value?: string | null) => {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const encoded = encodeURIComponent(trimmed);
  // Keep plus signs readable since they're common in server nicknames.
  return encoded.replace(/%2B/gi, '+');
};

export const buildUserProfilePath = ({ uuid, username, server_nickname }: UserProfilePathInput) => {
  const serverSegment = encodeSegment(server_nickname);
  const usernameSegment = encodeSegment(username);

  if (serverSegment && usernameSegment) {
    return `/admin/users/${serverSegment}/${usernameSegment}`;
  }

  return `/admin/users/${uuid}`;
};

// Pathnames for sidebar selection use the same route templates as links.
export const serverRoutePath = (template: string, serverId: string) => template.replace("$serverId", () => serverId);
