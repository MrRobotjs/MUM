import { cn } from '@/lib/utils'

type RoleBadgeKind = 'user' | 'admin'

type RoleBadgeProps = {
  label: string
  color?: string | null
  icon?: string | null
  kind?: RoleBadgeKind
  className?: string
  title?: string
}

const normalizeIconClass = (icon?: string | null) => {
  if (!icon) return null
  const trimmed = icon.trim()
  if (!trimmed) return null
  const hasStyle =
    trimmed.includes('fa-solid') ||
    trimmed.includes('fa-regular') ||
    trimmed.includes('fa-brands') ||
    trimmed.includes('fa-light') ||
    trimmed.includes('fa-thin') ||
    trimmed.includes('fa-duotone')
  if (hasStyle) {
    return trimmed
  }
  if (trimmed.includes('fa-')) {
    return `fa-solid ${trimmed}`
  }
  return trimmed
}

export const RoleBadge = ({
  label,
  color,
  icon,
  kind = 'user',
  className,
  title,
}: RoleBadgeProps) => {
  const hasColor = Boolean(color)
  const fallbackClasses =
    kind === 'admin'
      ? 'bg-blue-500/10 text-blue-400 ring-blue-500/20'
      : 'bg-secondary/10 text-secondary ring-secondary/20'
  const iconClass = normalizeIconClass(icon)

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium ring-1 ring-inset',
        !hasColor && fallbackClasses,
        className
      )}
      style={
        hasColor
          ? {
              backgroundColor: `${color}20`,
              color: color ?? undefined,
              borderColor: `${color}40`,
            }
          : undefined
      }
      title={title}
    >
      {iconClass ? <i className={cn(iconClass, 'text-[0.65rem]')} /> : null}
      {label}
    </span>
  )
}

export default RoleBadge
