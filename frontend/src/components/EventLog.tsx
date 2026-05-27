import { useEffect, useRef } from 'react'
import type { WsStatus } from '../hooks/useWebSocket'

export type LogType = 'info' | 'event' | 'ws' | 'error' | 'system'

export interface LogEntry {
  id: string
  time: string
  type: LogType
  headline: string
  detail?: string
}

interface Props {
  entries: LogEntry[]
  wsStatus: WsStatus
  title?: string
}

const WS_LABEL: Record<WsStatus, string> = {
  connecting:   'Connecting...',
  connected:    'Connected',
  reconnecting: 'Reconnecting...',
  disconnected: 'Disconnected',
}

export function EventLog({ entries, wsStatus, title = 'Live Event Log' }: Props) {
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    if (distanceFromBottom < 80) el.scrollTop = el.scrollHeight
  }, [entries.length])

  return (
    <div className="event-log-wrap">
      <div className="event-log-header">
        <span className="event-log-title">{title}</span>
        <div className="ws-indicator">
          <span className={`ws-dot ${wsStatus}`} />
          <span>WS: {WS_LABEL[wsStatus]}</span>
        </div>
      </div>

      <div className="event-log-body" ref={bodyRef}>
        {entries.length === 0 ? (
          <div className="log-empty">Waiting for events...</div>
        ) : (
          entries.map((e) => (
            <div key={e.id} className="log-entry">
              <span className="log-time">{e.time}</span>
              <span className={`log-type ${e.type}`}>[{e.type.toUpperCase()}]</span>
              <span className="log-message">
                {e.headline}
                {e.detail && <span className="log-detail">{e.detail}</span>}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

// ── Helpers ────────────────────────────────────────────────────────────────

let _seq = 0
export function logEntry(type: LogType, headline: string, detail?: string): LogEntry {
  return {
    id: `${Date.now()}-${_seq++}`,
    time: new Date().toTimeString().slice(0, 8),
    type,
    headline,
    detail,
  }
}

/** Translates a raw WebSocket event object into a human-readable log entry. */
export function translateWsEvent(data: Record<string, unknown>): LogEntry {
  const event = data.event as string
  const plain = (fallback: string) =>
    typeof data.message_plain === 'string' && data.message_plain.trim().length > 0
      ? data.message_plain
      : fallback
  const tech = (fallback?: string) =>
    typeof data.message_tech === 'string' && data.message_tech.trim().length > 0
      ? data.message_tech
      : fallback

  switch (event) {
    case 'driver_assigned':
      return logEntry(
        'event',
        plain(`A driver has been found and is on the way!`),
        tech(`Matched after ${data.attempt} attempt(s) within ${data.radius_km} km · driver_id: ${data.driver_id} · locked via SELECT FOR UPDATE`),
      )

    case 'ride_cancelled':
      if (data.reason === 'no_driver_available') {
        return logEntry(
          'error',
          plain('No available drivers could be found nearby — the ride was cancelled.'),
          tech(`Searched 3 km radius, expanded to 5 km, still no match · reason: no_driver_available`),
        )
      }
      return logEntry('error', plain('This ride has been cancelled.'), tech(`reason: ${data.reason}`))

    case 'ride_assigned':
      return logEntry(
        'ws',
        plain("You've been matched! A rider nearby needs a pickup."),
        tech(`The dispatch engine picked you as the closest available driver · ride_id: ${data.ride_id}`),
      )

    case 'status_update': {
      const label: Record<string, [string, string?]> = {
        driver_arriving: ["The driver confirmed they're heading to your pickup point.", 'status: driver_arriving · rider notified via WebSocket'],
        on_trip:         ['Rider has been picked up — the trip is now in progress!', 'status: on_trip'],
        completed:       ['Trip completed! The ride has ended successfully.', 'status: completed · ride lifecycle done'],
      }
      const [headline, detail] = label[data.status as string] ?? [`Status changed: ${data.status}`]
      return logEntry('event', plain(headline), tech(detail))
    }

    case 'location_update':
      return logEntry(
        'info',
        `Driver moved — location refreshed.`,
        `lat: ${(data.lat as number).toFixed(5)}, lng: ${(data.lng as number).toFixed(5)} · Redis TTL reset`,
      )

    default:
      return logEntry('info', `Event received: ${event}`, JSON.stringify(data))
  }
}
