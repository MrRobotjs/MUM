import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faCircleInfo, faTriangleExclamation } from '@fortawesome/free-solid-svg-icons'
import { InfoButton } from '../common/InfoButton'
import type { MediaService } from '../../hooks/useMediaServices'
import type { Server } from '../../hooks/useServers'

/** The server release MUM was last checked against, on a media service's card. */
export function TestedVersionLine({ service }: { service: MediaService }) {
  return (
    <div className="flex items-center gap-1 text-xs text-muted-foreground">
      <span>{service.testedVersion ? `Tested with ${service.name} ${service.testedVersion}` : 'Not yet tested with a real server'}</span>
      <InfoButton title="Tested version" label={`About the tested ${service.name} version`}>
        <p>
          {service.testedVersion
            ? `MUM is checked against ${service.name} ${service.testedVersion}. Other versions may work, but they haven’t been verified until MUM is updated for them.`
            : `MUM has been built from ${service.name}’s published API but hasn’t been checked against a real ${service.name} server yet.`}
        </p>
        <p>Each server shows a note when its version is newer or older than the tested one. Only current server versions are supported, so keep servers up to date.</p>
      </InfoButton>
    </div>
  )
}

/** A note on a server whose version differs from the tested one; nothing when it matches or is unknown. */
export function ServerVersionNote({ service, server }: { service: MediaService; server: Server }) {
  if (server.version_check === 'newer') {
    return (
      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <FontAwesomeIcon icon={faCircleInfo} className="mt-0.5" />
        <span>Newer than the tested version ({service.testedVersion}): it may work, but hasn’t been checked.</span>
      </p>
    )
  }
  if (server.version_check === 'older') {
    return (
      <p className="flex items-start gap-2 text-xs text-amber-600 dark:text-amber-400">
        <FontAwesomeIcon icon={faTriangleExclamation} className="mt-0.5" />
        <span>Older than the tested version ({service.testedVersion}): update this server. Older versions aren’t supported.</span>
      </p>
    )
  }
  return null
}
