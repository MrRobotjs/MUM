import type { IconDefinition } from '@fortawesome/fontawesome-svg-core';
import {
  faAmazon, faAndroid, faApple, faChrome, faChromecast, faEdge, faFirefoxBrowser, faInternetExplorer,
  faLinux, faOpera, faPlaystation, faSafari, faWindows, faXbox,
} from '@fortawesome/free-brands-svg-icons';
import { faCirclePlay, faGamepad, faMusic, faNetworkWired, faTv, faUsers } from '@fortawesome/free-solid-svg-icons';

// Player logos for the Profile tab's Players card, the way Tautulli picks
// them (plexpy/common.py): a few exact platform names are renamed, then the
// first keyword the lowercased platform contains names the logo, checking
// keywords in reverse alphabetical order so "windows phone" wins over
// "windows" and "chromecast" over "chrome". Plex reports the platform;
// Jellyfin and Emby do not, so their app name ("Jellyfin Android", "Emby for
// iOS") is checked the same way. Brand colours are Tautulli's; brands Font
// Awesome has no logo for get a generic icon in their colour.

export type PlayerLogo = Readonly<{ name: string; icon: IconDefinition; color: string }>;

const overrides: Readonly<Record<string, string>> = {
  Konvergo: 'Plex Media Player', 'Mystery 3': 'Playstation 3', 'Mystery 4': 'Playstation 4', 'Mystery 5': 'Xbox 360',
  WebMAF: 'Playstation 4', windows: 'Windows', osx: 'macOS', macos: 'macOS',
};

const keywords: readonly (readonly [string, string])[] = Object.entries({
  android: 'android', 'apple tv': 'atv', chrome: 'chrome', chromecast: 'chromecast', dlna: 'dlna', firefox: 'firefox',
  'internet explorer': 'ie', ios: 'ios', ipad: 'ios', iphone: 'ios', kodi: 'kodi', linux: 'linux', nexus: 'android',
  macos: 'macos', 'microsoft edge': 'msedge', netcast: 'lg', opera: 'opera', osx: 'macos', playstation: 'playstation',
  'plex home theater': 'plex', 'plex media player': 'plex', plexamp: 'plexamp', plextogether: 'synclounge', roku: 'roku',
  safari: 'safari', samsung: 'samsung', synclounge: 'synclounge', tivo: 'tivo', tizen: 'samsung', tvos: 'atv',
  vizio: 'opera', webos: 'lg', wiiu: 'wiiu', windows: 'windows', 'windows phone': 'wp', xbmc: 'xbmc', xbox: 'xbox',
  // Apps on services that report no platform.
  'fire tv': 'amazon', firetv: 'amazon', amazon: 'amazon', infuse: 'ios', swiftfin: 'ios', findroid: 'android',
}).sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0));

const logos: Readonly<Record<string, PlayerLogo>> = {
  amazon: { name: 'Fire TV', icon: faAmazon, color: '#ff9900' },
  android: { name: 'Android', icon: faAndroid, color: '#3ddc84' },
  atv: { name: 'Apple TV', icon: faApple, color: '#a2aaad' },
  chrome: { name: 'Chrome', icon: faChrome, color: '#db4437' },
  chromecast: { name: 'Chromecast', icon: faChromecast, color: '#4285f4' },
  dlna: { name: 'DLNA', icon: faNetworkWired, color: '#4ba32f' },
  firefox: { name: 'Firefox', icon: faFirefoxBrowser, color: '#ff7139' },
  ie: { name: 'Internet Explorer', icon: faInternetExplorer, color: '#18bcef' },
  ios: { name: 'iOS', icon: faApple, color: '#a2aaad' },
  kodi: { name: 'Kodi', icon: faTv, color: '#30aada' },
  lg: { name: 'LG', icon: faTv, color: '#990033' },
  linux: { name: 'Linux', icon: faLinux, color: '#0099cc' },
  macos: { name: 'macOS', icon: faApple, color: '#a2aaad' },
  msedge: { name: 'Edge', icon: faEdge, color: '#0078d7' },
  opera: { name: 'Opera', icon: faOpera, color: '#fa1e4e' },
  playstation: { name: 'PlayStation', icon: faPlaystation, color: '#003087' },
  plex: { name: 'Plex', icon: faCirclePlay, color: '#e5a00d' },
  plexamp: { name: 'Plexamp', icon: faMusic, color: '#e5a00d' },
  roku: { name: 'Roku', icon: faTv, color: '#673293' },
  safari: { name: 'Safari', icon: faSafari, color: '#00d3f9' },
  samsung: { name: 'Samsung', icon: faTv, color: '#034ea2' },
  synclounge: { name: 'SyncLounge', icon: faUsers, color: '#151924' },
  tivo: { name: 'TiVo', icon: faTv, color: '#00a7e1' },
  wiiu: { name: 'Wii U', icon: faGamepad, color: '#03a9f4' },
  windows: { name: 'Windows', icon: faWindows, color: '#0078d7' },
  wp: { name: 'Windows Phone', icon: faWindows, color: '#68217a' },
  xbmc: { name: 'XBMC', icon: faTv, color: '#3b4872' },
  xbox: { name: 'Xbox', icon: faXbox, color: '#107c10' },
};

// Anything else: a neutral play icon, since MUM covers more than Plex.
const otherLogo: PlayerLogo = { name: 'Other', icon: faCirclePlay, color: '#64748b' };

const match = (text: string | null | undefined) => {
  if (!text) return undefined;
  const lower = (overrides[text] ?? text).toLowerCase();
  const found = keywords.find(([key]) => lower.includes(key));
  return found ? logos[found[1]] : undefined;
};

// playerLogo picks the logo from the platform, then from the app name.
export const playerLogo = (platform: string | null, client: string): PlayerLogo => match(platform) ?? match(client) ?? otherLogo;
