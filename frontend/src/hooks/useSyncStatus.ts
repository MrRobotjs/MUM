import { useEffect, useState } from 'react'
import { io, Socket } from 'socket.io-client'
import { getAccessToken } from '../util/tokenStore'

interface SyncProgress {
  current_server: number
  total_servers: number
  current_server_name: string | null
}

export interface SyncStatus {
  is_syncing: boolean
  started_at: string | null
  started_by: number | null
  started_by_username: string | null
  progress: SyncProgress
}

const defaultStatus: SyncStatus = {
  is_syncing: false,
  started_at: null,
  started_by: null,
  started_by_username: null,
  progress: {
    current_server: 0,
    total_servers: 0,
    current_server_name: null,
  },
}

let syncSocket: Socket | null = null
let syncListeners: Set<(status: SyncStatus) => void> = new Set()
let latestStatus: SyncStatus = defaultStatus
let hasSnapshot = false
let activeSubscribers = 0
let authListenersBound = false

const ensureSocket = () => {
  if (syncSocket) {
    return syncSocket
  }

  const socket = io({
    path: '/socket.io/',
    transports: ['websocket', 'polling'],
    auth: { access_token: getAccessToken() || undefined },
  })

  socket.on('connect', () => {
    if (activeSubscribers > 0) {
      socket.emit('subscribe_sync_status')
    }
  })

  socket.on('sync_status_update', (payload: SyncStatus) => {
    latestStatus = payload
    hasSnapshot = true
    syncListeners.forEach((listener) => {
      try {
        listener(payload)
      } catch (err) {
        console.error('[SyncStatusSocket] listener error:', err)
      }
    })
  })

  socket.on('subscription_error', (data: any) => {
    console.error('[SyncStatusSocket] subscription error:', data)
  })

  socket.on('connect_error', (err) => {
    console.warn('[SyncStatusSocket] connect error:', err?.message || err)
  })

  // keep auth fresh
  if (!authListenersBound) {
    window.addEventListener('auth_token_updated', ((event: Event) => {
      const token = (event as CustomEvent)?.detail?.accessToken as string | undefined
      if (token && syncSocket?.connected) {
        syncSocket.emit('auth_update', { access_token: token })
      }
    }) as EventListener)

    window.addEventListener('auth_logged_out', (() => {
      if (syncSocket) {
        try {
          syncSocket.emit('unsubscribe_sync_status')
        } catch {}
        try {
          syncSocket.disconnect()
        } catch {}
      }
      syncSocket = null
      hasSnapshot = false
      latestStatus = defaultStatus
    }) as EventListener)

    authListenersBound = true
  }

  syncSocket = socket
  return socket
}

export const useSyncStatus = () => {
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(latestStatus)
  const [loading, setLoading] = useState(!hasSnapshot)

  useEffect(() => {
    const socket = ensureSocket()
    activeSubscribers += 1
    if (socket.connected) {
      socket.emit('subscribe_sync_status')
    }

    const listener = (status: SyncStatus) => {
      setSyncStatus(status)
      setLoading(false)
    }

    syncListeners.add(listener)

    return () => {
      syncListeners.delete(listener)
      activeSubscribers = Math.max(0, activeSubscribers - 1)
      if (activeSubscribers === 0 && syncSocket) {
        try {
          syncSocket.emit('unsubscribe_sync_status')
        } catch {}
      }
    }
  }, [])

  return { syncStatus, loading }
}
