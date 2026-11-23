// Shared destinations keep route templates and their parameters together.
// Server arguments are already-resolved URL nicknames, never numeric IDs.
export const appPaths = {
  user: '/admin/users/$uuid',
  server: '/admin/servers/$serverType/$serverId',
  serverUsers: '/admin/servers/$serverType/$serverId/users',
  serverUser: '/admin/servers/$serverType/$serverId/users/$uuid',
  serverLibraries: '/admin/servers/$serverType/$serverId/libraries',
  serverHistory: '/admin/servers/$serverType/$serverId/history',
  serverGraphs: '/admin/servers/$serverType/$serverId/graphs',
  serverResources: '/admin/servers/$serverType/$serverId/resources',
  library: '/admin/servers/$serverType/$serverId/libraries/$libraryId',
  media: '/admin/servers/$serverType/$serverId/libraries/$libraryId/$mediaId',
  episode: '/admin/servers/$serverType/$serverId/libraries/$libraryId/$mediaId/episodes/$episodeId',
  mediaService: '/admin/settings/media-servers/$serviceId',
  serverAdd: '/admin/settings/media-servers/$serviceId/servers/add',
  serverEdit: '/admin/settings/media-servers/$serviceId/servers/$serverId/edit',
} as const;

type ID = string | number;
export const serverAddress = (type:string, slug:string) => `${type}/${slug}`;
const serverParams = (address:string) => { const [serverType,serverId] = address.split('/'); return {serverType,serverId}; };
export const appLinks = {
  user: (uuid: string) => ({to: appPaths.user, params: {uuid}}),
  server: (serverId: string) => ({to: appPaths.server, params: serverParams(serverId)}),
  serverUsers: (serverId: string) => ({to: appPaths.serverUsers, params: serverParams(serverId)}),
  serverUser: (serverId: string, uuid: string) => ({to: appPaths.serverUser, params: {...serverParams(serverId), uuid}}),
  serverLibraries: (serverId: string) => ({to: appPaths.serverLibraries, params: serverParams(serverId)}),
  serverHistory: (serverId: string) => ({to: appPaths.serverHistory, params: serverParams(serverId)}),
  serverGraphs: (serverId: string) => ({to: appPaths.serverGraphs, params: serverParams(serverId)}),
  serverResources: (serverId: string) => ({to: appPaths.serverResources, params: serverParams(serverId)}),
  library: (serverId: string, libraryId: ID) => ({to: appPaths.library, params: {...serverParams(serverId), libraryId: String(libraryId)}}),
  media: (serverId: string, libraryId: ID, mediaId: ID) => ({to: appPaths.media, params: {...serverParams(serverId), libraryId: String(libraryId), mediaId: String(mediaId)}}),
  episode: (serverId: string, libraryId: ID, mediaId: ID, episodeId: ID) => ({to: appPaths.episode, params: {...serverParams(serverId), libraryId: String(libraryId), mediaId: String(mediaId), episodeId: String(episodeId)}}),
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

// UUIDs are globally unique even when server names and usernames coincide.
export const buildUserProfilePath = ({ uuid }: UserProfilePathInput) => `/admin/users/${uuid}`;

// Pathnames for sidebar selection use the same route templates as links.
export const serverRoutePath = (template: string, serverId: string) => template.replace("$serverType/$serverId", () => serverId);
