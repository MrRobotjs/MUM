import * as React from "react"

import { requestJson } from "@/util/apiClient"

type SyncOptions = {
  onSuccess?: () => void
  onError?: (message: string) => void
}

export const useSyncServerLibraries = (serverId: number, options: SyncOptions = {}) => {
  const { onSuccess, onError } = options
  const [isSyncing, setIsSyncing] = React.useState(false)

  const sync = React.useCallback(async () => {
    if (isSyncing) return
    setIsSyncing(true)
    try {
      await requestJson(`/api/v2/servers/${serverId}/sync-libraries`, {
        method: "POST",
      })
      onSuccess?.()
    } catch (err: any) {
      const message = err?.message || "Failed to start library sync"
      onError?.(message)
      throw err
    } finally {
      setIsSyncing(false)
    }
  }, [isSyncing, onError, onSuccess, serverId])

  return {
    sync,
    isSyncing,
  }
}
