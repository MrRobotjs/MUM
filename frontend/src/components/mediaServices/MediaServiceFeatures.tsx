import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faCircleCheck, faCircleMinus } from '@fortawesome/free-solid-svg-icons'
import { type MediaServiceFeature } from '../../hooks/useMediaServices'
import { MEDIA_SERVICE_FEATURE_GROUPS, type MediaServiceFeatureGroup } from '../../lib/mediaServiceFeatures'
import { cn } from '@/lib/utils'

// One area (Users, Libraries, …): its features in a row that wraps, or
// listed down when the areas are columns.
const FeatureGroup = ({ group, supported, listedDown }: { group: MediaServiceFeatureGroup; supported: ReadonlyMap<string, boolean>; listedDown: boolean }) => {
  const listed = group.features.filter(([key]) => supported.has(key))
  if (!listed.length) return null
  return (
    <div className="space-y-2">
      <p className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
        <FontAwesomeIcon icon={group.icon} className="h-3 w-3" />
        {group.title}
      </p>
      <ul className={listedDown ? 'flex flex-col gap-2 text-sm' : 'flex flex-wrap gap-x-3 gap-y-1 text-sm'}>
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
}

/**
 * A media service's features in a grey panel, grouped by area: supported
 * ones checked, the rest greyed out so services can be compared. Stacked in
 * a card; with columns (a service's own page) the areas sit side by side
 * from tablet width, each listing its features down, and stay stacked on a
 * phone.
 */
export const MediaServiceFeatures = ({ features, columns = false }: { features: readonly MediaServiceFeature[]; columns?: boolean }) => {
  const supported = new Map(features.map(f => [f.key, f.supported]))
  return (
    <div className="rounded-lg border border-border/70 bg-muted/40 p-4">
      <div className={cn('space-y-3', columns && 'sm:hidden')}>
        {MEDIA_SERVICE_FEATURE_GROUPS.map(group => <FeatureGroup key={group.title} group={group} supported={supported} listedDown={false} />)}
      </div>
      {columns ? (
        <div className="hidden sm:block">
          <div className="grid grid-cols-2 gap-6 xl:grid-cols-4">
            {MEDIA_SERVICE_FEATURE_GROUPS.map(group => <FeatureGroup key={group.title} group={group} supported={supported} listedDown />)}
          </div>
        </div>
      ) : null}
    </div>
  )
}

export default MediaServiceFeatures
