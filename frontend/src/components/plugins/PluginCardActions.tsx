import { type Plugin } from '../../hooks/usePlugins'
import { Button } from '@/components/ui/button'

export interface PluginCardActionsProps {
  plugin: Plugin
  pluginKey: string
  hasServers: boolean
  isLoading: boolean
  onToggle: (plugin: Plugin, action: 'enable' | 'disable') => void
  onConfigure: (pluginKey: string) => void
}

export const PluginCardActions = ({
  plugin,
  pluginKey,
  hasServers,
  isLoading,
  onToggle,
  onConfigure
}: PluginCardActionsProps) => {
  return (
    <>
      <Button
        size="sm"
        variant={plugin.enabled ? 'outline' : 'default'}
        onClick={() =>
          plugin.enabled
            ? onToggle(plugin, 'disable')
            : onToggle(plugin, 'enable')
        }
        disabled={isLoading || (!plugin.enabled && !hasServers)}
      >
        {isLoading ? 'Working…' : plugin.enabled ? 'Disable' : 'Enable'}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => onConfigure(pluginKey)}
        disabled={isLoading}
      >
        Configure
      </Button>
      {plugin.repository_url ? (
        <Button
          asChild
          size="sm"
          variant="ghost"
          className="gap-2"
        >
          <a href={plugin.repository_url} target="_blank" rel="noopener noreferrer">
            <i className="fa-brands fa-github" /> Repository
          </a>
        </Button>
      ) : null}
    </>
  )
}

export default PluginCardActions
