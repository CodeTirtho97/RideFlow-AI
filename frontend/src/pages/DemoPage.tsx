import { useState, useCallback, useEffect, useRef } from 'react'
import { AppNav } from '../components/AppNav'
import { PageHeader } from '../components/PageHeader'
import { FlaskConical } from 'lucide-react'
import { EventLog, logEntry } from '../components/EventLog'
import type { LogEntry } from '../components/EventLog'
import { useWebSocket } from '../hooks/useWebSocket'
import type { WsStatus } from '../hooks/useWebSocket'
import { InfoModal } from '../components/InfoModal'
import { demoSeed, demoMove, demoRequests, demoAiRun, demoReset, getMetrics } from '../api/client'
import { useTheme } from '../hooks/useTheme'
import type { SystemMetrics, AiHotspot } from '../api/client'
import { DispatchMap, fetchRoute } from '../components/DispatchMap'
import type { MapDriver, MapTrip, MapAnimEvent, LegendItem } from '../components/DispatchMap'

const PLAYGROUND_LEGEND: LegendItem[] = [
  { label: 'Available',        color: '#16a34a', shape: 'dot'  },
  { label: 'Assigned',         color: '#d97706', shape: 'dot'  },
  { label: 'En Route',         color: '#ea580c', shape: 'dot'  },
  { label: 'On Trip',          color: '#2563eb', shape: 'dot'  },
  { label: 'Reposition — AI',  color: '#f97316', shape: 'ring' },
  { label: 'Pickup',           color: '#16a34a', shape: 'pin'  },
  { label: 'Drop-off',         color: '#dc2626', shape: 'pin'  },
]
import { useToast } from '../components/Toast'
import { MetricsDetailModal } from '../components/MetricsDetailModal'
import type { MetricType, MetricItem } from '../components/MetricsDetailModal'

interface RecentMatch {
  rideId: string
  driverName: string
  radiusKm: number
  attempt?: number
  at: string
}

type Preset = 'light' | 'moderate' | 'dense'
type StepState = 'idle' | 'running' | 'done' | 'error'

const PRESET_MAP: Record<string, { center: [number, number]; zoom: number }> = {
  light:    { center: [12.9758, 77.5956], zoom: 12 },
  moderate: { center: [12.9758, 77.5956], zoom: 12 },
  dense:    { center: [12.9698, 77.7499], zoom: 13 },
}

const PRESET_META = {
  light: {
    label: 'Light Traffic',
    drivers: 10,
    requests: 8,
    radius: '10 km',
    zone: 'MG Road, Bengaluru',
    supplyLabel: 'Plenty of drivers',
    supplyClass: 'badge-green',
    supplySymbol: '>',
    supplyColor: '#16a34a',
    shows: 'Everyone gets a driver quickly. Best for watching the full ride lifecycle from start to finish.',
  },
  moderate: {
    label: 'Moderate Traffic',
    drivers: 35,
    requests: 35,
    radius: '7 km',
    zone: 'MG Road, Bengaluru',
    supplyLabel: 'Balanced supply',
    supplyClass: 'badge-yellow',
    supplySymbol: '≈',
    supplyColor: '#d97706',
    shows: 'Supply equals demand on paper — but parallel requests and geography still force retries and radius expansion from 3 km to 5 km.',
  },
  dense: {
    label: 'Dense — Peak Hour',
    drivers: 70,
    requests: 100,
    radius: '5 km',
    zone: 'Whitefield, Bengaluru',
    supplyLabel: 'More riders than drivers',
    supplyClass: 'badge-red',
    supplySymbol: '<',
    supplyColor: '#dc2626',
    shows: 'Demand is 43% above supply — expect cancellations, heavy lock contention, surge pricing, and multiple AI hotspot clusters.',
  },
} as const

const STEPS = [
  {
    key: 'seed' as const,
    label: 'Step 1: Place Drivers',
    plain: 'Creates a set of drivers and places them at real GPS coordinates around Bengaluru. All drivers start as available and ready to receive rides.',
    techNote: 'Writes each driver to PostgreSQL + Redis HASH (location cache, 30s TTL) + PostGIS (for ST_DWithin dispatch queries). Sets status = available.',
    buttonLabel: 'Seed Drivers',
    requires: null,
  },
  {
    key: 'move' as const,
    label: 'Step 2: Simulate Movement',
    plain: 'Starts a background loop that nudges each driver\'s GPS position every 4 seconds — simulating real drivers moving around the city.',
    techNote: 'asyncio background task · ±0.0008° random walk every 2s (~88m/update) · Redis HASH updated with TTL refresh · shows location staleness detection',
    buttonLabel: 'Start Movement',
    requires: 'seed' as const,
  },
  {
    key: 'requests' as const,
    label: 'Step 3: Fire Ride Requests',
    plain: 'Sends all ride requests at once — like a real demand surge. Watch the system assign each request to the nearest available driver in parallel.',
    techNote: 'Creates N Ride rows → queues N Celery tasks in parallel · each worker runs PostGIS ST_DWithin(3km) · SELECT FOR UPDATE SKIP LOCKED prevents double-assignment',
    buttonLabel: 'Create Requests',
    requires: 'seed' as const,
  },
  {
    key: 'ai' as const,
    label: 'Step 4: Run AI Prediction',
    plain: 'Starts a live DBSCAN loop that detects demand hotspots every 8 seconds — updating in real time as dispatch resolves rides and drivers change state.',
    techNote: 'DBSCAN clustering re-runs every 8s · Redis Pub/Sub pushes updates to WebSocket · confidence from cluster tightness · nearest drivers via ST_Distance',
    buttonLabel: 'Start AI Loop',
    requires: 'requests' as const,
  },
]

const EMPTY_METRICS: SystemMetrics = {
  drivers: { available: 0, busy: 0, offline: 0, total: 0 },
  rides: { active: 0, completed: 0, cancelled: 0, total: 0 },
  by_status: {},
}

function plain(data: Record<string, unknown>, fallback: string) {
  const msg = data.message_plain
  return typeof msg === 'string' && msg.trim().length > 0 ? msg : fallback
}

function tech(data: Record<string, unknown>, fallback: string) {
  const msg = data.message_tech
  return typeof msg === 'string' && msg.trim().length > 0 ? msg : fallback
}

export default function DemoPage() {
  useEffect(() => { document.title = 'Playground | RideFlow AI' }, [])
  const { toast } = useToast()
  const { theme } = useTheme()

  const [preset, setPreset] = useState<Preset>('light')
  const [steps, setSteps] = useState<Record<string, StepState>>({
    seed: 'idle', move: 'idle', requests: 'idle', ai: 'idle',
  })
  const [logs, setLogs] = useState<LogEntry[]>([
    logEntry('system', 'Welcome to the RideFlow AI Demo. Run the simulation steps to test live dispatch behavior.'),
    logEntry('info', 'Pick a traffic level, then run each simulation step in order. Nothing starts automatically.'),
  ])
  const [showExplainModal, setShowExplainModal] = useState(false)
  const [metrics, setMetrics] = useState<SystemMetrics>(EMPTY_METRICS)
  const [metricsFreshAt, setMetricsFreshAt] = useState('—')
  const [recentMatches, setRecentMatches] = useState<RecentMatch[]>([])
  const [cancelledRideLog, setCancelledRideLog] = useState<{ rideId: string; at: string }[]>([])
  const [detailModal, setDetailModal] = useState<{ type: MetricType; count: number; items?: MetricItem[] } | null>(null)
  const [aiHotspots, setAiHotspots] = useState<AiHotspot[]>([])


  // ── Map state ──────────────────────────────────────────────────────────
  // Refs let the WS callback read current values without stale closure issues
  const mapDriversRef = useRef<Record<string, MapDriver>>({})
  const mapTripsRef   = useRef<Record<string, MapTrip>>({})
  const [mapDrivers, _setMapDrivers] = useState<Record<string, MapDriver>>({})
  const [mapTrips,   _setMapTrips]   = useState<Record<string, MapTrip>>({})
  const [mapAnimEvents, setMapAnimEvents] = useState<MapAnimEvent[]>([])
  const [mapFocusTrigger, setMapFocusTrigger] = useState(0)

  // Wrappers keep ref in sync so WS callback always reads fresh data
  const setMapDrivers = useCallback(
    (fn: (p: Record<string, MapDriver>) => Record<string, MapDriver>) => {
      _setMapDrivers(p => { const n = fn(p); mapDriversRef.current = n; return n })
    }, [])

  const setMapTrips = useCallback(
    (fn: (p: Record<string, MapTrip>) => Record<string, MapTrip>) => {
      _setMapTrips(p => { const n = fn(p); mapTripsRef.current = n; return n })
    }, [])

  const addLog = useCallback((entry: LogEntry) => {
    setLogs(prev => [...prev, entry])
  }, [])

  const refreshMetrics = useCallback(async () => {
    try {
      const res = await getMetrics()
      setMetrics(res.data)
      setMetricsFreshAt(new Date().toTimeString().slice(0, 8))
    } catch {
      // keep last known snapshot; event log will still update from WS
    }
  }, [])

  useEffect(() => {
    refreshMetrics()
    const id = setInterval(refreshMetrics, 5_000)
    return () => clearInterval(id)
  }, [refreshMetrics])

  // Admin WS — connect once seed is done so it's ready before Step 3 fires
  const handleAdminMessage = useCallback((data: Record<string, unknown>) => {
    const event = data.event as string
    const rideId = data.ride_id as string | undefined
    const rideShort = rideId ? rideId.slice(0, 8) + '…' : '?'

    if (event === 'ride_searching') {
      addLog(logEntry(
        'info',
        plain(data, `Ride ${rideShort} queued for dispatch.`),
        tech(data, 'status=searching_driver · asyncio.create_task(_dispatch)'),
      ))
    } else if (event === 'dispatch_started') {
      addLog(logEntry('info',
        plain(data, 'Dispatch started. Looking for nearby available drivers.'),
        tech(data, `pickup: ${data.pickup_lat}°N, ${data.pickup_lng}°E · ST_DWithin search starting`),
      ))
    } else if (event === 'dispatch_searching') {
      addLog(logEntry('info',
        plain(data, `Searching ${data.radius_km} km radius — ${data.candidates_found} driver candidate(s) found.`),
        tech(data, `ST_DWithin(pickup, driver_location, ${data.radius_km}km) · ordered by ST_Distance · GiST index`),
      ))
    } else if (event === 'driver_skipped') {
      addLog(logEntry(
        'info',
        plain(data, 'Nearest candidate is already taken. Trying next driver.'),
        tech(data, `attempt=${data.attempt ?? '?'} · SELECT FOR UPDATE SKIP LOCKED`),
      ))
    } else if (event === 'dispatch_complete') {
      const driverName = (data.driver_name as string) || 'Driver'
      const driverId = data.driver_id as string | undefined
      addLog(logEntry('event',
        plain(data, `Matched! ${driverName} → Ride ${rideShort}`),
        tech(data, `attempt ${data.attempt} · ${data.radius_km} km radius · lock in ${data.latency_ms}ms`),
      ))
      setRecentMatches(prev => {
        const next: RecentMatch = {
          rideId: rideId ?? '',
          driverName,
          radiusKm: (data.radius_km as number) ?? 0,
          attempt: data.attempt as number | undefined,
          at: new Date().toTimeString().slice(0, 8),
        }
        const withoutCurrent = prev.filter(m => m.rideId !== next.rideId)
        return [next, ...withoutCurrent].slice(0, 10)
      })
      if (driverId && rideId) {
        setMapDrivers(prev => {
          const d = prev[driverId]; if (!d) return prev
          return { ...prev, [driverId]: { ...d, status: 'assigned' } }
        })
        setMapTrips(prev => {
          const t = prev[rideId]; if (!t) return prev
          return { ...prev, [rideId]: { ...t, driverId, status: 'assigned' } }
        })
      }
      refreshMetrics()

    } else if (event === 'status_update') {
      const s = data.status as string
      const driverName = (data.driver_name as string) || 'Driver'
      const driverId = data.driver_id as string | undefined
      if (s === 'driver_arriving') {
        addLog(logEntry('info',
          plain(data, `${driverName} is on the way to pickup.`),
          tech(data, `ride: ${rideShort} · state=driver_arriving · ETA ~2 min (scaled)`),
        ))
        if (driverId && rideId) {
          const driver = mapDriversRef.current[driverId]
          const trip   = mapTripsRef.current[rideId]
          setMapDrivers(prev => {
            const d = prev[driverId]; if (!d) return prev
            return { ...prev, [driverId]: { ...d, status: 'arriving' } }
          })
          setMapTrips(prev => {
            const t = prev[rideId]; if (!t) return prev
            return { ...prev, [rideId]: { ...t, driverId, status: 'arriving' } }
          })
          if (driver && trip) {
            // Fetch road route first so the driver follows actual streets
            const fromLat = driver.lat, fromLng = driver.lng
            const toLat = trip.pickupLat, toLng = trip.pickupLng
            const animKey = `${rideId}-arr`
            fetchRoute(fromLat, fromLng, toLat, toLng).then(path => {
              setMapAnimEvents(prev => [
                ...prev.filter(e => e.key !== animKey),
                { key: animKey, rideId, phase: 'arriving', driverId, fromLat, fromLng, toLat, toLng, durationMs: 12_000, path },
              ])
            })
          }
        }
      } else if (s === 'on_trip') {
        addLog(logEntry('info',
          plain(data, `${driverName} picked up rider. Trip in progress.`),
          tech(data, `ride: ${rideShort} · state=on_trip · fare meter running · scale 1s=1min`),
        ))
        if (driverId && rideId) {
          const trip = mapTripsRef.current[rideId]
          setMapDrivers(prev => {
            const d = prev[driverId]; if (!d) return prev
            return { ...prev, [driverId]: { ...d, status: 'on_trip' } }
          })
          setMapTrips(prev => {
            const t = prev[rideId]; if (!t) return prev
            return { ...prev, [rideId]: { ...t, status: 'on_trip' } }
          })
          if (trip) {
            const fromLat = trip.pickupLat, fromLng = trip.pickupLng
            const toLat = trip.destLat, toLng = trip.destLng
            const animKey = `${rideId}-trip`
            fetchRoute(fromLat, fromLng, toLat, toLng).then(path => {
              setMapAnimEvents(prev => [
                ...prev.filter(e => e.key !== animKey),
                { key: animKey, rideId, phase: 'on_trip', driverId, fromLat, fromLng, toLat, toLng, durationMs: 16_000, path },
              ])
            })
          }
        }
      } else if (s === 'completed') {
        addLog(logEntry('event',
          plain(data, `Trip completed — ride ${rideShort}`),
          tech(data, `ride: ${rideShort} · state=completed`),
        ))
        refreshMetrics()
      }

    } else if (event === 'ride_completed') {
      const driverName = (data.driver_name as string) || 'Driver'
      const driverId = data.driver_id as string | undefined
      const fare = data.fare as number | undefined
      const distKm = data.distance_km as number | undefined
      const durMin = data.duration_display_min as number | undefined
      addLog(logEntry('event',
        plain(data, `Trip complete! ${driverName} · ₹${fare?.toFixed(2) ?? '?'} · ${distKm ?? '?'} km · ${durMin ?? '?'} min`),
        tech(data, `ride: ${rideShort} · fare=₹${fare?.toFixed(2)} · dist=${distKm}km · dur=${durMin}min · driver reset=available`),
      ))
      if (rideId && fare != null) {
        setRecentMatches(prev =>
          prev.map(m => m.rideId === rideId ? { ...m, at: `✓ ₹${fare.toFixed(0)}` } : m)
        )
      }
      if (driverId) {
        setMapDrivers(prev => {
          const d = prev[driverId]; if (!d) return prev
          return { ...prev, [driverId]: { ...d, status: 'available' } }
        })
      }
      if (rideId) {
        setMapTrips(prev => { const n = { ...prev }; delete n[rideId]; return n })
      }
      refreshMetrics()

    } else if (event === 'dispatch_failed') {
      addLog(logEntry('error',
        plain(data, `No driver found — Ride ${rideShort} cancelled.`),
        tech(data, `Searched 3 km → 5 km · all candidates exhausted · ride.status → cancelled`),
      ))
      if (rideId) {
        setCancelledRideLog(prev =>
          [{ rideId, at: new Date().toTimeString().slice(0, 8) }, ...prev].slice(0, 20)
        )
      }
      refreshMetrics()
    } else if (event === 'driver_location') {
      // Movement loop heartbeat — update driver position on the map
      const driverId = data.driver_id as string | undefined
      const lat      = data.lat as number | undefined
      const lng      = data.lng as number | undefined
      if (driverId && lat != null && lng != null) {
        setMapDrivers(prev => {
          const d = prev[driverId]
          if (!d) return prev
          return { ...prev, [driverId]: { ...d, lat, lng } }
        })
      }
    } else if (event === 'ai_cycle_update') {
      const incoming = (data.hotspots as AiHotspot[]) || []
      if (incoming.length > 0) {
        addLog(logEntry('event',
          `AI update: ${incoming.length} hotspot(s) detected`,
          incoming.map(h => `${h.zone_name} — shortage: ${h.shortage}, unmatched: ${h.unmatched_pct}%`).join(' | '),
        ))
      }
      // Replace entire hotspot array — no accumulation
      setAiHotspots(incoming)
      // Reset all reposition flags then mark new candidates
      const allRepoIds = new Set(incoming.flatMap(h => h.nearest_drivers.map(d => d.id)))
      setMapDrivers(prev => {
        const next = { ...prev }
        Object.keys(next).forEach(id => {
          next[id] = { ...next[id], reposition: allRepoIds.has(id) }
        })
        return next
      })
    }
  }, [addLog, refreshMetrics, setMapDrivers, setMapTrips, setMapAnimEvents, setCancelledRideLog])

  const adminWsStatus: WsStatus = useWebSocket(
    steps.seed !== 'idle' ? '/ws/admin' : '',
    {
      enabled: steps.seed !== 'idle',
      onOpen: () => addLog(logEntry('ws', 'Connected to live event stream — dispatch results will appear here.', '/ws/admin · admin:metrics channel')),
      onMessage: handleAdminMessage,
    },
  )

  // Show a warning toast when WS drops after having been connected
  const prevWsStatusRef = useRef<string>('disconnected')
  useEffect(() => {
    if (prevWsStatusRef.current === 'connected' && adminWsStatus === 'disconnected') {
      toast({
        type: 'warning',
        title: 'Live Stream Disconnected',
        message: 'Real-time dispatch events have paused. Reconnecting automatically…',
        steps: [
          'Verify the backend is still running on port 8000',
          'Events will resume once the connection is restored',
        ],
      })
    }
    prevWsStatusRef.current = adminWsStatus
  }, [adminWsStatus, toast])

  const setStep = (key: string, state: StepState) =>
    setSteps(prev => ({ ...prev, [key]: state }))

  const apiError = (err: unknown): string =>
    (err as { response?: { data?: { detail?: string; error?: string } } })
      ?.response?.data?.detail ??
    (err as { response?: { data?: { error?: string } } })
      ?.response?.data?.error ??
    'Request failed — is the backend running?'

  // ── Step handlers ─────────────────────────────────────────────────────

  const handleSeed = async () => {
    setStep('seed', 'running')
    const meta = PRESET_META[preset]
    addLog(logEntry('info', `Placing ${meta.drivers} drivers within ${meta.radius} radius in ${meta.zone}...`, `POST /api/demo/seed · preset: ${preset}`))
    try {
      const res = await demoSeed(preset)
      // Backend returns HTTP 200 with {"error": "..."} when already seeded
      if ('error' in res.data) {
        const msg = (res.data as unknown as { error: string }).error
        setStep('seed', 'error')
        addLog(logEntry('error', `Seed failed: ${msg}`, 'Run Reset first, then try again.'))
        toast({
          type: 'error',
          title: 'Drivers Already Seeded',
          message: msg,
          steps: [
            "Click 'Reset' at the bottom of Simulation Steps",
            'Then click Seed Drivers to start fresh',
          ],
        })
        return
      }
      setStep('seed', 'done')
      addLog(logEntry('event', res.data.message, `zone: ${res.data.zone}`))
      const sample = res.data.drivers.slice(0, 5).map(d => `${d.name} (${d.phone})`).join(', ')
      const more = res.data.drivers.length > 5 ? ` +${res.data.drivers.length - 5} more` : ''
      addLog(logEntry('info', `Sample drivers: ${sample}${more}`, `All drivers set to AVAILABLE · PostGIS + Redis populated`))
      const seededDrivers: Record<string, MapDriver> = {}
      res.data.drivers.forEach(d => {
        seededDrivers[d.id] = { id: d.id, name: d.name, lat: d.lat, lng: d.lng, status: 'available' }
      })
      setMapDrivers(() => seededDrivers)
    } catch (err) {
      const msg = apiError(err)
      setStep('seed', 'error')
      addLog(logEntry('error', `Seed failed: ${msg}`))
      toast({
        type: 'error',
        title: 'Seed Failed — Server Unreachable',
        message: msg,
        steps: [
          'Start the backend: cd backend && uvicorn app.main:app --reload',
          'Ensure DEMO_MODE=true is set in backend/.env',
          'Verify port 8000 is free and not blocked',
        ],
      })
    }
  }

  const handleMove = async () => {
    setStep('move', 'running')
    addLog(logEntry('info', 'Starting driver movement — each driver will drift slightly every 4 seconds.', 'POST /api/demo/move · asyncio background loop'))
    try {
      const res = await demoMove()
      if ('error' in res.data) {
        const msg = (res.data as unknown as { error: string }).error
        setStep('move', 'error')
        addLog(logEntry('error', `Move failed: ${msg}`))
        toast({
          type: 'warning',
          title: 'No Drivers to Move',
          message: msg,
          steps: [
            'Complete Step 1 (Seed Drivers) first',
            'Then click Start Movement',
          ],
        })
        return
      }
      setStep('move', 'done')
      addLog(logEntry('event', res.data.message, res.data.detail))
    } catch (err) {
      const msg = apiError(err)
      setStep('move', 'error')
      addLog(logEntry('error', `Move failed: ${msg}`))
      toast({
        type: 'error',
        title: 'Movement Start Failed',
        message: msg,
        steps: [
          'Ensure Step 1 (Seed Drivers) is complete',
          'Check the backend is running on port 8000',
        ],
      })
    }
  }

  const handleRequests = async () => {
    setStep('requests', 'running')
    const meta = PRESET_META[preset]
    addLog(logEntry('info', `Sending ${meta.requests} ride requests all at once — watch the dispatch engine handle them in parallel.`, `POST /api/demo/requests · ${meta.requests} Celery tasks queued`))
    try {
      const res = await demoRequests(preset)
      setStep('requests', 'done')
      addLog(logEntry('event', res.data.message, 'Each request dispatched in parallel via PostGIS ST_DWithin + SELECT FOR UPDATE SKIP LOCKED'))
      const riderNames = [...new Set(res.data.rides.map(r => r.rider_name))].slice(0, 5).join(', ')
      const surgeCount = res.data.rides.filter(r => r.surge_multiplier > 1.0).length
      addLog(logEntry('info',
        `Riders: ${riderNames}${res.data.rides.length > 5 ? ' +more' : ''}${surgeCount > 0 ? ` · ${surgeCount} rides with surge pricing` : ''}`,
        `Lifecycle auto-progresses: +15s driver_arriving, +35s on_trip, +57s completed`,
      ))
      const seededTrips: Record<string, MapTrip> = {}
      res.data.rides.forEach(r => {
        seededTrips[r.id] = { rideId: r.id, driverId: null, pickupLat: r.pickup_lat, pickupLng: r.pickup_lng, destLat: r.dest_lat, destLng: r.dest_lng, status: 'searching' }
      })
      setMapTrips(() => seededTrips)
    } catch (err) {
      const msg = apiError(err)
      setStep('requests', 'error')
      addLog(logEntry('error', `Request creation failed: ${msg}`))
      toast({
        type: 'error',
        title: 'Ride Requests Failed',
        message: msg,
        steps: [
          'Ensure Step 1 (Seed Drivers) completed successfully',
          'Check backend logs for database errors',
          'Click Reset and start over if the issue persists',
        ],
      })
    }
  }

  const handleAiRun = async () => {
    setStep('ai', 'running')
    addLog(logEntry('info', 'Starting AI hotspot detection loop...', `POST /api/demo/ai/run · DBSCAN re-runs every 8s · publishes live updates via WebSocket`))
    try {
      const res = await demoAiRun()
      setStep('ai', 'done')  // 'done' here means "loop is active"

      // Log main result
      addLog(logEntry('event', res.data.message, `Hotspots found: ${res.data.hotspots_found}`))

      // Log each hotspot with details
      if (res.data.hotspots.length > 0) {
        res.data.hotspots.forEach((hotspot, idx) => {
          addLog(logEntry('system',
            `Hotspot ${idx + 1}: ${hotspot.zone_name}`,
            `Demand: ${hotspot.demand} rides | Supply: ${hotspot.drivers_nearby} drivers | Shortage: ${hotspot.shortage} | Confidence: ${(hotspot.confidence * 100).toFixed(0)}% | Radius: ${hotspot.radius_km}km`,
          ))
        })
      } else {
        addLog(logEntry('info', 'No significant hotspots detected — demand is evenly distributed.', 'Increase request count or enable Step 3 again'))
      }
    } catch (err) {
      setStep('ai', 'error')
      addLog(logEntry('error', `AI run failed: ${apiError(err)}`))
    }
  }

  const handleReset = async () => {
    addLog(logEntry('system', 'Wiping all simulation data — starting fresh...', 'POST /api/demo/reset · DELETE rides, drivers, predictions · cancel movement loop'))
    try {
      const res = await demoReset()
      setSteps({ seed: 'idle', move: 'idle', requests: 'idle', ai: 'idle' })
      setMetrics(EMPTY_METRICS)
      setMetricsFreshAt('—')
      setRecentMatches([])
      setMapDrivers(() => ({}))
      setMapTrips(() => ({}))
      setMapAnimEvents([])
      setMapFocusTrigger(0)
      setAiHotspots([])
      setCancelledRideLog([])
      addLog(logEntry('event', res.data.message))
      addLog(logEntry('system', '─── Simulation reset. Previous history kept. Select a scenario and start again when ready. ───'))
    } catch (err) {
      const msg = apiError(err)
      addLog(logEntry('error', `Reset failed: ${msg}`))
      toast({
        type: 'error',
        title: 'Reset Failed',
        message: msg,
        steps: [
          'Try refreshing the browser page (F5)',
          'Restart the backend server if it is unresponsive',
        ],
      })
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  const isStepEnabled = (requires: string | null, key: string, comingSoon?: boolean): boolean => {
    if (comingSoon) return false
    if (steps[key] === 'running') return false
    // AI step can always be re-run; all other steps lock once done
    if (steps[key] === 'done' && key !== 'ai') return false
    if (!requires) return true
    return steps[requires] === 'done'
  }

  const stepBtnClass = (key: string): string => {
    const s = steps[key]
    if (s === 'done')    return 'btn btn-ghost btn-sm'
    if (s === 'running') return 'btn btn-ghost btn-sm'
    if (s === 'error')   return 'btn btn-danger btn-sm'
    return 'btn btn-primary btn-sm'
  }

  const stepIcon = (key: string) => {
    const s = steps[key]
    if (s === 'done')    return '✓'
    if (s === 'running') return '...'
    if (s === 'error')   return '✗'
    return null
  }

  const meta = PRESET_META[preset]
  const by = metrics.by_status
  const searchingNow = (by.requested ?? 0) + (by.searching_driver ?? 0)
  const assignedNow = (by.driver_assigned ?? 0) + (by.driver_arriving ?? 0) + (by.on_trip ?? 0)
  const cancelledNow = by.cancelled ?? 0
  const completedNow = by.completed ?? 0
  const onTripNow = by.on_trip ?? 0
  const arrivingNow = by.driver_arriving ?? 0

  // Dispatch Snapshot derived stats
  const dsTotal = completedNow + cancelledNow
  const dsSuccessRate = dsTotal > 0 ? Math.round((completedNow / dsTotal) * 100) : 0
  const dsAttempts = recentMatches.map(m => m.attempt ?? 1).filter(a => a > 0)
  const dsAvgRetries = dsAttempts.length > 0 ? (dsAttempts.reduce((a, b) => a + b, 0) / dsAttempts.length).toFixed(1) : '—'
  const dsMaxRetries = dsAttempts.length > 0 ? Math.max(...dsAttempts) : 0
  const dsFares = recentMatches.filter(m => m.at.startsWith('✓')).map(m => parseFloat(m.at.replace('✓ ₹', ''))).filter(f => !isNaN(f))
  const dsAvgFare = dsFares.length > 0 ? (dsFares.reduce((a, b) => a + b, 0) / dsFares.length).toFixed(0) : null

  const hotspotStatusColor = (s: string) =>
    s === 'Critical' ? 'var(--red)' : s === 'High' ? 'var(--orange)' : s === 'Moderate' ? 'var(--yellow)' : 'var(--green)'
  const tooltipBg = theme === 'dark' ? '#1a1a1a' : '#ffffff'
  const tooltipBorder = theme === 'dark' ? '#333' : '#d1d5db'
  const tooltipText = theme === 'dark' ? '#f0f0f0' : '#111827'
  const tooltipShadow = theme === 'dark' ? '0 8px 24px rgba(0,0,0,0.6)' : '0 6px 20px rgba(0,0,0,0.12)'

  return (
    <div className="app-shell">
      <header className="topbar">
        <span className="topbar-logo">RideFlow AI</span>
        <AppNav />
      </header>

      <PageHeader
        icon={FlaskConical}
        title="Playground"
        subtitle="Simulate ride dispatch at scale — from a single assignment to peak-hour surge"
        accent="var(--purple)"
        accentBg="var(--purple-light)"
        infoDescription="Choose a traffic scenario, seed drivers into a zone, then fire all ride requests at once. The dispatch engine assigns each rider to the nearest available driver in parallel — race conditions prevented with SELECT FOR UPDATE SKIP LOCKED. Live event streams update continuously as the simulation runs."
        infoTags={['Step-by-step control', 'Parallel dispatch', 'Real-time events']}
      />

      {/* ── Preset Selector ── */}
      <div style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)', padding: '20px 24px' }}>
        <div style={{ maxWidth: 1152, margin: '0 auto' }}>
          <div style={{ marginBottom: 16 }}>
            <p style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)', marginBottom: 3 }}>
              Choose a Traffic Scenario
            </p>
            <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
              This controls how many drivers and ride requests are created.
            </p>
          </div>
          <div className="preset-grid-compact">
            {(Object.keys(PRESET_META) as Preset[]).map((key) => {
              const m = PRESET_META[key]
              const selected = preset === key
              return (
                <button
                  key={key}
                  onClick={() => setPreset(key)}
                  className={`preset-card${selected ? ' selected' : ''}`}
                >
                  <div className="preset-card-head-compact">
                    <span className={`preset-radio${selected ? ' selected' : ''}`} />
                    <span className="preset-card-label">{m.label}</span>
                    <span className="preset-info-chip" aria-label={`${m.label} details`}>
                      i
                      <span className="preset-info-tooltip">
                        <strong>{m.label}</strong>
                        <br />
                        Zone: {m.zone}
                        <br />
                        Search radius: {m.radius}
                        <br />
                        Drivers: {m.drivers} · Requests: {m.requests}
                        <br />
                        {m.shows}
                      </span>
                    </span>
                  </div>

                  <div className="preset-card-meta-row">
                    <span className={`badge ${m.supplyClass}`} style={{ fontSize: 10 }}>
                      {m.supplyLabel}
                    </span>
                    <span className="preset-radius-chip">{m.radius}</span>
                  </div>

                  <div className="preset-kpis-compact">
                    <span className="preset-kpi"><strong>{m.drivers}</strong> drivers</span>
                    <span className="preset-kpi-divider" style={{ color: m.supplyColor }}>{m.supplySymbol}</span>
                    <span className="preset-kpi"><strong>{m.requests}</strong> requests</span>
                  </div>
                </button>
              )
            })}
          </div>
        </div>
      </div>

      {/* ── Live Dispatch Map ── */}
      {steps.seed !== 'idle' && (
        <div style={{ padding: '20px 24px 0' }}>
          <div style={{ maxWidth: 1152, margin: '0 auto' }}>
            <div className="card" style={{ padding: 0, overflow: 'hidden', isolation: 'isolate' }}>

              {/* Map header — title + focus button only */}
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '11px 16px', borderBottom: '1px solid var(--border)', gap: 12,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span className="card-title" style={{ margin: 0 }}>Live Dispatch Map</span>
                  <span style={{
                    fontSize: 11, fontWeight: 500, color: '#334155',
                    background: 'var(--surface-alt, #f1f5f9)', borderRadius: 4,
                    padding: '2px 8px', border: '1px solid var(--border)',
                  }}>
                    {meta.zone}
                  </span>
                </div>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => setMapFocusTrigger(t => t + 1)}
                  title="Re-centre map to fit all active points"
                  style={{ fontSize: 11, padding: '4px 10px', display: 'flex', alignItems: 'center', gap: 5 }}
                >
                  <span style={{ fontSize: 14 }}>⊙</span> Focus
                </button>
              </div>

              {/* Map body */}
              <div style={{ height: 520, position: 'relative' }}>
                <DispatchMap
                  drivers={mapDrivers}
                  trips={mapTrips}
                  animEvents={mapAnimEvents}
                  center={PRESET_MAP[preset]?.center ?? [12.9758, 77.5956]}
                  zoom={PRESET_MAP[preset]?.zoom ?? 13}
                  focusTrigger={mapFocusTrigger}
                  hotspots={aiHotspots}
                  showNumbers
                  showTooltips={false}
                  staticCamera
                />

                {/* ── Floating legend — top-left ── */}
                <div style={{
                  position: 'absolute', top: 10, left: 10, zIndex: 1000,
                  background: 'rgba(255,255,255,0.95)',
                  backdropFilter: 'blur(8px)',
                  border: '1px solid rgba(0,0,0,0.08)',
                  borderRadius: 10,
                  padding: '10px 13px',
                  boxShadow: '0 4px 16px rgba(0,0,0,0.10)',
                  minWidth: 130,
                }}>
                  <div style={{
                    fontSize: 9, fontWeight: 700, color: '#64748b',
                    textTransform: 'uppercase', letterSpacing: '0.07em',
                    marginBottom: 8, fontFamily: 'Inter, system-ui, sans-serif',
                  }}>
                    Legend
                  </div>

                  {/* Drivers */}
                  {[
                    { color: '#16a34a', label: 'Available' },
                    { color: '#d97706', label: 'Assigned' },
                    { color: '#ea580c', label: 'Arriving' },
                    { color: '#2563eb', label: 'On Trip' },
                  ].map(({ color, label }) => (
                    <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 5 }}>
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        width: 18, height: 18, borderRadius: '50%', background: color,
                        border: '2px solid white', boxShadow: '0 1px 4px rgba(0,0,0,0.2)', flexShrink: 0,
                      }} />
                      <span style={{ fontSize: 11, fontWeight: 500, color: '#1e293b', fontFamily: 'Inter, system-ui, sans-serif' }}>{label}</span>
                    </div>
                  ))}

                  {/* AI markers — shown only after Step 4 */}
                  {aiHotspots.length > 0 && (
                    <>
                      <div style={{ borderTop: '1px solid #e2e8f0', margin: '6px 0 6px' }} />
                      <div style={{ fontSize: 9, fontWeight: 700, color: '#db2777', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>AI Detected</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 5 }}>
                        <span style={{ width: 18, height: 18, borderRadius: '50%', border: '2.5px solid #f97316', display: 'inline-block', flexShrink: 0 }} />
                        <span style={{ fontSize: 11, fontWeight: 500, color: '#1e293b', fontFamily: 'Inter, system-ui, sans-serif' }}>Reposition target</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 5 }}>
                        <span style={{ width: 18, height: 18, borderRadius: '50%', background: 'rgba(220,38,38,0.18)', border: '2px solid #dc2626', display: 'inline-block', flexShrink: 0 }} />
                        <span style={{ fontSize: 11, fontWeight: 500, color: '#1e293b', fontFamily: 'Inter, system-ui, sans-serif' }}>Demand hotspot</span>
                      </div>
                    </>
                  )}

                  {/* Divider */}
                  <div style={{ borderTop: '1px solid #e2e8f0', margin: '7px 0' }} />

                  {/* Pickup + Drop with new icons */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 5 }}>
                    <svg width="16" height="20" viewBox="0 0 22 28" style={{ flexShrink: 0 }}>
                      <path d="M11 0C4.93 0 0 4.93 0 11 0 19.3 11 28 11 28S22 19.3 22 11C22 4.93 17.07 0 11 0Z" fill="#16a34a"/>
                      <circle cx="11" cy="11" r="7" fill="#dcfce7"/>
                      <circle cx="11" cy="8.5" r="2.8" fill="#16a34a"/>
                      <path d="M5.5 17c0-3 2.5-5.5 5.5-5.5s5.5 2.5 5.5 5.5" fill="#16a34a"/>
                    </svg>
                    <span style={{ fontSize: 11, fontWeight: 500, color: '#1e293b', fontFamily: 'Inter, system-ui, sans-serif' }}>Pickup (rider)</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 5 }}>
                    <svg width="16" height="20" viewBox="0 0 22 28" style={{ flexShrink: 0 }}>
                      <path d="M11 0C4.93 0 0 4.93 0 11 0 19.3 11 28 11 28S22 19.3 22 11C22 4.93 17.07 0 11 0Z" fill="#dc2626"/>
                      <circle cx="11" cy="11" r="7" fill="#fee2e2"/>
                      <polyline points="7.5,11.5 10,14.5 14.5,8" fill="none" stroke="#dc2626" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                    <span style={{ fontSize: 11, fontWeight: 500, color: '#1e293b', fontFamily: 'Inter, system-ui, sans-serif' }}>Drop-off</span>
                  </div>

                  {/* Route lines */}
                  <div style={{ borderTop: '1px solid #e2e8f0', margin: '7px 0' }} />
                  {[
                    { color: '#ea580c', dash: '8 5', label: 'Driver → Pickup' },
                    { color: '#2563eb', dash: '',    label: 'Trip route' },
                    { color: '#94a3b8', dash: '4 7', label: 'Planned path' },
                  ].map(({ color, dash, label }) => (
                    <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 4 }}>
                      <svg width="20" height="6" style={{ flexShrink: 0 }}>
                        <line
                          x1="0" y1="3" x2="20" y2="3"
                          stroke={color} strokeWidth="2.5"
                          strokeDasharray={dash || undefined}
                        />
                      </svg>
                      <span style={{
                        fontSize: 10, color: '#475569',
                        fontFamily: 'Inter, system-ui, sans-serif',
                      }}>{label}</span>
                    </div>
                  ))}
                </div>

                {/* ── Driver count overlay — bottom-right ── */}
                <div style={{
                  position: 'absolute', bottom: 10, right: 10, zIndex: 1000,
                  background: 'rgba(255,255,255,0.95)',
                  backdropFilter: 'blur(8px)',
                  border: '1px solid rgba(0,0,0,0.08)',
                  borderRadius: 8,
                  padding: '7px 12px',
                  boxShadow: '0 2px 10px rgba(0,0,0,0.08)',
                  display: 'flex', gap: 14, alignItems: 'center',
                }}>
                  {[
                    { count: Object.values(mapDrivers).filter(d => d.status === 'available').length, color: '#16a34a', label: 'avail' },
                    { count: Object.values(mapDrivers).filter(d => d.status === 'arriving').length,  color: '#ea580c', label: 'en route' },
                    { count: Object.values(mapDrivers).filter(d => d.status === 'on_trip').length,   color: '#2563eb', label: 'on trip' },
                  ].map(({ count, color, label }) => (
                    <span key={label} style={{
                      display: 'flex', alignItems: 'baseline', gap: 4,
                      fontFamily: 'Inter, system-ui, sans-serif',
                    }}>
                      <span style={{ fontSize: 14, fontWeight: 700, color }}>{count}</span>
                      <span style={{ fontSize: 10, color: '#64748b', fontWeight: 500 }}>{label}</span>
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Main Body ── */}
      <div className="page-body">

        {/* ── Left: Step Controls ── */}
        <div className="left-col">
          <div className="card">
            <div className="card-header" style={{ flexDirection: 'column', gap: 0, padding: 0, alignItems: 'stretch' }}>
              {/* ── Row 1: title + guide ── */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px' }}>
                <span className="card-title">Simulation Steps</span>
                <button
                  className="info-link-btn"
                  style={{ marginLeft: 'auto' }}
                  onClick={() => setShowExplainModal(true)}
                  title="Open simulation guide"
                >
                  <span className="info-link-icon">i</span>
                  Guide
                </button>
              </div>
              {/* ── Row 2: active scenario chip + reset ── */}
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                gap: 10, padding: '6px 14px',
                background: 'var(--gray-light)',
                borderTop: '1px solid var(--border)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>
                    Preset:
                  </span>
                  <span className={`badge ${meta.supplyClass}`} style={{ fontSize: 10 }}>
                    {meta.label}
                  </span>
                </div>
                <button
                  className="btn btn-danger btn-sm"
                  onClick={handleReset}
                  title="Wipe all drivers, rides, and predictions — start fresh"
                  style={{ fontSize: 11, padding: '3px 10px', flexShrink: 0 }}
                >
                  Reset All
                </button>
              </div>
            </div>
            <div className="card-body flex-col gap-12">
              {STEPS.map((step, stepIdx) => {
                const state = steps[step.key]
                const comingSoon = 'comingSoon' in step ? Boolean(step.comingSoon) : false
                const enabled = isStepEnabled(step.requires, step.key, comingSoon)
                const isDone    = state === 'done'
                const isRunning = state === 'running'
                const isError   = state === 'error'
                const isLocked  = !enabled && !comingSoon

                // Step number circle color
                const circleColor = isDone ? 'var(--green)' : isError ? 'var(--red)' : isRunning ? 'var(--blue)' : isLocked ? 'var(--text-muted)' : 'var(--blue)'
                const circleBg    = isDone ? 'rgba(22,163,74,0.12)' : isError ? 'rgba(220,38,38,0.12)' : isRunning ? 'rgba(37,99,235,0.12)' : 'rgba(0,0,0,0.06)'

                // Step number content
                const circleContent = isDone ? '✓' : isError ? '✕' : isRunning ? '…' : String(stepIdx + 1)

                // Card accent
                const borderColor = isDone ? 'rgba(22,163,74,0.3)' : isError ? 'rgba(220,38,38,0.3)' : isRunning ? 'rgba(37,99,235,0.25)' : 'var(--border)'
                const bgColor = isDone ? 'rgba(22,163,74,0.04)' : isError ? 'rgba(220,38,38,0.04)' : 'var(--surface)'

                // Short step name (without "Step N: " prefix)
                const shortLabel = step.label.replace(/^Step \d+:\s*/, '')

                return (
                  <div key={step.key} style={{
                    borderRadius: 8,
                    border: `1px solid ${borderColor}`,
                    background: bgColor,
                    opacity: isLocked ? 0.5 : 1,
                    transition: 'border-color 0.2s, background 0.2s, opacity 0.2s',
                    overflow: 'hidden',
                  }}>
                    {/* Header row: number + title + button */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderBottom: '1px solid var(--border)' }}>
                      <span style={{
                        width: 22, height: 22, borderRadius: '50%', background: circleBg,
                        color: circleColor, fontSize: 11, fontWeight: 800,
                        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                        border: `1.5px solid ${circleColor}`,
                      }}>
                        {circleContent}
                      </span>
                      <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', flex: 1, lineHeight: 1.2 }}>
                        {shortLabel}
                      </span>
                      <button
                        className={stepBtnClass(step.key)}
                        style={{ flexShrink: 0 }}
                        onClick={
                          step.key === 'seed'     ? handleSeed :
                          step.key === 'move'     ? handleMove :
                          step.key === 'requests' ? handleRequests :
                          handleAiRun
                        }
                        disabled={!enabled}
                      >
                        {isRunning ? 'Running…' : isDone && step.key === 'ai' ? 'Restart' : step.buttonLabel}
                      </button>
                    </div>

                    {/* Body: description + tech note */}
                    <div style={{ padding: '8px 12px 10px' }}>
                      <p style={{ fontSize: 11, color: 'var(--text)', lineHeight: 1.55, margin: 0, marginBottom: 5 }}>
                        {step.plain}
                      </p>
                      <p style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.5, margin: 0, fontFamily: 'ui-monospace, monospace' }}>
                        {step.techNote}
                      </p>
                      {isLocked && step.requires && (
                        <p style={{ fontSize: 10, color: 'var(--yellow)', marginTop: 5, fontWeight: 600, margin: '5px 0 0' }}>
                          ⚠ Complete Step {STEPS.findIndex(s => s.key === step.requires) + 1} first
                        </p>
                      )}
                      {step.key === 'seed' && isDone && (
                        <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ fontSize: 10, color: 'var(--green)', fontWeight: 500 }}>
                            ● Live event stream active
                          </span>
                          <a href="/admin" target="_blank" rel="noopener" style={{ fontSize: 10, color: 'var(--blue)', fontWeight: 600, textDecoration: 'none' }}>
                            Open Admin →
                          </a>
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}

            </div>
          </div>
        </div>

        {/* ── Center: Event Log ── */}
        <div className="center-col">
          <EventLog
            entries={logs}
            wsStatus={steps.seed !== 'idle' ? adminWsStatus : 'disconnected'}
            title="Simulation Event Log"
          />
        </div>

        {/* ── Right: Live Details ── */}
        <div className="right-col">

          {/* AI Hotspot Analysis — top priority */}
          {steps.ai !== 'idle' && (
            <div className="card">
              <div className="card-header" style={{ flexWrap: 'nowrap', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                  <span className="card-title" style={{ whiteSpace: 'nowrap' }}>AI Hotspot Analysis</span>
                  <div style={{ position: 'relative', display: 'inline-block', flexShrink: 0 }}>
                    <button
                      style={{ width: 16, height: 16, borderRadius: '50%', border: '1px solid var(--text-muted)', background: 'transparent', color: 'var(--text-muted)', fontSize: 10, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}
                      onMouseEnter={e => { const t = e.currentTarget.nextElementSibling as HTMLElement; if (t) t.style.display = 'block' }}
                      onMouseLeave={e => { const t = e.currentTarget.nextElementSibling as HTMLElement; if (t) t.style.display = 'none' }}
                    >i</button>
                    <div style={{ display: 'none', position: 'absolute', top: '100%', right: 0, marginTop: 6, background: tooltipBg, border: `1px solid ${tooltipBorder}`, borderRadius: 8, padding: '12px 14px', width: 250, fontSize: 10, color: tooltipText, lineHeight: 1.8, zIndex: 1000, boxShadow: tooltipShadow }}
                      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.display = 'none' }}>
                      <div style={{ fontWeight: 700, fontSize: 10, borderBottom: `1px solid ${tooltipBorder}`, paddingBottom: 7, marginBottom: 9 }}>How to read this card</div>
                      {[
                        ['Status', 'Critical / High / Moderate — based on % of unmatched riders'],
                        ['Unmatched', '% of riders in this zone with no driver assigned yet'],
                        ['Fare Impact', 'Estimated surge above base fare from the shortage ratio'],
                        ['Confidence', 'How tightly clustered the requests are — higher = denser hotspot'],
                        ['Deploy', 'Minimum drivers to send into this zone to clear the backlog'],
                        ['Nearest', 'Closest idle drivers by GPS — highlighted orange on map'],
                      ].map(([label, desc]) => (
                        <div key={label} style={{ marginBottom: 5, display: 'flex', gap: 6 }}>
                          <span style={{ fontWeight: 700, flexShrink: 0, minWidth: 70 }}>{label}</span>
                          <span style={{ color: tooltipText, opacity: 0.75 }}>{desc}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
                <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                  {steps.ai === 'done' && (
                    <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 9, fontWeight: 700, color: '#16a34a' }}>
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#16a34a', display: 'inline-block', animation: 'blink 1s infinite' }} />
                      LIVE
                    </span>
                  )}
                </div>
              </div>
              <div style={{ padding: '4px 12px 8px', fontSize: 9, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}>
                Peak demand snapshot · updates every 8s while unmatched rides exist
              </div>
              <div className="card-body flex-col gap-14">
                {aiHotspots.length === 0 && (
                  <div style={{ textAlign: 'center', padding: '16px 8px' }}>
                    <div style={{ fontSize: 28, marginBottom: 10 }}>🟢</div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', marginBottom: 6 }}>
                      No Hotspots Detected
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: 10 }}>
                      DBSCAN found no demand clusters — ride requests are too sparse or spread out for any zone to exceed the threshold.
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', background: 'rgba(0,0,0,0.04)', borderRadius: 6, padding: '8px 10px', textAlign: 'left' }}>
                      <div style={{ fontWeight: 600, marginBottom: 4 }}>Why this happens:</div>
                      <div style={{ marginBottom: 2 }}>· Needs ≥3 requests within 1.5 km of each other</div>
                      <div style={{ marginBottom: 2 }}>· Light traffic spreads requests too thin</div>
                      <div>· Try <strong>Dense preset</strong> to see 2–4 hotspot clusters</div>
                    </div>
                  </div>
                )}
                {aiHotspots.map((hotspot, idx) => (
                  <div key={idx} style={{ padding: '10px', borderRadius: 6, background: 'rgba(220,38,38,0.03)', border: '1px solid rgba(220,38,38,0.1)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text)' }}>{hotspot.zone_name}</span>
                      <span style={{ fontSize: 9, fontWeight: 700, color: hotspotStatusColor(hotspot.zone_status), background: `${hotspotStatusColor(hotspot.zone_status)}18`, padding: '2px 7px', borderRadius: 4, border: `1px solid ${hotspotStatusColor(hotspot.zone_status)}44` }}>
                        {hotspot.zone_status.toUpperCase()}
                      </span>
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.5, marginBottom: 10 }}>
                      {hotspot.shortage > 0
                        ? `${hotspot.unmatched_pct}% of riders unmatched — ${hotspot.shortage} of ${hotspot.demand} requests have no driver.`
                        : 'Supply meets demand. No action required.'}
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 10 }}>
                      {[
                        { label: 'Riders waiting', value: String(hotspot.demand), accent: 'var(--red)' },
                        { label: 'Idle drivers', value: String(hotspot.drivers_nearby), accent: 'var(--green)' },
                        { label: 'Unmatched', value: `${hotspot.unmatched_pct}%`, accent: 'var(--orange)' },
                        { label: 'Cluster confidence', value: `${(hotspot.confidence * 100).toFixed(0)}%`, accent: 'var(--yellow)' },
                      ].map(({ label, value, accent }) => (
                        <div key={label} style={{ background: 'rgba(0,0,0,0.025)', padding: '5px 8px', borderRadius: 4, borderLeft: `2px solid ${accent}` }}>
                          <div style={{ fontSize: 8, color: 'var(--text-muted)', marginBottom: 2, textTransform: 'uppercase', letterSpacing: '0.4px' }}>{label}</div>
                          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>{value}</div>
                        </div>
                      ))}
                    </div>
                    {hotspot.fare_increase_pct > 0 && (
                      <div style={{ background: 'rgba(249,115,22,0.06)', border: '1px solid rgba(249,115,22,0.2)', borderRadius: 4, padding: '7px 10px', marginBottom: 10 }}>
                        <div style={{ fontSize: 8, color: 'var(--text-muted)', marginBottom: 3, textTransform: 'uppercase', letterSpacing: '0.4px' }}>Fare Impact Estimate</div>
                        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--orange)' }}>Fares ~{hotspot.fare_increase_pct}% above baseline ({hotspot.surge_multiplier}x surge)</div>
                        <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 2 }}>Based on {hotspot.unmatched_pct}% demand-supply gap in this cluster</div>
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: 6, marginBottom: hotspot.nearest_drivers.length > 0 ? 10 : 0 }}>
                      <div style={{ flex: 1, background: 'rgba(34,197,94,0.08)', padding: '6px 8px', borderRadius: 4, textAlign: 'center' }}>
                        <div style={{ fontSize: 7, color: 'var(--text-muted)', marginBottom: 2, textTransform: 'uppercase' }}>Deploy</div>
                        <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--green)' }}>+{hotspot.deploy_recommendation}</div>
                      </div>
                      <div style={{ flex: 1, background: 'rgba(59,130,246,0.08)', padding: '6px 8px', borderRadius: 4, textAlign: 'center' }}>
                        <div style={{ fontSize: 7, color: 'var(--text-muted)', marginBottom: 2, textTransform: 'uppercase' }}>Resolves in</div>
                        <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--blue)' }}>{hotspot.eta_minutes} min</div>
                      </div>
                    </div>
                    {hotspot.nearest_drivers.length > 0 && (
                      <div style={{ borderTop: '1px solid rgba(220,38,38,0.1)', paddingTop: 8 }}>
                        <div style={{ fontSize: 8, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: 6 }}>
                          {hotspot.nearest_drivers.every(d => d.status === 'available') ? 'Nearest idle drivers — highlighted on map' : 'Nearest drivers (all busy — none idle)'}
                        </div>
                        {hotspot.nearest_drivers.map((d, i) => {
                          const isAvailable = d.status === 'available'
                          return (
                            <div key={d.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0', borderBottom: i < hotspot.nearest_drivers.length - 1 ? '1px solid var(--border)' : 'none' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <span style={{ width: 7, height: 7, borderRadius: '50%', background: isAvailable ? '#f97316' : '#64748b', display: 'inline-block', flexShrink: 0 }} />
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

          {/* Current Scenario */}
          <div className="card">
            <div className="card-header">
              <span className="card-title">Current Scenario</span>
              <span className={`badge ${meta.supplyClass}`} style={{ marginLeft: 'auto', fontSize: 10 }}>
                {meta.supplyLabel}
              </span>
            </div>
            <div className="card-body flex-col gap-8">
              <div className="info-row">
                <span className="info-label">Preset</span>
                <span className="info-value">{meta.label}</span>
              </div>
              <div className="info-row">
                <span className="info-label">Zone</span>
                <span className="info-value" style={{ fontSize: 11 }}>{meta.zone}</span>
              </div>
              <div className="info-row">
                <span className="info-label">Drivers</span>
                <span className="info-value" style={{ color: 'var(--green)', fontWeight: 600 }}>{meta.drivers}</span>
              </div>
              <div className="info-row">
                <span className="info-label">Requests</span>
                <span className="info-value" style={{ color: 'var(--blue)', fontWeight: 600 }}>{meta.requests}</span>
              </div>
              <div className="info-row">
                <span className="info-label">Search radius</span>
                <span className="info-value">{meta.radius}</span>
              </div>
              <div className="surge-banner" style={{ marginTop: 8, marginBottom: 8 }}>
                {meta.shows}
              </div>
              <div style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                <div style={{ fontSize: 9, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 5 }}>
                  Demo Scale Reference
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, fontSize: 9, color: 'var(--text-muted)' }}>
                  <span>⏱ 1 sec ≈ 1 min travel</span>
                  <span>📍 Location update: 2s</span>
                  <span>🔍 Search: 3 km → 5 km</span>
                  <span>🤖 DBSCAN eps: 1.5 km</span>
                </div>
              </div>
            </div>
          </div>

          {/* AI Hotspot Analysis — moved to top, see above right-col opening */}
          {false && (
              <div className="card">
                <div className="card-header" style={{ flexWrap: 'nowrap', alignItems: 'center' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                    <span className="card-title" style={{ whiteSpace: 'nowrap' }}>AI Hotspot Analysis</span>
                    <div style={{ position: 'relative', display: 'inline-block', flexShrink: 0 }}>
                      <button
                        style={{ width: 16, height: 16, borderRadius: '50%', border: '1px solid var(--text-muted)', background: 'transparent', color: 'var(--text-muted)', fontSize: 10, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}
                        onMouseEnter={e => { const t = e.currentTarget.nextElementSibling as HTMLElement; if (t) t.style.display = 'block' }}
                        onMouseLeave={e => { const t = e.currentTarget.nextElementSibling as HTMLElement; if (t) t.style.display = 'none' }}
                      >i</button>
                      <div style={{ display: 'none', position: 'absolute', top: '100%', right: 0, marginTop: 6, background: tooltipBg, border: `1px solid ${tooltipBorder}`, borderRadius: 8, padding: '12px 14px', width: 250, fontSize: 10, color: tooltipText, lineHeight: 1.8, zIndex: 1000, boxShadow: tooltipShadow }}
                        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.display = 'none' }}>
                        <div style={{ fontWeight: 700, fontSize: 10, borderBottom: `1px solid ${tooltipBorder}`, paddingBottom: 7, marginBottom: 9, letterSpacing: '0.3px' }}>How to read this card</div>
                        <div style={{ marginBottom: 5, display: 'flex', gap: 6 }}>
                          <span style={{ fontWeight: 700, flexShrink: 0, minWidth: 70 }}>Status</span>
                          <span style={{ color: tooltipText, opacity: 0.75 }}>Critical / High / Moderate based on % of unmatched riders</span>
                        </div>
                        <div style={{ marginBottom: 5, display: 'flex', gap: 6 }}>
                          <span style={{ fontWeight: 700, flexShrink: 0, minWidth: 70 }}>Unmatched</span>
                          <span style={{ color: tooltipText, opacity: 0.75 }}>% of riders in this zone with no driver assigned yet</span>
                        </div>
                        <div style={{ marginBottom: 5, display: 'flex', gap: 6 }}>
                          <span style={{ fontWeight: 700, flexShrink: 0, minWidth: 70 }}>Fare Impact</span>
                          <span style={{ color: tooltipText, opacity: 0.75 }}>Estimated surge above base fare from the shortage ratio</span>
                        </div>
                        <div style={{ marginBottom: 5, display: 'flex', gap: 6 }}>
                          <span style={{ fontWeight: 700, flexShrink: 0, minWidth: 70 }}>Confidence</span>
                          <span style={{ color: tooltipText, opacity: 0.75 }}>How tightly clustered the requests are — higher = denser hotspot</span>
                        </div>
                        <div style={{ marginBottom: 5, display: 'flex', gap: 6 }}>
                          <span style={{ fontWeight: 700, flexShrink: 0, minWidth: 70 }}>Deploy</span>
                          <span style={{ color: tooltipText, opacity: 0.75 }}>Minimum drivers to send into this zone to clear the backlog</span>
                        </div>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <span style={{ fontWeight: 700, flexShrink: 0, minWidth: 70 }}>Nearest</span>
                          <span style={{ color: tooltipText, opacity: 0.75 }}>Closest idle drivers by GPS — highlighted orange on map</span>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                    {steps.ai === 'done' && (
                      <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 9, fontWeight: 700, color: '#16a34a' }}>
                        <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#16a34a', display: 'inline-block', animation: 'blink 1s infinite' }} />
                        LIVE
                      </span>
                    )}
                  </div>
                </div>
                <div style={{ padding: '4px 12px 8px', fontSize: 9, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}>
                  Peak demand snapshot · updates every 8s while unmatched rides exist
                </div>
                <div className="card-body flex-col gap-14">
                  {aiHotspots.map((hotspot, idx) => (
                    <div key={idx} style={{ padding: '10px', borderRadius: 6, background: 'rgba(220,38,38,0.03)', border: '1px solid rgba(220,38,38,0.1)' }}>

                      {/* Zone name + status badge */}
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                        <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text)' }}>{hotspot.zone_name}</span>
                        <span style={{ fontSize: 9, fontWeight: 700, color: hotspotStatusColor(hotspot.zone_status), background: `${hotspotStatusColor(hotspot.zone_status)}18`, padding: '2px 7px', borderRadius: 4, border: `1px solid ${hotspotStatusColor(hotspot.zone_status)}44` }}>
                          {hotspot.zone_status.toUpperCase()}
                        </span>
                      </div>

                      {/* Human-readable summary */}
                      <div style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.5, marginBottom: 10 }}>
                        {hotspot.shortage > 0
                          ? `${hotspot.unmatched_pct}% of riders unmatched — ${hotspot.shortage} of ${hotspot.demand} requests have no driver.`
                          : 'Supply meets demand. No action required.'}
                      </div>

                      {/* Key metrics row */}
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 10 }}>
                        {[
                          { label: 'Riders waiting', value: String(hotspot.demand), accent: 'var(--red)' },
                          { label: 'Idle drivers', value: String(hotspot.drivers_nearby), accent: 'var(--green)' },
                          { label: 'Unmatched', value: `${hotspot.unmatched_pct}%`, accent: 'var(--orange)' },
                          { label: 'Cluster confidence', value: `${(hotspot.confidence * 100).toFixed(0)}%`, accent: 'var(--yellow)' },
                        ].map(({ label, value, accent }) => (
                          <div key={label} style={{ background: 'rgba(0,0,0,0.025)', padding: '5px 8px', borderRadius: 4, borderLeft: `2px solid ${accent}` }}>
                            <div style={{ fontSize: 8, color: 'var(--text-muted)', marginBottom: 2, textTransform: 'uppercase', letterSpacing: '0.4px' }}>{label}</div>
                            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>{value}</div>
                          </div>
                        ))}
                      </div>

                      {/* Fare impact analysis */}
                      {hotspot.fare_increase_pct > 0 && (
                        <div style={{ background: 'rgba(249,115,22,0.06)', border: '1px solid rgba(249,115,22,0.2)', borderRadius: 4, padding: '7px 10px', marginBottom: 10 }}>
                          <div style={{ fontSize: 8, color: 'var(--text-muted)', marginBottom: 3, textTransform: 'uppercase', letterSpacing: '0.4px' }}>Fare Impact Estimate</div>
                          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--orange)' }}>
                            Fares ~{hotspot.fare_increase_pct}% above baseline ({hotspot.surge_multiplier}x surge)
                          </div>
                          <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 2 }}>
                            Based on {hotspot.unmatched_pct}% demand-supply gap in this cluster
                          </div>
                        </div>
                      )}

                      {/* Action row */}
                      <div style={{ display: 'flex', gap: 6, marginBottom: hotspot.nearest_drivers.length > 0 ? 10 : 0 }}>
                        <div style={{ flex: 1, background: 'rgba(34,197,94,0.08)', padding: '6px 8px', borderRadius: 4, textAlign: 'center' }}>
                          <div style={{ fontSize: 7, color: 'var(--text-muted)', marginBottom: 2, textTransform: 'uppercase' }}>Deploy</div>
                          <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--green)' }}>+{hotspot.deploy_recommendation}</div>
                        </div>
                        <div style={{ flex: 1, background: 'rgba(59,130,246,0.08)', padding: '6px 8px', borderRadius: 4, textAlign: 'center' }}>
                          <div style={{ fontSize: 7, color: 'var(--text-muted)', marginBottom: 2, textTransform: 'uppercase' }}>Resolves in</div>
                          <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--blue)' }}>{hotspot.eta_minutes} min</div>
                        </div>
                      </div>

                      {/* Nearest drivers */}
                      {hotspot.nearest_drivers.length > 0 && (
                        <div style={{ borderTop: '1px solid rgba(220,38,38,0.1)', paddingTop: 8 }}>
                          <div style={{ fontSize: 8, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: 6 }}>
                            {hotspot.nearest_drivers.every(d => d.status === 'available')
                              ? 'Nearest idle drivers — highlighted on map'
                              : 'Nearest drivers (all busy — none idle)'}
                          </div>
                          {hotspot.nearest_drivers.map((d, i) => {
                            const isAvailable = d.status === 'available'
                            const dotColor = isAvailable ? '#f97316' : '#64748b'
                            const statusLabel = isAvailable ? null : d.status?.replace('_', ' ')
                            return (
                              <div key={d.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0', borderBottom: i < hotspot.nearest_drivers.length - 1 ? '1px solid var(--border)' : 'none' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: dotColor, display: 'inline-block', flexShrink: 0 }} />
                                  <span style={{ fontSize: 10, fontWeight: 600, color: isAvailable ? 'var(--text)' : 'var(--text-muted)' }}>{d.name}</span>
                                  {statusLabel && <span style={{ fontSize: 8, color: 'var(--text-muted)', fontStyle: 'italic' }}>({statusLabel})</span>}
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

          {/* Dispatch Results — live tally shown after Step 3 fires */}
          {steps.requests !== 'idle' ? (
            <div className="card">
              <div className="card-header">
                <span className="card-title">Dispatch Snapshot</span>
                <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>refreshed {metricsFreshAt}</span>
                  <span className="badge badge-gray" style={{ fontSize: 9 }}>LIVE</span>
                </span>
              </div>
              <div className="card-body flex-col gap-10">

                {/* Success rate bar */}
                {dsTotal > 0 && (
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 5 }}>
                      <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--text)' }}>Success Rate</span>
                      <span style={{ fontSize: 13, fontWeight: 800, color: dsSuccessRate >= 70 ? 'var(--green)' : dsSuccessRate >= 50 ? 'var(--yellow)' : 'var(--red)' }}>
                        {dsSuccessRate}%
                      </span>
                    </div>
                    <div style={{ height: 6, borderRadius: 4, background: 'rgba(220,38,38,0.2)', overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${dsSuccessRate}%`, borderRadius: 4, background: dsSuccessRate >= 70 ? 'var(--green)' : dsSuccessRate >= 50 ? 'var(--yellow)' : 'var(--red)', transition: 'width 0.4s ease' }} />
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 3, fontSize: 9, color: 'var(--text-muted)' }}>
                      <span>{completedNow} completed · {cancelledNow} failed</span>
                      <span>{dsTotal} total</span>
                    </div>
                  </div>
                )}

                {/* 4 status tiles */}
                <div className="metrics-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)', gap: 6 }}>
                  <div className="metric-card" style={{ cursor: 'pointer', padding: '8px 10px' }} title="Click for details"
                    onClick={() => setDetailModal({ type: 'assigned', count: assignedNow })}>
                    <div className="metric-value" style={{ color: 'var(--green)', fontSize: 22 }}>{assignedNow}</div>
                    <div className="metric-label" style={{ fontSize: 9 }}>ASSIGNED</div>
                    <div className="metric-sub" style={{ fontSize: 9 }}>
                      {arrivingNow > 0 && <span style={{ color: 'var(--blue)' }}>{arrivingNow} arriving </span>}
                      {onTripNow > 0 && <span style={{ color: 'var(--green)' }}>{onTripNow} on trip</span>}
                      {arrivingNow === 0 && onTripNow === 0 && 'en route / on trip'}
                    </div>
                  </div>
                  <div className="metric-card" style={{ cursor: 'pointer', padding: '8px 10px' }} title="Click for details"
                    onClick={() => setDetailModal({ type: 'searching', count: searchingNow })}>
                    <div className="metric-value" style={{ color: 'var(--yellow)', fontSize: 22 }}>{searchingNow}</div>
                    <div className="metric-label" style={{ fontSize: 9 }}>SEARCHING</div>
                    <div className="metric-sub" style={{ fontSize: 9 }}>awaiting driver</div>
                  </div>
                  <div className="metric-card" style={{ cursor: 'pointer', padding: '8px 10px' }} title="Click for details"
                    onClick={() => {
                      const items: MetricItem[] = cancelledRideLog.map(c => ({ id: c.rideId, label: c.rideId.slice(0, 8) + '…', detail: `at ${c.at}`, color: '#ef4444' }))
                      setDetailModal({ type: 'cancelled', count: cancelledNow, items: items.length > 0 ? items : undefined })
                    }}>
                    <div className="metric-value" style={{ color: 'var(--red)', fontSize: 22 }}>{cancelledNow}</div>
                    <div className="metric-label" style={{ fontSize: 9 }}>FAILED</div>
                    <div className="metric-sub" style={{ fontSize: 9 }}>no driver in 5 km</div>
                  </div>
                  <div className="metric-card" style={{ cursor: 'pointer', padding: '8px 10px' }} title="Click for details"
                    onClick={() => setDetailModal({ type: 'completed', count: completedNow })}>
                    <div className="metric-value" style={{ color: 'var(--blue)', fontSize: 22 }}>{completedNow}</div>
                    <div className="metric-label" style={{ fontSize: 9 }}>COMPLETED</div>
                    <div className="metric-sub" style={{ fontSize: 9 }}>trips finished</div>
                  </div>
                </div>

                {/* Insights row */}
                {dsAttempts.length > 0 && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
                    <div style={{ background: 'rgba(0,0,0,0.03)', padding: '6px 8px', borderRadius: 4, textAlign: 'center' }}>
                      <div style={{ fontSize: 7, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: 2 }}>Avg Retries</div>
                      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>{dsAvgRetries}</div>
                    </div>
                    <div style={{ background: 'rgba(0,0,0,0.03)', padding: '6px 8px', borderRadius: 4, textAlign: 'center' }}>
                      <div style={{ fontSize: 7, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: 2 }}>Max Retries</div>
                      <div style={{ fontSize: 12, fontWeight: 700, color: dsMaxRetries >= 5 ? 'var(--orange)' : 'var(--text)' }}>{dsMaxRetries}</div>
                    </div>
                    {dsAvgFare && (
                      <div style={{ background: 'rgba(0,0,0,0.03)', padding: '6px 8px', borderRadius: 4, textAlign: 'center' }}>
                        <div style={{ fontSize: 7, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: 2 }}>Avg Fare</div>
                        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>₹{dsAvgFare}</div>
                      </div>
                    )}
                  </div>
                )}

                {/* Recent matches */}
                {recentMatches.length > 0 ? (
                  <div>
                    <div className="section-label" style={{ marginBottom: 6, fontSize: 9 }}>Recent Matches</div>
                    {recentMatches.slice(0, 8).map((m, i) => (
                      <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0', borderBottom: i < Math.min(recentMatches.length, 8) - 1 ? '1px solid var(--border)' : 'none', fontSize: 10 }}>
                        <span style={{ color: 'var(--text)', fontWeight: 600, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.driverName}</span>
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
                          <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>{m.radiusKm} km</span>
                          <span style={{ fontSize: 9, color: (m.attempt ?? 1) >= 5 ? 'var(--orange)' : 'var(--text-muted)' }}>try {m.attempt ?? 1}</span>
                          <span style={{ fontSize: 9, color: m.at.startsWith('✓') ? 'var(--green)' : 'var(--text-muted)', fontWeight: 600 }}>{m.at}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-muted" style={{ fontSize: 11 }}>
                    Matches will appear here as assignments are confirmed.
                  </p>
                )}
              </div>
            </div>
          ) : (
            <div className="card">
              <div className="card-header">
                <span className="card-title">Dispatch Results</span>
              </div>
              <div className="card-body">
                <p className="text-muted" style={{ fontSize: 12 }}>
                  Run Steps one after another to fire requests. Live match counts and driver assignments will appear here.
                </p>
              </div>
            </div>
          )}

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

      <InfoModal
        open={showExplainModal}
        title="Playground Guide: What You Are Testing"
        onClose={() => setShowExplainModal(false)}
      >
        <div className="info-modal-block">
          <div className="info-modal-block-title">Big picture</div>
          <p className="info-modal-block-text">
            This page runs an automated city-level simulation. You seed supply (drivers), create demand (ride requests),
            and watch the dispatch engine react in real time.
          </p>
        </div>

        <div className="info-modal-block">
          <div className="info-modal-block-title">What each core step proves</div>
          <p className="info-modal-block-text">
            Step 1 proves driver registration + location storage. Step 2 proves live location heartbeats.
            Step 3 proves concurrent dispatch with nearest-driver search, lock safety, and fallback behavior when supply is low.
          </p>
        </div>

        <div className="info-modal-block">
          <div className="info-modal-block-title">Key backend guarantees</div>
          <p className="info-modal-block-text">
            Nearest-driver lookup uses PostGIS distance queries. Double-assignment is prevented by row locking
            (`SELECT FOR UPDATE SKIP LOCKED`). High-frequency locations live in Redis with TTL, and updates fan out
            over WebSocket via Redis Pub/Sub.
          </p>
        </div>

        <div className="info-modal-block">
          <div className="info-modal-block-title">How to read outcomes quickly</div>
          <p className="info-modal-block-text">
            In light traffic, almost all rides should match quickly. In moderate traffic, retries and radius expansion
            should appear. In dense traffic, you should see more queueing, higher cancellation risk, and stronger surge pressure.
          </p>
        </div>

        <div className="info-modal-block">
          <div className="info-modal-block-title">Playground vs Rider/Driver pages</div>
          <p className="info-modal-block-text">
            Playground is the automated stress simulation. Rider and Driver pages are manual lifecycle views for
            individual ride progression.
          </p>
        </div>
      </InfoModal>
    </div>
  )
}
