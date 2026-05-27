import { useEffect, useState } from 'react'

export type MetricType =
  | 'assigned' | 'searching' | 'cancelled' | 'completed'
  | 'active_rides' | 'available_drivers'

export interface MetricItem {
  id: string
  label: string
  detail?: string
  color?: string
}

interface MetricConfig {
  accent: string       // var(--green), var(--yellow), etc.
  accentLight: string  // var(--green-light), etc. — for pill backgrounds
  accentBorder: string // var(--border-success), etc. — for pill borders
  title: string
  countLabel: string   // short label below the big number
  what: string         // 2-3 sentence plain-English explanation
  facts: string[]      // monospace tags shown as chips
  how: string          // one sentence about the system behaviour
  highlightedStages: string[]
}

const CONFIGS: Record<MetricType, MetricConfig> = {
  assigned: {
    accent: 'var(--green)',
    accentLight: 'var(--green-light)',
    accentBorder: 'var(--border-success)',
    title: 'Assigned Rides',
    countLabel: 'matched to a driver right now',
    what: 'A driver has been found and the assignment is locked in the database. The ride is now moving through one of three sub-states: the driver is confirmed but hasn\'t started moving yet (driver_assigned), the driver is driving toward the pickup (driver_arriving), or the rider is already in the car (on_trip).',
    facts: ['SELECT FOR UPDATE SKIP LOCKED', 'ride.driver_id set', 'driver.status → busy', 'Redis Pub/Sub notifies rider + driver'],
    how: 'Once the row lock is acquired, the assignment commits to PostgreSQL and immediately fans out over two separate Redis channels — one for the rider, one for the driver — so both apps see the update in under a millisecond.',
    highlightedStages: ['driver_assigned', 'driver_arriving', 'on_trip'],
  },
  searching: {
    accent: 'var(--yellow)',
    accentLight: 'var(--yellow-light)',
    accentBorder: 'var(--border-warning)',
    title: 'Searching for Driver',
    countLabel: 'rides waiting for a driver right now',
    what: 'Each of these is a live Celery worker running the dispatch algorithm. It queries PostGIS for the 5 nearest available drivers within 3 km and tries each one — if none are free it expands to 5 km. The first unlocked driver found gets claimed and the ride transitions to Assigned.',
    facts: ['ST_DWithin(pickup, driver_loc, radius)', 'GiST spatial index', '3 km → 5 km fallback', 'up to 5 candidates per ring'],
    how: 'Concurrent dispatches are safe — every worker uses SKIP LOCKED so two tasks atomically skip the same driver and never double-assign. The first to acquire the row lock wins; the others move on to the next candidate.',
    highlightedStages: ['searching_driver'],
  },
  cancelled: {
    accent: 'var(--red)',
    accentLight: 'var(--red-light)',
    accentBorder: 'var(--border-error)',
    title: 'Cancelled Rides',
    countLabel: 'no driver found or rider cancelled',
    what: 'The dispatch engine searched both the 3 km and 5 km rings and exhausted all candidates without finding a free driver, or the rider cancelled the request manually. The ride is permanently closed, no driver was charged, and the outcome is written to the dispatch log.',
    facts: ['outcome = no_driver_found', 'state → cancelled', 'DispatchLog entry written', 'driver pool unaffected'],
    how: 'A ride_cancelled event is published to the rider\'s WebSocket channel and to the admin:metrics Pub/Sub stream instantly, so every connected dashboard reflects the cancellation without polling.',
    highlightedStages: ['cancelled'],
  },
  completed: {
    accent: 'var(--blue)',
    accentLight: 'var(--blue-light)',
    accentBorder: 'var(--blue-light)',
    title: 'Completed Rides',
    countLabel: 'trips finished successfully',
    what: 'The full lifecycle ran to completion — the driver arrived at pickup, the rider boarded, they reached the destination, and the final fare was calculated from actual distance and trip time with any surge multiplier applied. The driver is immediately freed for the next dispatch.',
    facts: ['fare = ₹50 base + ₹12/km + ₹2/min × surge', 'driver.status → available', 'active_ride_id cleared', 'ride_completed event published'],
    how: 'The driver row update and ride closure happen in one atomic transaction, then the ride_completed event fans out to the rider\'s channel and to admin:metrics — both carrying the full fare breakdown.',
    highlightedStages: ['completed'],
  },
  active_rides: {
    accent: 'var(--blue)',
    accentLight: 'var(--blue-light)',
    accentBorder: 'var(--blue-light)',
    title: 'Active Rides',
    countLabel: 'live in the system right now',
    what: 'Rides where the driver has been confirmed and work is in progress — either the driver is on the way to pickup, or the rider is already on board. All three underlying states (driver_assigned, driver_arriving, on_trip) roll up into this single count.',
    facts: ['states: driver_assigned, driver_arriving, on_trip', 'polled every 5 s via GET /api/metrics', 'SELECT status, COUNT(*) GROUP BY status'],
    how: 'This count hits PostgreSQL directly with no cache layer, so it always reflects the true current state. Every 5-second poll is a live aggregation query.',
    highlightedStages: ['driver_assigned', 'driver_arriving', 'on_trip'],
  },
  available_drivers: {
    accent: 'var(--green)',
    accentLight: 'var(--green-light)',
    accentBorder: 'var(--border-success)',
    title: 'Available Drivers',
    countLabel: 'online and ready for dispatch',
    what: 'Drivers who are online, have a registered GPS position, and are not currently on a ride. When a new request arrives, the dispatch engine runs a PostGIS nearest-neighbour query against exactly this pool to rank candidates by distance from the pickup point.',
    facts: ["driver.status = 'available'", 'PostGIS GEOGRAPHY column', 'GIST index → O(log n) lookup', 'heartbeat every 4 s'],
    how: 'Each driver heartbeat writes the latest GPS coordinate to PostgreSQL so the spatial index is always current. Drivers who go offline or stop sending heartbeats drop out of the available pool and are excluded from the next dispatch query.',
    highlightedStages: [],
  },
}

const LIFECYCLE_STAGES = [
  { id: 'requested',        label: 'New' },
  { id: 'searching_driver', label: 'Searching' },
  { id: 'driver_assigned',  label: 'Assigned' },
  { id: 'driver_arriving',  label: 'Arriving' },
  { id: 'on_trip',          label: 'On Trip' },
  { id: 'completed',        label: 'Done' },
]

// Section separator
function Divider() {
  return <div style={{ borderTop: '1px solid var(--border)', margin: '16px 0' }} />
}

// Small uppercase section label
function SectionLabel({ children }: { children: string }) {
  return (
    <div style={{
      fontSize: 10, fontWeight: 700, letterSpacing: '0.09em',
      textTransform: 'uppercase', color: 'var(--text-muted)',
      marginBottom: 10,
    }}>
      {children}
    </div>
  )
}

export function MetricsDetailModal({
  type, count, items, onClose,
}: {
  type: MetricType; count: number; items?: MetricItem[]; onClose: () => void
}) {
  const cfg = CONFIGS[type]
  const [closeHovered, setCloseHovered] = useState(false)

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  const isCancelType = type === 'cancelled'

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0,
          background: 'rgba(0,0,0,0.5)',
          backdropFilter: 'blur(2px)',
          zIndex: 1000,
        }}
      />

      {/* Modal */}
      <div
        className="no-scrollbar"
        style={{
          position: 'fixed',
          top: '50%', left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 'min(520px, calc(100vw - 32px))',
          maxHeight: 'calc(100vh - 48px)',
          overflowY: 'auto',
          background: 'var(--surface)',
          borderRadius: 12,
          boxShadow: '0 24px 64px rgba(0,0,0,0.22), 0 4px 12px rgba(0,0,0,0.12)',
          zIndex: 1001,
          border: '1px solid var(--border)',
        }}
      >
        {/* Accent bar */}
        <div style={{ height: 3, background: cfg.accent, borderRadius: '12px 12px 0 0' }} />

        <div style={{ padding: '22px 24px 24px', position: 'relative' }}>

          {/* Close button */}
          <button
            onMouseEnter={() => setCloseHovered(true)}
            onMouseLeave={() => setCloseHovered(false)}
            onClick={onClose}
            style={{
              position: 'absolute', top: 18, right: 18,
              width: 26, height: 26,
              border: `1px solid ${closeHovered ? 'var(--red)' : 'var(--border)'}`,
              borderRadius: 6,
              background: closeHovered ? 'var(--red)' : 'var(--surface)',
              color: closeHovered ? '#fff' : 'var(--text-muted)',
              cursor: 'pointer',
              fontSize: 15, fontWeight: 700, lineHeight: 1,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              transition: 'all 0.15s',
            }}
          >
            ×
          </button>

          {/* Header: accent left-bar + title */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            paddingRight: 36, marginBottom: 20,
          }}>
            <div style={{
              width: 3, height: 20, borderRadius: 2,
              background: cfg.accent, flexShrink: 0,
            }} />
            <span style={{
              fontSize: 16, fontWeight: 700,
              color: 'var(--text)', lineHeight: 1.2,
            }}>
              {cfg.title}
            </span>
          </div>

          {/* Count display */}
          <div style={{ marginBottom: 4 }}>
            <span style={{
              fontSize: 48, fontWeight: 800,
              color: cfg.accent, lineHeight: 1,
              fontFamily: "'Inter', system-ui, sans-serif",
              letterSpacing: '-0.02em',
            }}>
              {count}
            </span>
          </div>
          <div style={{
            fontSize: 12, color: 'var(--text-muted)',
            fontWeight: 500, marginBottom: 0,
          }}>
            {cfg.countLabel}
          </div>

          <Divider />

          {/* What does this mean */}
          <SectionLabel>What this means</SectionLabel>
          <p style={{
            fontSize: 13, color: 'var(--text)',
            lineHeight: 1.7, margin: 0,
          }}>
            {cfg.what}
          </p>

          <Divider />

          {/* Lifecycle flow */}
          <SectionLabel>Ride lifecycle</SectionLabel>
          <div>
            {/* Main stages */}
            <div style={{
              display: 'flex', alignItems: 'center',
              flexWrap: 'wrap', gap: '5px 2px',
            }}>
              {LIFECYCLE_STAGES.map((stage, i) => {
                const hl = cfg.highlightedStages.includes(stage.id)
                return (
                  <span key={stage.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                    <span style={{
                      padding: '3px 9px', borderRadius: 99,
                      fontSize: 11, fontWeight: hl ? 600 : 400,
                      background: hl ? cfg.accentLight : 'transparent',
                      color: hl ? cfg.accent : 'var(--text-muted)',
                      border: `1px solid ${hl ? cfg.accentBorder : 'var(--border)'}`,
                      letterSpacing: hl ? '0.01em' : undefined,
                    }}>
                      {stage.label}
                    </span>
                    {i < LIFECYCLE_STAGES.length - 1 && (
                      <span style={{ color: 'var(--border)', fontSize: 12, userSelect: 'none', lineHeight: 1 }}>
                        ›
                      </span>
                    )}
                  </span>
                )
              })}
            </div>
            {/* Cancelled branch — always on its own line */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6,
              marginTop: 7, paddingLeft: 4,
            }}>
              <span style={{ color: 'var(--text-muted)', fontSize: 11, userSelect: 'none' }}>↘</span>
              <span style={{
                padding: '3px 9px', borderRadius: 99,
                fontSize: 11, fontWeight: isCancelType ? 600 : 400,
                background: isCancelType ? 'var(--red-light)' : 'transparent',
                color: isCancelType ? 'var(--red)' : 'var(--text-muted)',
                border: `1px solid ${isCancelType ? 'var(--border-error)' : 'var(--border)'}`,
              }}>
                Cancelled
              </span>
              <span style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>
                if no driver found or rider cancels
              </span>
            </div>
          </div>

          <Divider />

          {/* How it works */}
          <SectionLabel>How it works</SectionLabel>

          {/* Fact tags */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px 6px', marginBottom: 10 }}>
            {cfg.facts.map((f, i) => (
              <span key={i} style={{
                fontSize: 11, fontFamily: 'ui-monospace, monospace',
                background: 'var(--gray-light)',
                color: 'var(--text-mono)',
                padding: '2px 8px', borderRadius: 4,
                border: '1px solid var(--border)',
                letterSpacing: '0.01em',
              }}>
                {f}
              </span>
            ))}
          </div>

          {/* Prose */}
          <p style={{
            fontSize: 12, color: 'var(--text-muted)',
            lineHeight: 1.65, margin: 0,
            fontStyle: 'italic',
          }}>
            {cfg.how}
          </p>

          {/* Items list */}
          {items && items.length > 0 && (
            <>
              <Divider />
              <SectionLabel>{`Current (${items.length})`}</SectionLabel>
              <div className="no-scrollbar" style={{ maxHeight: 200, overflowY: 'auto' }}>
                {items.map(item => (
                  <div key={item.id} style={{
                    display: 'flex', alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '6px 0 6px 10px',
                    borderBottom: '1px solid var(--border)',
                    borderLeft: `2px solid ${item.color ?? cfg.accent}`,
                    marginLeft: 2, paddingLeft: 10,
                    gap: 8,
                  }}>
                    <span style={{
                      fontFamily: 'ui-monospace, monospace',
                      color: 'var(--text-muted)', fontSize: 11,
                      flexShrink: 0,
                    }}>
                      {item.label}
                    </span>
                    {item.detail && (
                      <span style={{
                        color: item.color ?? 'var(--text)',
                        fontWeight: 500, fontSize: 12,
                        textAlign: 'right',
                      }}>
                        {item.detail}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}

        </div>
      </div>
    </>
  )
}
