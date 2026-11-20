import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faCircleCheck, faCircleMinus } from '@fortawesome/free-solid-svg-icons'
import { type MediaServiceFeature } from '../../hooks/useMediaServices'
import { MEDIA_SERVICE_FEATURE_GROUPS } from '../../lib/mediaServiceFeatures'
import { cn } from '@/lib/utils'

/**
 * A media service's features in a grey panel, grouped by area: supported
 * ones checked, the rest greyed out so services can be compared.
 */
export const MediaServiceFeatures = ({ features }: { features: readonly MediaServiceFeature[] }) => {
  const supported = new Map(features.map(f => [f.key, f.supported]))
  return (
    <div className="space-y-3 rounded-lg border border-border/70 bg-muted/40 p-4">
      {MEDIA_SERVICE_FEATURE_GROUPS.map(group => {
        const listed = group.features.filter(([key]) => supported.has(key))
        if (!listed.length) return null
        return (
          <div key={group.title} className="space-y-2">
            <p className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
              <FontAwesomeIcon icon={group.icon} className="h-3 w-3" />
              {group.title}
            </p>
            <ul className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
              {listed.map(([key, label]) => {
                const on = supported.get(key) === true
                return (
                  <li key={key} className={cn('flex items-center gap-2', !on && 'text-muted-foreground')}>
                    <FontAwesomeIcon icon={on ? faCircleCheck : faCircleMinus} className={on ? 'h-3 w-3 text-primary' : 'h-3 w-3 opacity-50'} />
                    <span className={on ? undefined : 'opacity-70'}>{label}</span>
                    <span className="sr-only">{on ? '(supported)' : '(not supported)'}</span>
                  </li>
                )
              })}
            </ul>
          </div>
        )
      })}
    </div>
  )
}

export default MediaServiceFeatures
