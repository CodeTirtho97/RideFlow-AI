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
import type { MetricType, MetricItem } from '../components/MetricsDetailModal'
import { getMetrics, demoReset } from '../api/client'
import type { SystemMetrics } from '../api/client'

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

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

function formatRideDate(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getDate()).padStart(2,'0')}-${MONTHS[d.getMonth()]}-${String(d.getFullYear()).slice(2)}`
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
  const prevWsStatusRef = useRef<string>('disconnected')
  const [detailModal, setDetailModal] = useState<{ type: MetricType; count: number; items?: MetricItem[] } | null>(null)

  const [metrics, setMetrics] = useState<SystemMetrics>(EMPTY_METRICS)
  const [lastRefresh, setLastRefresh] = useState<string>('—')
  const [rideActivity, setRideActivity] = useState<RideActivity[]>([])
  const [clearing, setClearing] = useState(false)
  const [logs, setLogs] = useState<LogEntry[]>([
    logEntry('system', 'Welcome to the Admin Dashboard. Connecting to the live metrics stream...'),
  ])
  const [showExplainModal, setShowExplainModal] = useState(false)
  const [aiHotspots, setAiHotspots] = useState<import('../api/client').AiHotspot[]>([])
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
      const res = await getMetrics()
      setMetrics(res.data)
      setLastRefresh(new Date().toTimeString().slice(0, 8))
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
            <div className="card-body">
              {drivers.total === 0 ? (
                <p className="text-muted">
                  No drivers registered yet. Seed some using the{' '}
                  <Link to="/playground" style={{ color: 'var(--blue)' }}>Playground</Link>.
                </p>
              ) : (
                <DriverPoolBar available={drivers.available} busy={drivers.busy} offline={drivers.offline} />
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
                <div className="card-body flex-col gap-12">
                  {/* Fleet-level summary */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    <div style={{ background: 'rgba(220,38,38,0.06)', padding: '8px', borderRadius: 4, borderLeft: '3px solid var(--red)' }}>
                      <div style={{ fontSize: 8, color: 'var(--text-muted)', marginBottom: 3, textTransform: 'uppercase', letterSpacing: '0.4px' }}>Unmatched Riders</div>
                      <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--red)', lineHeight: 1 }}>{adminTotalShortage}</div>
                    </div>
                    <div style={{ background: 'rgba(34,197,94,0.06)', padding: '8px', borderRadius: 4, borderLeft: '3px solid var(--green)' }}>
                      <div style={{ fontSize: 8, color: 'var(--text-muted)', marginBottom: 3, textTransform: 'uppercase', letterSpacing: '0.4px' }}>Drivers Needed</div>
                      <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--green)', lineHeight: 1 }}>+{adminTotalDeploy}</div>
                    </div>
                  </div>

                  {aiHotspots.map((h, idx) => (
                    <div key={idx} style={{ padding: '10px', borderRadius: 6, background: 'rgba(0,0,0,0.02)', border: '1px solid rgba(0,0,0,0.08)' }}>
                      {/* Zone + status */}
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
                        <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text)' }}>{h.zone_name}</span>
                        <span style={{ fontSize: 9, fontWeight: 700, color: adminStatusColor(h.zone_status), background: `${adminStatusColor(h.zone_status)}18`, padding: '2px 6px', borderRadius: 4 }}>
                          {h.zone_status.toUpperCase()}
                        </span>
                      </div>

                      {/* Summary sentence */}
                      <div style={{ fontSize: 9, color: 'var(--text-muted)', lineHeight: 1.5, marginBottom: 9 }}>
                        {h.shortage > 0
                          ? `${h.unmatched_pct}% of requests unmatched. Fares est. +${h.fare_increase_pct}% above baseline.`
                          : 'Supply meets demand in this zone.'}
                      </div>

                      {/* Compact metrics */}
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, marginBottom: 9, fontSize: 9 }}>
                        {[
                          { l: 'Demand', v: String(h.demand), c: 'var(--red)' },
                          { l: 'Supply', v: String(h.drivers_nearby), c: 'var(--green)' },
                          { l: 'Confidence', v: `${(h.confidence * 100).toFixed(0)}%`, c: 'var(--yellow)' },
                        ].map(({ l, v, c }) => (
                          <div key={l} style={{ textAlign: 'center', background: 'rgba(0,0,0,0.03)', padding: '5px', borderRadius: 4 }}>
                            <div style={{ fontSize: 7, color: 'var(--text-muted)', marginBottom: 2, textTransform: 'uppercase' }}>{l}</div>
                            <div style={{ fontWeight: 700, color: c }}>{v}</div>
                          </div>
                        ))}
                      </div>

                      {/* Operational actions */}
                      <div style={{ borderTop: '1px solid rgba(0,0,0,0.07)', paddingTop: 8, marginBottom: h.nearest_drivers.length > 0 ? 8 : 0 }}>
                        <div style={{ fontSize: 7, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', marginBottom: 6 }}>Recommended Actions</div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, fontSize: 9 }}>
                          <div style={{ background: 'rgba(34,197,94,0.08)', padding: '6px', borderRadius: 4, textAlign: 'center' }}>
                            <div style={{ fontSize: 7, color: 'var(--text-muted)', marginBottom: 2 }}>DISPATCH</div>
                            <div style={{ fontWeight: 800, color: 'var(--green)', fontSize: 12 }}>+{h.deploy_recommendation}</div>
                          </div>
                          <div style={{ background: 'rgba(249,115,22,0.08)', padding: '6px', borderRadius: 4, textAlign: 'center' }}>
                            <div style={{ fontSize: 7, color: 'var(--text-muted)', marginBottom: 2 }}>SURGE</div>
                            <div style={{ fontWeight: 800, color: 'var(--orange)', fontSize: 12 }}>{h.surge_multiplier}x</div>
                          </div>
                          <div style={{ background: 'rgba(59,130,246,0.08)', padding: '6px', borderRadius: 4, textAlign: 'center' }}>
                            <div style={{ fontSize: 7, color: 'var(--text-muted)', marginBottom: 2 }}>ETA</div>
                            <div style={{ fontWeight: 800, color: 'var(--blue)', fontSize: 12 }}>{h.eta_minutes}m</div>
                          </div>
                        </div>
                      </div>

                      {/* Reposition candidates */}
                      {h.nearest_drivers.length > 0 && (
                        <div style={{ borderTop: '1px solid rgba(0,0,0,0.07)', paddingTop: 8 }}>
                          <div style={{ fontSize: 7, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', marginBottom: 6 }}>
                            {h.nearest_drivers.every(d => d.status === 'available') ? 'Reposition Candidates' : 'Nearest Drivers (all busy)'}
                          </div>
                          {h.nearest_drivers.map((d, i) => {
                            const isAvailable = d.status === 'available'
                            return (
                              <div key={d.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '3px 0', borderBottom: i < h.nearest_drivers.length - 1 ? '1px solid var(--border)' : 'none' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: isAvailable ? '#f97316' : '#64748b', display: 'inline-block' }} />
                                  <span style={{ fontSize: 10, fontWeight: 600, color: isAvailable ? 'var(--text)' : 'var(--text-muted)' }}>{d.name}</span>
                                  {!isAvailable && <span style={{ fontSize: 8, color: 'var(--text-muted)', fontStyle: 'italic' }}>({d.status?.replace('_', ' ')})</span>}
                                </div>
                                <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>{d.distance_km} km</span>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
          )}

          {Object.keys(metrics.by_status).length > 0 && (
            <div className="card">
              <div className="card-header">
                <span className="card-title">Rides by Status</span>
              </div>
              <div className="card-body">
                {[
                  'requested', 'searching_driver', 'driver_assigned',
                  'driver_arriving', 'on_trip', 'completed', 'cancelled',
                ].map(s => {
                  const count = metrics.by_status[s] ?? 0
                  if (count === 0) return null
                  const colors: Record<string, string> = {
                    requested: 'badge-gray', searching_driver: 'badge-yellow',
                    driver_assigned: 'badge-blue', driver_arriving: 'badge-blue',
                    on_trip: 'badge-green', completed: 'badge-green', cancelled: 'badge-red',
                  }
                  return (
                    <div key={s} className="info-row">
                      <span className="info-label">
                        <span className={`badge ${colors[s] ?? 'badge-gray'}`} style={{ fontSize: 10 }}>
                          {s.replace(/_/g, ' ')}
                        </span>
                      </span>
                      <span className="info-value">{count}</span>
                    </div>
                  )
                })}
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
            <div className="card-body" style={{ maxHeight: 480, overflowY: 'auto', padding: '6px 12px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
              {rideActivity.length === 0 ? (
                <p className="text-muted" style={{ fontSize: 12, padding: '8px 0' }}>
                  No dispatches yet. Run the Playground or use the Rider tab to book a ride.
                </p>
              ) : rideActivity.map(r => {
                const isExpanded = expandedRides.has(r.rideId)
                const statusCfg = (
                  r.status === 'completed'   ? { cls: 'badge-green',  label: 'Completed'     } :
                  r.status === 'cancelled'   ? { cls: 'badge-red',    label: 'Cancelled'     } :
                  r.status === 'in_progress' ? { cls: 'badge-blue',   label: 'On Trip'       } :
                  r.status === 'matched'     ? { cls: 'badge-blue',   label: 'Driver Coming' } :
                                               { cls: 'badge-yellow', label: 'Searching'     }
                )
                const cardBg =
                  r.status === 'completed'   ? 'var(--green-light)'            :
                  r.status === 'cancelled'   ? 'rgba(239,68,68,0.05)'          :
                  r.status === 'in_progress' ? 'rgba(59,130,246,0.06)'         :
                  'var(--gray-light)'
                const cardBorder =
                  r.status === 'completed'   ? 'var(--border-success)'         :
                  r.status === 'cancelled'   ? 'rgba(239,68,68,0.25)'          :
                  r.status === 'in_progress' ? 'rgba(59,130,246,0.22)'         :
                  'var(--border)'

                return (
                  <div key={r.rideId} style={{
                    borderRadius: 8,
                    border: `1px solid ${cardBorder}`,
                    background: cardBg,
                    padding: '8px 12px',
                  }}>

                    {/* Collapsed header — click to expand */}
                    <div
                      onClick={() => toggleExpanded(r.rideId)}
                      style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', userSelect: 'none' }}
                    >
                      <span className={`badge ${statusCfg.cls}`} style={{ fontSize: 10, flexShrink: 0 }}>
                        {statusCfg.label}
                      </span>
                      <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, color: 'var(--text)' }}>
                        {r.rideId.slice(0, 8)}
                      </span>
                      <span style={{ flex: 1 }} />
                      <div style={{ textAlign: 'right', lineHeight: 1.5 }}>
                        <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                          {r.timestamp ? formatRideDate(r.timestamp) : '—'}
                        </div>
                        <div style={{ fontSize: 10, fontFamily: 'ui-monospace, monospace', color: 'var(--text-muted)' }}>
                          {r.timestamp ? formatRideTime(r.timestamp) : '—'}
                        </div>
                      </div>
                      <svg
                        width="14" height="14" viewBox="0 0 24 24"
                        fill="none" stroke="currentColor" strokeWidth="2.2"
                        strokeLinecap="round" strokeLinejoin="round"
                        style={{
                          color: 'var(--text-muted)', marginLeft: 4, flexShrink: 0,
                          transition: 'transform 0.2s ease',
                          transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                        }}
                      >
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </div>

                    {/* Expanded detail panel */}
                    {isExpanded && (
                      <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 5 }}>
                        <DetailRow label="Driver" value={r.driverName} />
                        <DetailRow label="Source" value={r.pickupLat != null && r.pickupLng != null ? `${r.pickupLat.toFixed(4)}°N, ${r.pickupLng.toFixed(4)}°E` : undefined} />
                        <DetailRow label="Destination" value={r.destLat != null && r.destLng != null ? `${r.destLat.toFixed(4)}°N, ${r.destLng.toFixed(4)}°E` : undefined} />
                        <DetailRow label="Distance" value={r.distanceKm != null ? `${r.distanceKm} km` : undefined} />
                        <DetailRow label="Duration" value={r.durationMin != null ? `${r.durationMin} min` : undefined} />
                        <DetailRow label="Fare" value={r.fare != null ? `₹${r.fare.toFixed(2)}` : undefined} />
                        {r.surgeMultiplier != null && r.surgeMultiplier > 1.0 && (
                          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11 }}>
                            <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>Surge</span>
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
