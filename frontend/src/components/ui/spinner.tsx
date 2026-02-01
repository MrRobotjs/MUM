import { FontAwesomeIcon } from "@fortawesome/react-fontawesome"
import { faSpinner } from "@fortawesome/free-solid-svg-icons"

import { cn } from "@/lib/utils"

function Spinner({ className, ...props }: React.ComponentProps<typeof FontAwesomeIcon>) {
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
