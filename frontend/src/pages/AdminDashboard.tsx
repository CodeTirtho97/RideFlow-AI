import { useState, useCallback, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { AppNav } from '../components/AppNav'
import { PageHeader } from '../components/PageHeader'
import { BarChart3 } from 'lucide-react'
import { EventLog, logEntry } from '../components/EventLog'
import type { LogEntry } from '../components/EventLog'
import { useWebSocket } from '../hooks/useWebSocket'
import { InfoModal } from '../components/InfoModal'
import { useToast } from '../components/Toast'
import { MetricsDetailModal } from '../components/MetricsDetailModal'
import { UsageLimitModal } from '../components/UsageLimitModal'
import { useGlobalLimitListener } from '../hooks/useGlobalLimitListener'
import type { MetricType, MetricItem } from '../components/MetricsDetailModal'
import { getMetrics, demoReset, getAvailableDrivers } from '../api/client'
import type { SystemMetrics, AvailableDriver } from '../api/client'

const EMPTY_METRICS: SystemMetrics = {
  drivers: { available: 0, busy: 0, offline: 0, total: 0 },
  rides:   { active: 0, completed: 0, cancelled: 0, total: 0 },
  by_status: {},
}

function MetricCard({ value, label, sub, color, onClick }: {
  value: number; label: string; sub?: string; color?: string; onClick?: () => void
}) {
  return (
    <div
      className="metric-card"
      onClick={onClick}
      style={onClick ? { cursor: 'pointer' } : undefined}
      title={onClick ? 'Click for details' : undefined}
    >
      <div className="metric-value" style={color ? { color } : undefined}>{value}</div>
      <div className="metric-label">{label}</div>
      {sub && <div className="metric-sub">{sub}</div>}
    </div>
  )
}

function DriverPoolBar({ available, busy, offline }: { available: number; busy: number; offline: number }) {
  const total = available + busy + offline || 1
  const pct = (n: number) => `${((n / total) * 100).toFixed(0)}%`
  return (
    <div className="pool-bar-wrap">
      <div className="pool-bar">
        <div className="pool-bar-seg" style={{ width: pct(available), background: 'var(--green)' }} />
        <div className="pool-bar-seg" style={{ width: pct(busy),      background: 'var(--blue)' }} />
        <div className="pool-bar-seg" style={{ width: pct(offline),   background: 'var(--gray)' }} />
      </div>
      <div className="pool-legend">
        <div className="pool-legend-item">
          <span className="pool-dot" style={{ background: 'var(--green)' }} />
          Available ({available})
        </div>
        <div className="pool-legend-item">
          <span className="pool-dot" style={{ background: 'var(--blue)' }} />
          On Ride ({busy})
        </div>
        <div className="pool-legend-item">
          <span className="pool-dot" style={{ background: 'var(--gray)' }} />
          Offline ({offline})
        </div>
      </div>
    </div>
  )
}

interface RideActivity {
  rideId: string
  status: 'searching' | 'matched' | 'cancelled' | 'in_progress' | 'completed'
  driverName?: string
  radiusKm?: number
  time: string
  fare?: number
  distanceKm?: number
  durationMin?: number
  etaSeconds?: number
  etaStartedAt?: number
  surgeMultiplier?: number
  baseFare?: number
  distanceCharge?: number
  timeCharge?: number
  pickupLat?: number
  pickupLng?: number
  destLat?: number
  destLng?: number
  attemptNo?: number
  matchLatencyMs?: number
  timestamp?: number
}

const short = (id: string) => id.slice(0, 8) + '…'

function plain(data: Record<string, unknown>, fallback: string) {
  const msg = data.message_plain
  return typeof msg === 'string' && msg.trim().length > 0 ? msg : fallback
}

function tech(data: Record<string, unknown>, fallback: string) {
  const msg = data.message_tech
  return typeof msg === 'string' && msg.trim().length > 0 ? msg : fallback
}

function randomEta(minSec: number, maxSec: number) {
  return {
    etaSeconds: Math.floor(Math.random() * (maxSec - minSec + 1)) + minSec,
    etaStartedAt: Date.now(),
  }
}

function getRemaining(r: RideActivity): number {
  if (!r.etaSeconds || !r.etaStartedAt) return 0
  return Math.max(0, r.etaSeconds - (Date.now() - r.etaStartedAt) / 1000)
}

function formatEta(sec: number): string {
  if (sec <= 0) return 'now'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return m > 0 ? `${m}m ${s.toString().padStart(2, '0')}s` : `${s}s`
}


function formatRideTime(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`
}

function DetailRow({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11 }}>
      <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>{label}</span>
      <span style={{ color: 'var(--text)', fontWeight: 500, textAlign: 'right' }}>{value ?? '—'}</span>
    </div>
  )
}

export default function AdminDashboard() {
  useEffect(() => { document.title = 'Admin | RideFlow AI' }, [])

  const { toast } = useToast()
  const globalLimitReached = useGlobalLimitListener()
  const prevWsStatusRef = useRef<string>('disconnected')
  const [detailModal, setDetailModal] = useState<{ type: MetricType; count: number; items?: MetricItem[] } | null>(null)

  const [metrics, setMetrics] = useState<SystemMetrics>(EMPTY_METRICS)
  const [lastRefresh, setLastRefresh] = useState<string>('—')
  const [availableDrivers, setAvailableDrivers] = useState<AvailableDriver[]>([])
  const [rideActivity, setRideActivity] = useState<RideActivity[]>([])
  const [clearing, setClearing] = useState(false)
  const [logs, setLogs] = useState<LogEntry[]>([
    logEntry('system', 'Welcome to the Admin Dashboard. Connecting to the live metrics stream...'),
  ])
  const [showExplainModal, setShowExplainModal] = useState(false)
  const [aiHotspots, setAiHotspots] = useState<import('../api/client').AiHotspot[]>([])
  const [activeAdminHotspotIdx, setActiveAdminHotspotIdx] = useState(0)
  const metricsRef = useRef(metrics)
  metricsRef.current = metrics

  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick(n => n + 1), 1000)
    return () => clearInterval(id)
  }, [])

  const [expandedRides, setExpandedRides] = useState<Set<string>>(new Set())
  const toggleExpanded = useCallback((id: string) => {
    setExpandedRides(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const addLog = useCallback((e: LogEntry) => {
    setLogs(prev => [...prev, e])
  }, [])

  const upsertActivity = useCallback((rideId: string, patch: Partial<Omit<RideActivity, 'rideId'>>) => {
    setRideActivity(prev => {
      const idx = prev.findIndex(r => r.rideId === rideId)
      const time = new Date().toLocaleTimeString()
      if (idx === -1) {
        const entry: RideActivity = { rideId, status: 'searching', time, timestamp: Date.now(), ...patch }
        return [entry, ...prev].slice(0, 30)
      }
      const updated = [...prev]
      updated[idx] = { ...updated[idx], ...patch, time }
      return updated
    })
  }, [])

  const refreshMetrics = useCallback(async () => {
    try {
      const [metricsRes, driversRes] = await Promise.all([getMetrics(), getAvailableDrivers()])
      const m = metricsRes.data
      setMetrics(m)
      setAvailableDrivers(driversRes.data)
      setLastRefresh(new Date().toTimeString().slice(0, 8))
      if (m.drivers.total === 0 && m.rides.total === 0) {
        setAiHotspots([])
        setActiveAdminHotspotIdx(0)
      }
    } catch {
      addLog(logEntry('error', 'Could not reach backend metrics endpoint.'))
      toast({
        type: 'error',
        title: 'Metrics Unavailable',
        message: 'Could not fetch system metrics from the backend.',
        steps: [
          'Start the backend: cd backend && uvicorn app.main:app --reload',
          'Verify port 8000 is accessible (check CORS and firewall settings)',
          'Ensure DEMO_MODE=true is set in backend/.env',
        ],
      })
    }
  }, [addLog, toast])

  useEffect(() => {
    refreshMetrics()
    const id = setInterval(refreshMetrics, 5_000)
    return () => clearInterval(id)
  }, [refreshMetrics])

  const handleClearData = useCallback(async () => {
    setClearing(true)
    addLog(logEntry('system', 'Erasing all drivers and rides from the database…', 'POST /api/demo/reset'))
    try {
      await demoReset()
      setMetrics(EMPTY_METRICS)
      setRideActivity([])
      setLastRefresh('—')
      setAiHotspots([])
      setActiveAdminHotspotIdx(0)
      setAvailableDrivers([])
      addLog(logEntry('event', 'All data cleared — system is back to a clean state. Safe to demo again.'))
    } catch {
      addLog(logEntry('error', 'Clear failed. Is the backend running on port 8000?'))
      toast({
        type: 'error',
        title: 'Clear Failed',
        message: 'Could not erase demo data from the backend.',
        steps: ['Start the backend: cd backend && uvicorn app.main:app --reload'],
      })
    } finally {
      setClearing(false)
    }
  }, [addLog, toast])

  const wsStatus = useWebSocket('/ws/admin', {
    enabled: true,
    onOpen: () => {
      addLog(logEntry('ws', "Connected to the admin stream. Live events will appear here.", 'WebSocket /ws/admin · admin:metrics + ai:alerts channels'))
      refreshMetrics()
    },
    onMessage: (data) => {
      const event = data.event as string
      const rideId = data.ride_id as string | undefined

      if (event === 'ride_searching' || event === 'ride_created') {
        if (rideId) upsertActivity(rideId, { status: 'searching' })
        addLog(logEntry('info',
          plain(data, 'Ride queued for dispatch.'),
          tech(data, `ride_id: ${rideId ? short(rideId) : '?'} · status → searching_driver`),
        ))

      } else if (event === 'dispatch_started') {
        if (rideId) upsertActivity(rideId, {
          status: 'searching',
          pickupLat: data.pickup_lat as number | undefined,
          pickupLng: data.pickup_lng as number | undefined,
        })
        addLog(logEntry('info',
          plain(data, 'Dispatch engine started — querying nearby drivers.'),
          tech(data, `ride: ${rideId ? short(rideId) : '?'} · pickup: ${data.pickup_lat}°N, ${data.pickup_lng}°E`),
        ))

      } else if (event === 'dispatch_searching') {
        addLog(logEntry('info',
          plain(data, `Searching ${data.radius_km} km radius — ${data.candidates_found} candidate(s) found.`),
          tech(data, `ride: ${rideId ? short(rideId) : '?'} · ST_DWithin(pickup, driver_location, ${data.radius_km}km)`),
        ))

      } else if (event === 'driver_skipped') {
        addLog(logEntry('info',
          plain(data, 'Nearest driver already claimed. Trying next.'),
          tech(data, `ride: ${rideId ? short(rideId) : '?'} · driver: ${data.driver_id ? short(data.driver_id as string) : '?'} · SELECT FOR UPDATE SKIP LOCKED`),
        ))

      } else if (event === 'ride_assigned' || event === 'dispatch_complete') {
        const driverName = (data.driver_name as string) || 'Driver'
        if (rideId) upsertActivity(rideId, {
          status: 'matched',
          driverName,
          radiusKm: data.radius_km as number | undefined,
          attemptNo: data.attempt as number | undefined,
          matchLatencyMs: data.latency_ms as number | undefined,
          ...randomEta(6, 12),
        })
        addLog(logEntry('event',
          plain(data, `Matched → ${driverName}`),
          tech(data, `ride: ${rideId ? short(rideId) : '?'} · driver: ${data.driver_id ? short(data.driver_id as string) : '?'} · attempt ${data.attempt ?? 1} · ${data.radius_km ?? '?'} km · lock: ${data.latency_ms ?? '?'}ms`),
        ))

      } else if (event === 'ride_cancelled' || event === 'dispatch_failed') {
        if (rideId) upsertActivity(rideId, { status: 'cancelled' })
        addLog(logEntry('error',
          plain(data, data.reason === 'no_driver_available'
            ? 'Dispatch failed — no driver found within 3 km + 5 km. Ride cancelled.'
            : 'Ride cancelled by rider.'),
          tech(data, `ride: ${rideId ? short(rideId) : '?'} · reason: ${data.reason ?? 'no_driver_available'}`),
        ))

      } else if (event === 'status_update') {
        const s = data.status as string
        const driverName = data.driver_name as string | undefined

        if (s === 'driver_arriving') {
          if (rideId) upsertActivity(rideId, {
            status: 'matched',
            ...(driverName ? { driverName } : {}),
            ...randomEta(8, 14),
          })
          addLog(logEntry('info',
            plain(data, `${driverName || 'Driver'} is on the way to pickup.`),
            tech(data, `ride: ${rideId ? short(rideId) : '?'} · state=driver_arriving`),
          ))

        } else if (s === 'on_trip') {
          if (rideId) upsertActivity(rideId, {
            status: 'in_progress',
            ...(driverName ? { driverName } : {}),
            ...randomEta(10, 16),
          })
          addLog(logEntry('info',
            plain(data, `${driverName || 'Driver'} picked up rider. Trip in progress.`),
            tech(data, `ride: ${rideId ? short(rideId) : '?'} · state=on_trip · fare meter running`),
          ))

        } else if (s === 'completed') {
          if (rideId) upsertActivity(rideId, { status: 'completed', etaSeconds: undefined, etaStartedAt: undefined })
          addLog(logEntry('event',
            plain(data, 'Trip completed.'),
            tech(data, `ride: ${rideId ? short(rideId) : '?'} · state=completed`),
          ))
        }

      } else if (event === 'ride_completed') {
        const driverName      = data.driver_name as string | undefined
        const fare            = data.fare as number | undefined
        const distKm          = data.distance_km as number | undefined
        const durMin          = data.duration_display_min as number | undefined
        const surgeMult       = data.surge_multiplier as number | undefined
        const baseFare        = data.base_fare as number | undefined
        const distCharge      = data.distance_charge as number | undefined
        const timeCharge      = data.time_charge as number | undefined
        const destLat         = data.dest_lat as number | undefined
        const destLng         = data.dest_lng as number | undefined

        if (rideId) upsertActivity(rideId, {
          status: 'completed',
          ...(driverName  ? { driverName }                    : {}),
          ...(fare     != null ? { fare }                     : {}),
          ...(distKm   != null ? { distanceKm: distKm }       : {}),
          ...(durMin   != null ? { durationMin: durMin }       : {}),
          ...(surgeMult != null ? { surgeMultiplier: surgeMult } : {}),
          ...(baseFare  != null ? { baseFare }                 : {}),
          ...(distCharge != null ? { distanceCharge: distCharge } : {}),
          ...(timeCharge != null ? { timeCharge }              : {}),
          ...(destLat  != null ? { destLat }                  : {}),
          ...(destLng  != null ? { destLng }                  : {}),
          etaSeconds: undefined,
          etaStartedAt: undefined,
        })
        addLog(logEntry('event',
          plain(data, `Trip complete! ${driverName || 'Driver'} · ₹${fare?.toFixed(2) ?? '?'} · ${distKm ?? '?'} km · ${durMin ?? '?'} min`),
          tech(data, `ride: ${rideId ? short(rideId) : '?'} · ${data.message_tech ?? 'state=completed · driver reset=available'}`),
        ))
        refreshMetrics()

      } else if (event === 'surge_alert') {
        addLog(logEntry('system',
          `Surge pricing active in ${data.zone} — ${data.multiplier}x multiplier.`,
          `demand/supply ratio exceeded threshold · zone: ${data.zone}`,
        ))
      } else if (event === 'ai_cycle_update') {
        const incoming = (data.hotspots as import('../api/client').AiHotspot[]) || []
        setAiHotspots(incoming)
        setActiveAdminHotspotIdx(0)
        if (incoming.length > 0) {
          addLog(logEntry('system',
            `AI update: ${incoming.length} demand hotspot(s)`,
            incoming.map((h: import('../api/client').AiHotspot) => `${h.zone_name} — ${h.shortage} shortage`).join(' | '),
          ))
        }
      } else if (event === 'metrics_update') {
        if (data.drivers && data.rides) {
          setMetrics(data as unknown as SystemMetrics)
          setLastRefresh(new Date().toTimeString().slice(0, 8))
        }
      } else if (event === 'driver_location') {
        // High-frequency pings — suppress from log
      } else {
        addLog(logEntry('info', `Event: ${event}`, JSON.stringify(data)))
      }

      if (['ride_assigned', 'dispatch_complete', 'ride_cancelled', 'dispatch_failed', 'ride_completed'].includes(event)) {
        refreshMetrics()
      }
    },
  })

  useEffect(() => {
    if (prevWsStatusRef.current === 'connected' && wsStatus === 'disconnected') {
      toast({
        type: 'warning',
        title: 'Admin Stream Disconnected',
        message: 'The admin WebSocket feed has dropped. Live events will not appear until reconnected.',
        steps: [
          'The system will attempt to reconnect automatically',
          'If this persists, refresh the page (F5)',
          'Check that the backend is running: cd backend && uvicorn app.main:app --reload',
        ],
      })
    }
    prevWsStatusRef.current = wsStatus
  }, [wsStatus, toast])

  const { drivers, rides } = metrics

  const adminStatusColor = (s: string) =>
    s === 'Critical' ? 'var(--red)' : s === 'High' ? 'var(--orange)' : s === 'Moderate' ? 'var(--yellow)' : 'var(--green)'
  const adminTotalShortage = aiHotspots.reduce((s, h) => s + h.shortage, 0)
  const adminTotalDeploy = aiHotspots.reduce((s, h) => s + h.deploy_recommendation, 0)

  return (
    <div className="app-shell">
      <header className="topbar">
        <span className="topbar-logo">RideFlow AI</span>
        <AppNav />
      </header>

      <PageHeader
        icon={BarChart3}
        title="Admin Dashboard"
        subtitle="System-wide event monitor — every assignment, cancellation, completion, and surge in real time"
        accent="var(--yellow)"
        accentBg="var(--yellow-light)"
        infoDescription="See everything happening across the entire system in real time — ride assignments, arrivals, trip progress, completions, surge alerts, and driver pool changes. Metrics auto-refresh every 5 seconds; live events arrive instantly over WebSocket."
        infoTags={['All sessions', 'Auto-refreshes every 5 s', 'WebSocket stream']}
      />

      <div className="page-body">
        {/* ── Left Column ── */}
        <div className="left-col">

          <div className="card">
            <div className="card-header">
              <span className="card-title">Live Metrics</span>
              <div className="header-action-group">
                <button
                  className="btn btn-danger btn-sm"
                  onClick={handleClearData}
                  disabled={clearing}
                  title="Delete all drivers and rides from the database — use between demo sessions"
                  style={{ fontSize: 11, padding: '4px 10px' }}
                >
                  {clearing ? 'Clearing…' : 'Erase All Data'}
                </button>
                <button className="info-link-btn" onClick={() => setShowExplainModal(true)} title="Open admin guide">
                  <span className="info-link-icon">i</span>
                  Guide
                </button>
              </div>
            </div>
            <div className="card-body flex-col gap-10">
              {/* helper row: tap-to-inspect hint + refresh timestamp */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>Tap any card to inspect</span>
                <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'ui-monospace, monospace' }}>
                  updated {lastRefresh}
                </span>
              </div>
              <div className="metrics-grid">
                <MetricCard
                  value={rides.active} label="Active" sub="rides in progress"
                  color={rides.active > 0 ? 'var(--blue)' : undefined}
                  onClick={() => {
                    const items: MetricItem[] = rideActivity
                      .filter(r => ['searching', 'matched', 'in_progress'].includes(r.status))
                      .map(r => ({
                        id: r.rideId, label: short(r.rideId),
                        detail: r.driverName
                          ? `${r.driverName} · ${r.status === 'in_progress' ? 'on trip' : r.status === 'matched' ? 'matched' : 'searching'}`
                          : r.status,
                        color: r.status === 'in_progress' ? 'var(--green)' : r.status === 'matched' ? 'var(--blue)' : 'var(--yellow)',
                      }))
                    setDetailModal({ type: 'active_rides', count: rides.active, items: items.length > 0 ? items : undefined })
                  }}
                />
                <MetricCard
                  value={drivers.available} label="Drivers" sub="available now"
                  color={drivers.available > 0 ? 'var(--green)' : undefined}
                  onClick={() => setDetailModal({ type: 'available_drivers', count: drivers.available })}
                />
                <MetricCard
                  value={rides.completed} label="Completed" sub="trips finished"
                  color={rides.completed > 0 ? 'var(--green)' : undefined}
                  onClick={() => {
                    const items: MetricItem[] = rideActivity
                      .filter(r => r.status === 'completed')
                      .map(r => ({
                        id: r.rideId, label: short(r.rideId),
                        detail: r.driverName
                          ? `${r.driverName}${r.fare != null ? ` · ₹${r.fare.toFixed(0)}` : ''}`
                          : '—',
                        color: 'var(--green)',
                      }))
                    setDetailModal({ type: 'completed', count: rides.completed, items: items.length > 0 ? items : undefined })
                  }}
                />
                <MetricCard
                  value={rides.cancelled} label="Cancelled" sub="no driver found"
                  color={rides.cancelled > 0 ? 'var(--red)' : undefined}
                  onClick={() => {
                    const items: MetricItem[] = rideActivity
                      .filter(r => r.status === 'cancelled')
                      .map(r => ({
                        id: r.rideId, label: short(r.rideId),
                        detail: 'no driver found',
                        color: '#ef4444',
                      }))
                    setDetailModal({ type: 'cancelled', count: rides.cancelled, items: items.length > 0 ? items : undefined })
                  }}
                />
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <span className="card-title">Driver Pool</span>
              <span className="badge badge-gray" style={{ marginLeft: 'auto' }}>
                {drivers.total} total
              </span>
            </div>
            <div className="card-body flex-col gap-10">
              {drivers.total === 0 ? (
                <p className="text-muted">
                  No drivers registered yet. Seed some using the{' '}
                  <Link to="/playground" style={{ color: 'var(--blue)' }}>Playground</Link>.
                </p>
              ) : (
                <>
                  <DriverPoolBar available={drivers.available} busy={drivers.busy} offline={drivers.offline} />
                  {availableDrivers.length > 0 && (() => {
                    // Derive busy driver names from rideActivity
                    const busyNames = new Set(
                      rideActivity
                        .filter(r => r.status === 'matched' || r.status === 'in_progress')
                        .map(r => r.driverName)
                        .filter(Boolean)
                    )
                    const allDrivers = [
                      ...availableDrivers.map(d => ({ name: d.name, status: busyNames.has(d.name) ? 'busy' : 'available' as string })),
                      ...[...busyNames]
                        .filter(n => !availableDrivers.some(d => d.name === n))
                        .map(n => ({ name: n!, status: 'busy' })),
                    ].slice(0, 20)
                    const statusColor = (s: string) =>
                      s === 'available' ? '#16a34a' : s === 'busy' ? '#2563eb' : '#94a3b8'
                    const statusLabel = (s: string) =>
                      s === 'available' ? 'Idle' : s === 'busy' ? 'On Trip' : 'Offline'
                    return (
                      <div className="no-scrollbar" style={{ maxHeight: 160, overflowY: 'auto' }}>
                        {allDrivers.map((d, i) => (
                          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0', borderBottom: i < allDrivers.length - 1 ? '1px solid var(--border)' : 'none' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <span style={{ width: 7, height: 7, borderRadius: '50%', background: statusColor(d.status), display: 'inline-block', flexShrink: 0 }} />
                              <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text)' }}>{d.name}</span>
                            </div>
                            <span style={{ fontSize: 11, color: statusColor(d.status), fontWeight: 600 }}>{statusLabel(d.status)}</span>
                          </div>
                        ))}
                      </div>
                    )
                  })()}
                </>
              )}
            </div>
          </div>


        </div>

        {/* ── Center Column: Event Log ── */}
        <div className="center-col">
          <EventLog entries={logs} wsStatus={wsStatus} title="Live System Event Stream" />
        </div>

        {/* ── Right Column ── */}
        <div className="right-col">

          {/* AI Operations */}
          {aiHotspots.length > 0 && (
              <div className="card">
                <div className="card-header">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span className="card-title">AI Operations</span>
                    <div style={{ position: 'relative', display: 'inline-block' }}>
                      <button
                        style={{ width: 16, height: 16, borderRadius: '50%', border: '1px solid var(--text-muted)', background: 'transparent', color: 'var(--text-muted)', fontSize: 10, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}
                        onMouseEnter={e => { const t = e.currentTarget.nextElementSibling as HTMLElement; if (t) t.style.display = 'block' }}
                        onMouseLeave={e => { const t = e.currentTarget.nextElementSibling as HTMLElement; if (t) t.style.display = 'none' }}
                      >i</button>
                      <div style={{ display: 'none', position: 'absolute', top: '100%', left: 0, marginTop: 6, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '12px 14px', width: 260, fontSize: 10, color: 'var(--text)', lineHeight: 1.8, zIndex: 1000, boxShadow: '0 8px 24px rgba(0,0,0,0.2)' }}
                        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.display = 'none' }}>
                        <div style={{ fontWeight: 700, fontSize: 10, borderBottom: '1px solid var(--border)', paddingBottom: 7, marginBottom: 9 }}>About AI Operations</div>
                        <div style={{ marginBottom: 5, display: 'flex', gap: 6 }}>
                          <span style={{ fontWeight: 700, flexShrink: 0, minWidth: 80 }}>Hotspot</span>
                          <span style={{ color: 'var(--text-muted)' }}>A zone detected by DBSCAN where active ride requests form a dense cluster</span>
                        </div>
                        <div style={{ marginBottom: 5, display: 'flex', gap: 6 }}>
                          <span style={{ fontWeight: 700, flexShrink: 0, minWidth: 80 }}>Status</span>
                          <span style={{ color: 'var(--text-muted)' }}>Critical ≥60% unmatched · High ≥30% · Moderate ≥10%</span>
                        </div>
                        <div style={{ marginBottom: 5, display: 'flex', gap: 6 }}>
                          <span style={{ fontWeight: 700, flexShrink: 0, minWidth: 80 }}>Surge</span>
                          <span style={{ color: 'var(--text-muted)' }}>Recommended fare multiplier based on shortage ratio in that zone</span>
                        </div>
                        <div style={{ marginBottom: 5, display: 'flex', gap: 6 }}>
                          <span style={{ fontWeight: 700, flexShrink: 0, minWidth: 80 }}>Dispatch</span>
                          <span style={{ color: 'var(--text-muted)' }}>Number of idle drivers to redirect into the zone immediately</span>
                        </div>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <span style={{ fontWeight: 700, flexShrink: 0, minWidth: 80 }}>Candidates</span>
                          <span style={{ color: 'var(--text-muted)' }}>Nearest idle drivers by GPS — ranked by ST_Distance from hotspot center</span>
                        </div>
                      </div>
                    </div>
                  </div>
                  <span className="badge badge-red" style={{ marginLeft: 'auto', fontSize: 9, fontWeight: 700 }}>
                    {aiHotspots.length} HOTSPOT{aiHotspots.length !== 1 ? 'S' : ''}
                  </span>
                </div>
                <div className="card-body" style={{ padding: 0 }}>
                  {/* Fleet summary */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, padding: '10px 12px', borderBottom: '1px solid var(--border)' }}>
                    {[
                      { label: 'Unmatched Riders', value: String(adminTotalShortage), color: '#ef4444' },
                      { label: 'Drivers Needed', value: `+${adminTotalDeploy}`, color: '#16a34a' },
                    ].map(({ label, value, color }) => (
                      <div key={label} style={{ padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)' }}>
                        <div style={{ fontSize: 9, color: 'var(--text-muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.5px' }}>{label}</div>
                        <div style={{ fontSize: 18, fontWeight: 800, color, lineHeight: 1 }}>{value}</div>
                      </div>
                    ))}
                  </div>

                  {/* Zone navigator */}
                  {aiHotspots.length > 1 && (() => {
                    const si = Math.min(activeAdminHotspotIdx, aiHotspots.length - 1)
                    return (
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', borderBottom: '1px solid var(--border)', background: 'var(--surface)' }}>
                        <button onClick={() => setActiveAdminHotspotIdx(Math.max(0, si - 1))} disabled={si === 0}
                          style={{ width: 28, height: 28, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', cursor: si === 0 ? 'default' : 'pointer', fontSize: 16, fontWeight: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: si === 0 ? 0.3 : 0.9 }}>‹</button>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>Zone {si + 1} <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>of {aiHotspots.length}</span></span>
                          <span style={{ fontSize: 10, fontWeight: 700, color: '#fff', background: adminStatusColor(aiHotspots[si].zone_status), padding: '2px 8px', borderRadius: 4 }}>
                            {aiHotspots[si].zone_status.toUpperCase()}
                          </span>
                        </div>
                        <button onClick={() => setActiveAdminHotspotIdx(Math.min(aiHotspots.length - 1, si + 1))} disabled={si === aiHotspots.length - 1}
                          style={{ width: 28, height: 28, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', cursor: si === aiHotspots.length - 1 ? 'default' : 'pointer', fontSize: 16, fontWeight: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: si === aiHotspots.length - 1 ? 0.3 : 0.9 }}>›</button>
                      </div>
                    )
                  })()}

                  {(() => {
                    const safeIdx = Math.min(activeAdminHotspotIdx, aiHotspots.length - 1)
                    const h = aiHotspots[safeIdx]
                    const sc = adminStatusColor(h.zone_status)
                    return (
                      <div style={{ padding: '12px', display: 'flex', flexDirection: 'column', gap: 12 }}>
                        {/* Zone name + single-zone status */}
                        {aiHotspots.length === 1 && (
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>{h.zone_name}</span>
                            <span style={{ fontSize: 10, fontWeight: 700, color: '#fff', background: sc, padding: '2px 8px', borderRadius: 4 }}>{h.zone_status.toUpperCase()}</span>
                          </div>
                        )}
                        {aiHotspots.length > 1 && (
                          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{h.zone_name}</span>
                        )}

                        {/* Summary */}
                        <div style={{ fontSize: 11, color: 'var(--text)', lineHeight: 1.55, fontWeight: 500 }}>
                          {h.shortage > 0
                            ? `${h.unmatched_pct}% of riders unmatched — ${h.shortage} of ${h.demand} requests have no driver.`
                            : 'Supply meets demand in this zone. No action required.'}
                        </div>

                        {/* Metrics grid */}
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                          {[
                            { label: 'Riders waiting', value: String(h.demand), color: '#ef4444' },
                            { label: 'Idle drivers', value: String(h.drivers_nearby), color: '#16a34a' },
                            { label: 'Unmatched', value: `${h.unmatched_pct}%`, color: '#ea580c' },
                            { label: 'Confidence', value: `${(h.confidence * 100).toFixed(0)}%`, color: '#64748b' },
                          ].map(({ label, value, color }) => (
                            <div key={label} style={{ padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)' }}>
                              <div style={{ fontSize: 9, color: 'var(--text-muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.5px' }}>{label}</div>
                              <div style={{ fontSize: 16, fontWeight: 800, color, lineHeight: 1 }}>{value}</div>
                            </div>
                          ))}
                        </div>

                        {/* Fare impact */}
                        {h.fare_increase_pct > 0 && (
                          <div style={{ borderRadius: 6, border: '1px solid var(--border)', overflow: 'hidden' }}>
                            <div style={{ padding: '6px 10px', background: 'var(--surface)', borderBottom: '1px solid var(--border)', fontSize: 9, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Fare Impact</div>
                            <div style={{ padding: '8px 10px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <div>
                                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>~{h.fare_increase_pct}% above baseline</div>
                                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>{h.unmatched_pct}% demand-supply gap</div>
                              </div>
                              <div style={{ fontSize: 18, fontWeight: 800, color: '#ea580c' }}>{h.surge_multiplier}x</div>
                            </div>
                          </div>
                        )}

                        {/* Deploy / Surge / ETA */}
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
                          {[
                            { label: 'Deploy', value: `+${h.deploy_recommendation}`, color: '#16a34a' },
                            { label: 'Surge', value: `${h.surge_multiplier}x`, color: '#ea580c' },
                            { label: 'ETA', value: `${h.eta_minutes}m`, color: '#2563eb' },
                          ].map(({ label, value, color }) => (
                            <div key={label} style={{ padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', textAlign: 'center' }}>
                              <div style={{ fontSize: 9, color: 'var(--text-muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.5px' }}>{label}</div>
                              <div style={{ fontSize: 16, fontWeight: 800, color, lineHeight: 1 }}>{value}</div>
                            </div>
                          ))}
                        </div>

                        {/* Nearest drivers */}
                        {h.nearest_drivers.length > 0 && (
                          <div style={{ borderRadius: 6, border: '1px solid var(--border)', overflow: 'hidden' }}>
                            <div style={{ padding: '6px 10px', background: 'var(--surface)', borderBottom: '1px solid var(--border)', fontSize: 9, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                              {h.nearest_drivers.every(d => d.status === 'available') ? 'Nearest Idle Drivers' : 'Nearest Drivers (all busy)'}
                            </div>
                            {h.nearest_drivers.map((d, i) => {
                              const isAvailable = d.status === 'available'
                              return (
                                <div key={d.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 10px', borderBottom: i < h.nearest_drivers.length - 1 ? '1px solid var(--border)' : 'none' }}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: isAvailable ? '#f97316' : '#94a3b8', display: 'inline-block', flexShrink: 0 }} />
                                    <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text)' }}>{d.name}</span>
                                    {!isAvailable && <span style={{ fontSize: 9, color: 'var(--text-muted)', fontStyle: 'italic' }}>({d.status?.replace('_', ' ')})</span>}
                                  </div>
                                  <span style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 500 }}>{d.distance_km} km</span>
                                </div>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    )
                  })()}
                </div>
              </div>
          )}


          <div className="card">
            <div className="card-header">
              <span className="card-title">Ride Feed</span>
              <div style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
                {rideActivity.filter(r => r.status === 'searching').length > 0 && (
                  <span className="badge badge-yellow" style={{ fontSize: 10 }}>
                    {rideActivity.filter(r => r.status === 'searching').length} searching
                  </span>
                )}
                {rideActivity.filter(r => r.status === 'in_progress').length > 0 && (
                  <span className="badge badge-blue" style={{ fontSize: 10 }}>
                    {rideActivity.filter(r => r.status === 'in_progress').length} on trip
                  </span>
                )}
              </div>
            </div>
            <div className="card-body" style={{ maxHeight: 320, overflowY: 'auto', padding: '6px 12px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
              {rideActivity.length === 0 ? (
                <p className="text-muted" style={{ fontSize: 12, padding: '8px 0' }}>
                  No dispatches yet. Run the Playground or use the Rider tab to book a ride.
                </p>
              ) : rideActivity.map(r => {
                const isExpanded = expandedRides.has(r.rideId)
                const statusCfg = (
                  r.status === 'completed'   ? { cls: 'badge-green',  label: 'Completed',    accent: '#16a34a' } :
                  r.status === 'cancelled'   ? { cls: 'badge-red',    label: 'Cancelled',    accent: '#dc2626' } :
                  r.status === 'in_progress' ? { cls: 'badge-blue',   label: 'On Trip',      accent: '#2563eb' } :
                  r.status === 'matched'     ? { cls: 'badge-blue',   label: 'Driver Coming',accent: '#2563eb' } :
                                               { cls: 'badge-yellow', label: 'Searching',    accent: '#d97706' }
                )

                return (
                  <div key={r.rideId} style={{
                    borderRadius: 8,
                    border: '1px solid var(--border)',
                    background: 'var(--surface)',
                  }}>

                    {/* Collapsed header */}
                    <div
                      onClick={() => toggleExpanded(r.rideId)}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', cursor: 'pointer', userSelect: 'none' }}
                    >
                      {/* Status dot */}
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: statusCfg.accent, flexShrink: 0, marginTop: 1 }} />

                      {/* Driver name or fallback */}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {r.driverName ?? 'No driver yet'}
                        </div>
                        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 1 }}>
                          {statusCfg.label}
                          {r.fare != null && <span style={{ marginLeft: 6, color: 'var(--text)' }}>₹{r.fare.toFixed(0)}</span>}
                        </div>
                      </div>

                      {/* Time + chevron */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                          {r.timestamp ? formatRideTime(r.timestamp) : '—'}
                        </span>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                          strokeLinecap="round" strokeLinejoin="round"
                          style={{ color: 'var(--text-muted)', transition: 'transform 0.2s', transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)' }}>
                          <polyline points="6 9 12 15 18 9" />
                        </svg>
                      </div>
                    </div>

                    {/* Expanded detail panel */}
                    {isExpanded && (
                      <div style={{ borderTop: `2px solid ${statusCfg.accent}`, background: 'var(--bg)', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <DetailRow label="Driver"       value={r.driverName} />
                        <DetailRow label="Pickup"       value={r.pickupLat != null ? `${r.pickupLat.toFixed(4)}°N, ${r.pickupLng!.toFixed(4)}°E` : undefined} />
                        <DetailRow label="Destination"  value={r.destLat   != null ? `${r.destLat.toFixed(4)}°N, ${r.destLng!.toFixed(4)}°E`    : undefined} />
                        <DetailRow label="Distance"     value={r.distanceKm  != null ? `${r.distanceKm} km`         : undefined} />
                        <DetailRow label="Duration"     value={r.durationMin != null ? `${r.durationMin} min`        : undefined} />
                        <DetailRow label="Fare"         value={r.fare        != null ? `₹${r.fare.toFixed(2)}`       : undefined} />
                        {r.surgeMultiplier != null && r.surgeMultiplier > 1.0 && (
                          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11 }}>
                            <span style={{ color: 'var(--text-muted)' }}>Surge</span>
                            <span className="badge badge-yellow" style={{ fontSize: 9 }}>{r.surgeMultiplier}× surge</span>
                          </div>
                        )}
                        {(r.status === 'matched' || r.status === 'in_progress') && r.etaSeconds != null && (
                          <DetailRow label="ETA" value={formatEta(getRemaining(r))} />
                        )}
                        {r.radiusKm != null && (
                          <DetailRow label="Match radius" value={`${r.radiusKm} km${r.attemptNo != null && r.attemptNo > 1 ? ` · attempt ${r.attemptNo}` : ''}`} />
                        )}
                      </div>
                    )}

                  </div>
                )
              })}
            </div>
          </div>

        </div>
      </div>

      {detailModal && (
        <MetricsDetailModal
          type={detailModal.type}
          count={detailModal.count}
          items={detailModal.items}
          onClose={() => setDetailModal(null)}
        />
      )}

      {globalLimitReached && (
        <UsageLimitModal
          page="Admin Dashboard"
          runsUsed={0}
          limit={3}
          isGlobal
        />
      )}

      <InfoModal open={showExplainModal} title="Admin Guide: How To Read This Dashboard" onClose={() => setShowExplainModal(false)}>
        <div className="info-modal-block">
          <div className="info-modal-block-title">What this page is for</div>
          <p className="info-modal-block-text">System-wide operations view: driver supply, ride flow, dispatch outcomes, and all real-time event activity.</p>
        </div>
        <div className="info-modal-block">
          <div className="info-modal-block-title">Where the data comes from</div>
          <p className="info-modal-block-text">Live events stream from /ws/admin over WebSocket. Snapshot counts come from the metrics API every 5 seconds.</p>
        </div>
        <div className="info-modal-block">
          <div className="info-modal-block-title">Full lifecycle in demo mode</div>
          <p className="info-modal-block-text">After dispatch (driver assigned), rides auto-progress: driver_arriving in ~6s, on_trip in ~16s, completed in ~28s. Each completion shows fare, distance, and duration in the log.</p>
        </div>
        <div className="info-modal-block">
          <div className="info-modal-block-title">Active Dispatches panel</div>
          <p className="info-modal-block-text">Shows per-ride status: Searching → matched driver → On Trip → Done (with fare). ETA counts down for in-progress stages.</p>
        </div>
      </InfoModal>
    </div>
  )
}
