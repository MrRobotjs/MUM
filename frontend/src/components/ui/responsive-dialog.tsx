import type { ReactNode } from "react"

import { cn } from "@/lib/utils"
import { useIsMobile } from "@/hooks/use-mobile"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"

type ResponsiveDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  title?: ReactNode
  description?: ReactNode
  children: ReactNode
  footer?: ReactNode
  contentClassName?: string
  bodyClassName?: string
  footerClassName?: string
  sheetSide?: "top" | "right" | "bottom" | "left"
  /**
   * When true, pins the footer to the bottom of the dialog/sheet with a subtle background.
   */
  stickyFooter?: boolean
  headerClassName?: string
}

export function ResponsiveDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  contentClassName,
  bodyClassName,
  footerClassName,
  sheetSide = "bottom",
  stickyFooter = false,
  headerClassName,
}: ResponsiveDialogProps) {
  const isMobile = useIsMobile()

  const handleOpenChange = (value: boolean) => {
    onOpenChange(value)
  }

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={handleOpenChange}>
        <SheetContent
          side={sheetSide}
          className={cn(
            "flex h-auto max-h-[85vh] flex-col rounded-t-xl",
            contentClassName
          )}
        >
          {(title || description) && (
            <SheetHeader className={cn("px-0", headerClassName)}>
              {title ? <SheetTitle>{title}</SheetTitle> : null}
              {description ? (
                <SheetDescription>{description}</SheetDescription>
              ) : null}
            </SheetHeader>
          )}
          <div
            className={cn("flex-1 overflow-y-auto px-0", bodyClassName)}
          >
            {children}
          </div>
          {footer ? (
            <div
              className={cn(
                "mt-4 flex flex-col-reverse gap-2 border-t border-border bg-background/95 p-4 sm:flex-row sm:justify-end",
                stickyFooter ? "sticky bottom-0 z-10" : "",
                footerClassName
              )}
            >
              {footer}
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    )
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className={contentClassName}>
        {(title || description) && (
          <DialogHeader className={headerClassName}>
            {title ? <DialogTitle>{title}</DialogTitle> : null}
            {description ? (
              <DialogDescription>{description}</DialogDescription>
            ) : null}
          </DialogHeader>
        )}
        <div className={cn("max-h-[70vh] overflow-y-auto", bodyClassName)}>
          {children}
        </div>
        {footer ? (
          <DialogFooter
            className={cn(
              stickyFooter ? "sticky bottom-0 z-10 border-t border-border bg-background/95" : "",
              footerClassName
            )}
          >
            {footer}
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

export default ResponsiveDialog
