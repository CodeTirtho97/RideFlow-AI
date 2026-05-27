import { useEffect, useRef, useCallback, useState } from 'react'

export type WsStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected'

interface Options {
  onMessage: (data: Record<string, unknown>) => void
  onOpen?: () => void
  enabled?: boolean
}

const envWsBase = import.meta.env.VITE_WS_BASE_URL?.trim()
const wsBase = envWsBase ? envWsBase.replace(/\/+$/, '') : ''

function buildWebSocketUrl(path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  if (wsBase) return `${wsBase}${normalizedPath}`

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}${normalizedPath}`
}

export function useWebSocket(path: string, opts: Options): WsStatus {
  const [status, setStatus] = useState<WsStatus>('connecting')
  const wsRef = useRef<WebSocket | null>(null)
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const attemptsRef = useRef(0)
  const enabledRef = useRef(opts.enabled !== false)
  const onMessageRef = useRef(opts.onMessage)
  const onOpenRef = useRef(opts.onOpen)

  onMessageRef.current = opts.onMessage
  onOpenRef.current = opts.onOpen
  enabledRef.current = opts.enabled !== false

  const connect = useCallback(() => {
    if (!enabledRef.current || !path) return

    const url = buildWebSocketUrl(path)

    const ws = new WebSocket(url)
    wsRef.current = ws
    setStatus(attemptsRef.current === 0 ? 'connecting' : 'reconnecting')

    ws.onopen = () => {
      attemptsRef.current = 0
      setStatus('connected')
      onOpenRef.current?.()
    }

    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as Record<string, unknown>
        onMessageRef.current(data)
      } catch {
        // malformed message — ignore
      }
    }

    ws.onclose = () => {
      // Guard against stale close events fired after cleanup already nulled the ref
      // and the second StrictMode mount has started a fresh connection.
      if (wsRef.current !== ws) return
      wsRef.current = null
      if (!enabledRef.current) {
        setStatus('disconnected')
        return
      }
      // Exponential backoff: 300ms, 600ms, 1200ms, cap at 4000ms
      const delay = Math.min(300 * Math.pow(2, attemptsRef.current), 4000)
      attemptsRef.current += 1
      setStatus('reconnecting')
      retryRef.current = setTimeout(connect, delay)
    }

    ws.onerror = () => {
      ws.close()
    }
  }, [path])

  useEffect(() => {
    // Keep the runtime flag in sync inside the effect itself.
    // In React StrictMode, cleanup can run before a second effect pass
    // without an intervening render; this prevents stale "false" state.
    enabledRef.current = opts.enabled !== false

    if (opts.enabled === false) {
      wsRef.current?.close()
      if (retryRef.current) clearTimeout(retryRef.current)
      setStatus('disconnected')
      return
    }
    connect()
    return () => {
      enabledRef.current = false
      if (retryRef.current) clearTimeout(retryRef.current)
      // Null the ref BEFORE closing so the onclose handler sees a stale socket
      // and skips the reconnect logic — prevents double-connection on StrictMode.
      const stale = wsRef.current
      wsRef.current = null
      stale?.close()
    }
  }, [connect, opts.enabled, path])

  return status
}
