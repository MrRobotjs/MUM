import { useEffect, useState, useCallback } from 'react'
import { requestJson } from '../util/apiClient'

export type SetupStatus = {
  account_complete: boolean
  app_complete: boolean
  plugins_complete: boolean
  discord_complete: boolean
  setup_complete: boolean
  completed_steps: string[]
}

type SetupStatusResponse = {
  data?: SetupStatus
}

export function useSetupStatus() {
  const [status, setStatus] = useState<SetupStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchStatus = useCallback(async () => {
    setLoading(true)
    try {
      const response = await requestJson<SetupStatusResponse>('/api/v2/setup/status')
      setStatus(response?.data ?? null)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load setup status')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchStatus()
  }, [fetchStatus])

  return { status, loading, error, refresh: fetchStatus }
}
