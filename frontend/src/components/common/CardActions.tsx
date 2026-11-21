import { type ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * The buttons at the bottom of a card that saves on its own: at the right on
 * a wide screen and full width on a phone. Put the card's Save last: it sits
 * rightmost on a wide screen and on top on a phone. Pages that are one form
 * use UnsavedChangesBar instead.
 */
export const CardActions = ({ children, className }: { children: ReactNode; className?: string }) => (
  <div className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}>{children}</div>
)

export default CardActions
