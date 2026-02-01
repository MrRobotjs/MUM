import { FontAwesomeIcon } from "@fortawesome/react-fontawesome"
import {
  faCircleCheck,
  faCircleInfo,
  faTriangleExclamation,
  faCircleXmark,
  faSpinner,
} from "@fortawesome/free-solid-svg-icons"
import { Toaster as Sonner, type ToasterProps } from "sonner"

const Toaster = ({ ...props }: ToasterProps) => {
  // Use the current theme from document element
  const theme = document.documentElement.classList.contains('dark') ? 'dark' : 'light'

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      closeButton
      icons={{
        success: <FontAwesomeIcon icon={faCircleCheck} className="size-4" />,
        info: <FontAwesomeIcon icon={faCircleInfo} className="size-4" />,
        warning: <FontAwesomeIcon icon={faTriangleExclamation} className="size-4" />,
        error: <FontAwesomeIcon icon={faCircleXmark} className="size-4" />,
        loading: <FontAwesomeIcon icon={faSpinner} className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
