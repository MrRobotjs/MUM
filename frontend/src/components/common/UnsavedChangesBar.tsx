import { useEffect, useRef, useState } from 'react'
import { useBlocker } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'

export interface UnsavedChangesBarProps {
  /** Whether the form differs from what's saved. The bar shows only then. */
  dirty: boolean
  saving: boolean
  onReset: () => void
  /** The form the Save button submits. */
  formId: string
  saveLabel?: string
}

/**
 * The save bar for a page that is one settings form: it appears at the
 * bottom of the screen once something has changed and stays there until the
 * change is saved or reset. While there are unsaved changes, leaving the page
 * inside MUM is held and the bar asks for a save or reset first; closing or
 * reloading the tab asks the browser to confirm.
 */
export const UnsavedChangesBar = ({ dirty, saving, onReset, formId, saveLabel = 'Save changes' }: UnsavedChangesBarProps) => {
  const [warning, setWarning] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useBlocker({
    shouldBlockFn: () => {
      setWarning(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setWarning(false), 2500)
      return true
    },
    enableBeforeUnload: dirty,
    disabled: !dirty,
  })

  useEffect(() => {
    if (!dirty) setWarning(false)
  }, [dirty])
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  if (!dirty) return null
  return (
    <div className="sticky bottom-3 z-20" role="region" aria-label="Unsaved changes">
      <div className={cn('flex flex-col gap-3 rounded-lg border bg-popover p-3 shadow-lg sm:flex-row sm:items-center sm:justify-between',
        warning && 'border-destructive')}>
        <p className={cn('text-sm font-medium', warning && 'text-destructive')} role="status">
          {warning ? 'Save or reset your changes before leaving this page.' : 'Careful — you have unsaved changes!'}
        </p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onReset} disabled={saving}>Reset</Button>
          <Button type="submit" form={formId} disabled={saving}>
            {saving ? <Spinner className="size-4" /> : null}
            {saving ? 'Saving…' : saveLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}

export default UnsavedChangesBar
