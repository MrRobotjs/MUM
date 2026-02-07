import { FontAwesomeIcon, type FontAwesomeIconProps } from "@fortawesome/react-fontawesome"
import { faSpinner } from "@fortawesome/free-solid-svg-icons"

import { cn } from "@/lib/utils"

function Spinner({ className, ...props }: Omit<FontAwesomeIconProps, "icon">) {
  return (
    <FontAwesomeIcon
      role="status"
      aria-label="Loading"
      icon={faSpinner}
      className={cn("size-4 animate-spin", className)}
      {...props}
    />
  )
}

export { Spinner }
