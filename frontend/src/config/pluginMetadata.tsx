/**
 * Plugin metadata configuration - Frontend presentation layer
 * Icons and visual elements are defined here, while metadata is fetched from backend
 */

import { cloneElement, type ReactElement } from 'react'
import { cn } from '@/lib/utils'

// Plex SVG Icon
const plexIcon = (
  <svg className="w-8 h-8 stroke-transparent text-plex" viewBox="0 0 192 192" xmlns="http://www.w3.org/2000/svg" fill="currentColor">
    <path d="M22 25.5h48L116 94l-46 68.5H22L68.5 94Zm109.8 56L108 46l14-20.5h48zm-.3 23.5c10.979 17.625 25.52 38.875 38.5 49.5-11.149 13.635-34.323 32.278-62.5-14z" />
  </svg>
)

type IconElement = ReactElement<{ className?: string }>

interface ThemePalette {
  bg: string
  bgDark: string
  text: string
  textDark: string
  accent: string
  accentDark: string
  ring: string
  ringDark: string
  avatar: string
}

interface ServiceMeta {
  icon: IconElement
  label: string
  gradient: string
  streamingGradient?: string // Optional gradient for streaming session cards
  badgeClass: string
  libraryGradient?: string
  libraryBadgeClass?: string
  chipClass?: string  // For chip/tag styling (UserDetailPage)
  detailGradient?: string  // For detail page gradients (UserDetailPage)
  palette?: ThemePalette  // For theme palette (UserCard)
}

// Icon mappings for each service
export const SERVICE_META: Record<string, ServiceMeta> = {
  plex: {
    icon: plexIcon,
    label: 'Plex',
    gradient: 'from-plex/10 via-plex/10 to-plex/20',
    streamingGradient: 'bg-gradient-to-br via-card to-card from-plex/30',
    badgeClass: 'bg-plex-50 text-plex-700 ring-plex-500/30 dark:bg-plex-400/10 dark:text-plex-300',
    libraryGradient: 'from-card to-plex/10',
    libraryBadgeClass: 'bg-plex-50 text-plex-700 ring-plex-500/30',
    chipClass: 'bg-plex-100 text-plex-700 ring-plex-600/30 dark:bg-plex-400/20 dark:text-plex-200',
    detailGradient: 'from-plex/10 via-plex/10 to-plex/20',
    palette: {
      bg: 'bg-plex-50',
      bgDark: 'dark:bg-plex-400/10',
      text: 'text-plex-700',
      textDark: 'dark:text-plex-400',
      accent: 'bg-plex-100',
      accentDark: 'dark:bg-plex-400/20',
      ring: 'ring-plex-600/20',
      ringDark: 'dark:ring-plex-500/20',
      avatar: 'bg-plex'
    }
  },
  jellyfin: {
    icon: <i className="fa-solid fa-cube text-jellyfin" />,
    label: 'Jellyfin',
    gradient: 'from-jellyfin/10 via-jellyfin/10 to-jellyfin/20',
    streamingGradient: 'bg-gradient-to-br via-card to-card from-jellyfin/30',
    badgeClass: 'bg-jellyfin-50 text-jellyfin-700 ring-jellyfin-500/30 dark:bg-jellyfin-400/10 dark:text-jellyfin-300',
    libraryGradient: 'from-card to-jellyfin/10',
    libraryBadgeClass: 'bg-jellyfin-50 text-jellyfin-700 ring-jellyfin-500/30',
    chipClass: 'bg-jellyfin-100 text-jellyfin-700 ring-jellyfin-600/30 dark:bg-jellyfin-400/20 dark:text-jellyfin-200',
    detailGradient: 'from-jellyfin/10 via-jellyfin/10 to-jellyfin/20',
    palette: {
      bg: 'bg-jellyfin-50',
      bgDark: 'dark:bg-jellyfin-400/10',
      text: 'text-jellyfin-700',
      textDark: 'dark:text-jellyfin-400',
      accent: 'bg-jellyfin-100',
      accentDark: 'dark:bg-jellyfin-400/20',
      ring: 'ring-jellyfin-600/20',
      ringDark: 'dark:ring-jellyfin-500/20',
      avatar: 'bg-jellyfin'
    }
  },
  emby: {
    icon: <i className="fa-solid fa-play-circle text-emby" />,
    label: 'Emby',
    gradient: 'from-emby/10 via-emby/10 to-emby/20',
    streamingGradient: 'bg-gradient-to-br via-card to-card from-emby/30',
    badgeClass: 'bg-emby-50 text-emby-700 ring-emby-500/30 dark:bg-emby-400/10 dark:text-emby-300',
    libraryGradient: 'from-card to-emby/10',
    libraryBadgeClass: 'bg-emby-50 text-emby-700 ring-emby-500/30',
    chipClass: 'bg-emby-100 text-emby-700 ring-emby-600/30 dark:bg-emby-400/20 dark:text-emby-200',
    detailGradient: 'from-emby/10 via-emby/10 to-emby/20',
    palette: {
      bg: 'bg-emby-50',
      bgDark: 'dark:bg-emby-400/10',
      text: 'text-emby-700',
      textDark: 'dark:text-emby-400',
      accent: 'bg-emby-100',
      accentDark: 'dark:bg-emby-400/20',
      ring: 'ring-emby-600/20',
      ringDark: 'dark:ring-emby-500/20',
      avatar: 'bg-emby'
    }
  },
  kavita: {
    icon: <i className="fa-solid fa-book text-kavita" />,
    label: 'Kavita',
    gradient: 'from-kavita/10 via-kavita/10 to-kavita/20',
    streamingGradient: 'bg-gradient-to-br via-card to-card from-kavita/30',
    badgeClass: 'bg-kavita-50 text-kavita-700 ring-kavita-500/30 dark:bg-kavita-400/10 dark:text-kavita-300',
    libraryGradient: 'from-card to-kavita/10',
    libraryBadgeClass: 'bg-kavita-50 text-kavita-700 ring-kavita-500/30',
    chipClass: 'bg-kavita-100 text-kavita-700 ring-kavita-600/30 dark:bg-kavita-400/20 dark:text-kavita-200',
    detailGradient: 'from-kavita/10 via-kavita/10 to-kavita/20',
    palette: {
      bg: 'bg-kavita-50',
      bgDark: 'dark:bg-kavita-400/10',
      text: 'text-kavita-700',
      textDark: 'dark:text-kavita-400',
      accent: 'bg-kavita-100',
      accentDark: 'dark:bg-kavita-400/20',
      ring: 'ring-kavita-600/20',
      ringDark: 'dark:ring-kavita-500/20',
      avatar: 'bg-kavita'
    }
  },
  audiobookshelf: {
    icon: <i className="fa-solid fa-headphones text-audiobookshelf" />,
    label: 'AudioBookshelf',
    gradient: 'from-audiobookshelf/10 via-audiobookshelf/10 to-audiobookshelf/20',
    streamingGradient: 'bg-gradient-to-br via-card to-card from-audiobookshelf/30',
    badgeClass: 'bg-audiobookshelf-50 text-audiobookshelf-700 ring-audiobookshelf-500/30 dark:bg-audiobookshelf-400/10 dark:text-audiobookshelf-300',
    libraryGradient: 'from-card to-audiobookshelf/10',
    libraryBadgeClass: 'bg-audiobookshelf-50 text-audiobookshelf-700 ring-audiobookshelf-500/30',
    chipClass: 'bg-audiobookshelf-100 text-audiobookshelf-700 ring-audiobookshelf-600/30 dark:bg-audiobookshelf-400/20 dark:text-audiobookshelf-200',
    detailGradient: 'from-audiobookshelf/10 via-audiobookshelf/10 to-audiobookshelf/20',
    palette: {
      bg: 'bg-audiobookshelf-50',
      bgDark: 'dark:bg-audiobookshelf-400/10',
      text: 'text-audiobookshelf-700',
      textDark: 'dark:text-audiobookshelf-400',
      accent: 'bg-audiobookshelf-100',
      accentDark: 'dark:bg-audiobookshelf-400/20',
      ring: 'ring-audiobookshelf-600/20',
      ringDark: 'dark:ring-audiobookshelf-500/20',
      avatar: 'bg-audiobookshelf'
    }
  },
  komga: {
    icon: <i className="fa-solid fa-book-open text-komga" />,
    label: 'Komga',
    gradient: 'from-komga/10 via-komga/10 to-komga/20',
    streamingGradient: 'bg-gradient-to-br via-card to-card from-komga/30',
    badgeClass: 'bg-komga-50 text-komga-700 ring-komga-500/30 dark:bg-komga-400/10 dark:text-komga-300',
    libraryGradient: 'from-card to-komga/10',
    libraryBadgeClass: 'bg-komga-50 text-komga-700 ring-komga-500/30',
    chipClass: 'bg-komga-100 text-komga-700 ring-komga-600/30 dark:bg-komga-400/20 dark:text-komga-200',
    detailGradient: 'from-komga/10 via-komga/10 to-komga/20',
    palette: {
      bg: 'bg-komga-50',
      bgDark: 'dark:bg-komga-400/10',
      text: 'text-komga-700',
      textDark: 'dark:text-komga-400',
      accent: 'bg-komga-100',
      accentDark: 'dark:bg-komga-400/20',
      ring: 'ring-komga-600/20',
      ringDark: 'dark:ring-komga-500/20',
      avatar: 'bg-komga'
    }
  },
  romm: {
    icon: <i className="fa-solid fa-gamepad text-romm" />,
    label: 'RomM',
    gradient: 'from-romm/10 via-romm/10 to-romm/20',
    streamingGradient: 'bg-gradient-to-br via-card to-card from-romm/30',
    badgeClass: 'bg-romm-50 text-romm-700 ring-romm-500/30 dark:bg-romm-400/10 dark:text-romm-300',
    libraryGradient: 'from-card to-romm/10',
    libraryBadgeClass: 'bg-romm-50 text-romm-700 ring-romm-500/30',
    chipClass: 'bg-romm-100 text-romm-700 ring-romm-600/30 dark:bg-romm-400/20 dark:text-romm-200',
    detailGradient: 'from-romm/10 via-romm/10 to-romm/20',
    palette: {
      bg: 'bg-romm-50',
      bgDark: 'dark:bg-romm-400/10',
      text: 'text-romm-700',
      textDark: 'dark:text-romm-400',
      accent: 'bg-romm-100',
      accentDark: 'dark:bg-romm-400/20',
      ring: 'ring-romm-600/20',
      ringDark: 'dark:ring-romm-500/20',
      avatar: 'bg-romm'
    }
  }
}

/**
 * Get the full service metadata
 */
export const getServiceMeta = (serviceType?: string): ServiceMeta => {
  const defaultMeta: ServiceMeta = {
    label: 'Unknown',
    gradient: 'from-primary/10 via-primary/5 to-secondary/10',
    streamingGradient: 'bg-gradient-to-br via-card to-card from-muted/50',
    badgeClass: 'bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-100',
    libraryGradient: 'from-card to-muted',
    libraryBadgeClass: 'bg-muted text-foreground ring-border',
    chipClass: 'bg-gray-100 text-gray-700 ring-gray-600/30 dark:bg-gray-400/20 dark:text-gray-200',
    detailGradient: 'from-gray/10 via-gray/10 to-gray/20',
    icon: <i className="fa-solid fa-server" />,
    palette: {
      bg: 'bg-gray-50',
      bgDark: 'dark:bg-gray-400/10',
      text: 'text-gray-700',
      textDark: 'dark:text-gray-400',
      accent: 'bg-gray-100',
      accentDark: 'dark:bg-gray-400/20',
      ring: 'ring-gray-600/20',
      ringDark: 'dark:ring-gray-500/20',
      avatar: 'bg-gray'
    }
  }

  if (!serviceType) {
    return { ...defaultMeta, label: 'Unknown' }
  }

  const meta = SERVICE_META[serviceType.toLowerCase()]
  if (!meta) {
    return { ...defaultMeta, label: serviceType }
  }

  return meta
}

/**
 * Get the icon for a specific service (for plugin cards)
 */
const appendIconClassName = (icon: IconElement, className?: string): IconElement => {
  const extra = className?.trim()
  if (!extra) return icon
  const existing = icon.props.className ?? ''
  return cloneElement(icon, { className: cn(existing, extra) })
}

export const getServiceIcon = (pluginId?: string, className?: string): IconElement => {
  return appendIconClassName(getServiceMeta(pluginId).icon, className)
}

/**
 * Get the gradient for a specific service
 */
export const getServiceGradient = (pluginId?: string): string => {
  return getServiceMeta(pluginId).gradient
}

/**
 * Get the badge class for a specific service
 */
export const getServiceBadgeClass = (pluginId?: string): string => {
  return getServiceMeta(pluginId).badgeClass
}

/**
 * Get the library gradient for a specific service
 */
export const getServiceLibraryGradient = (pluginId?: string): string => {
  const meta = getServiceMeta(pluginId)
  return meta.libraryGradient || meta.gradient
}

/**
 * Get the library badge class for a specific service
 */
export const getServiceLibraryBadgeClass = (pluginId?: string): string => {
  const meta = getServiceMeta(pluginId)
  return meta.libraryBadgeClass || meta.badgeClass
}

/**
 * Get the chip class for a specific service
 */
export const getServiceChipClass = (pluginId?: string): string => {
  const meta = getServiceMeta(pluginId)
  return meta.chipClass || meta.badgeClass
}

/**
 * Get the detail gradient for a specific service
 */
export const getServiceDetailGradient = (pluginId?: string): string => {
  const meta = getServiceMeta(pluginId)
  return meta.detailGradient || meta.gradient
}

/**
 * Get the theme palette for a specific service
 */
export const getServicePalette = (pluginId?: string): ThemePalette => {
  const meta = getServiceMeta(pluginId)
  return meta.palette || {
    bg: 'bg-gray-50',
    bgDark: 'dark:bg-gray-400/10',
    text: 'text-gray-700',
    textDark: 'dark:text-gray-400',
    accent: 'bg-gray-100',
    accentDark: 'dark:bg-gray-400/20',
    ring: 'ring-gray-600/20',
    ringDark: 'dark:ring-gray-500/20',
    avatar: 'bg-gray'
  }
}

/**
 * Service types constant - used for select dropdowns and service type mappings
 */
export const SERVICE_TYPES = [
  { value: 'plex', label: 'Plex' },
  { value: 'jellyfin', label: 'Jellyfin' },
  { value: 'emby', label: 'Emby' },
  { value: 'kavita', label: 'Kavita' },
  { value: 'audiobookshelf', label: 'AudioBookshelf' },
  { value: 'komga', label: 'Komga' },
  { value: 'romm', label: 'RomM' },
] as const;

// Export the ThemePalette type for use in other components
export type { ThemePalette }
