import { type ReactElement } from 'react'
import { getServiceIcon } from '@/config/mediaServiceMetadata'

export type ServiceIconProps = {
  serviceType?: string
  className?: string
}

export const ServiceIcon = ({ serviceType, className }: ServiceIconProps): ReactElement => {
  return getServiceIcon(serviceType, className)
}

