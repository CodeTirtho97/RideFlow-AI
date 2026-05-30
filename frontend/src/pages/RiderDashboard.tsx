import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { AppNav } from '../components/AppNav'
import { PageHeader } from '../components/PageHeader'
import { Route } from 'lucide-react'
import { EventLog, logEntry, translateWsEvent } from '../components/EventLog'
import type { LogEntry } from '../components/EventLog'
import { useWebSocket } from '../hooks/useWebSocket'
import { InfoModal } from '../components/InfoModal'
import { useToast } from '../components/Toast'
import { UsageLimitModal } from '../components/UsageLimitModal'
import { useRunLimit } from '../hooks/useRunLimit'
import { createRide, cancelRide, getAvailableDrivers, seedDrivers } from '../api/client'
import type { RideReceipt, AvailableDriver } from '../api/client'
import { DispatchMap, fetchRoute } from '../components/DispatchMap'
import type { MapDriver, MapTrip, MapAnimEvent, LegendItem } from '../components/DispatchMap'

const RIDER_LEGEND: LegendItem[] = [
  { label: 'You (pickup)',     color: '#f59e0b', shape: 'ring' },
  { label: 'Destination',      color: '#dc2626', shape: 'pin'  },
  { label: 'Available driver', color: '#16a34a', shape: 'dot'  },
  { label: 'Assigned',         color: '#d97706', shape: 'dot'  },
  { label: 'Driver arriving',  color: '#ea580c', shape: 'dot'  },
  { label: 'On trip',          color: '#2563eb', shape: 'dot'  },
]

// 30 Bengaluru locations — same pool used by the Driver page
const BENGALURU_LOCATIONS = [
  // Central
  { label: 'MG Road',           lat: 12.9758, lng: 77.6045 },
  { label: 'Brigade Road',      lat: 12.9719, lng: 77.6074 },
  { label: 'Cubbon Park',       lat: 12.9763, lng: 77.5929 },
  { label: 'Shivajinagar',      lat: 12.9856, lng: 77.6010 },
  // South
  { label: 'Koramangala',       lat: 12.9352, lng: 77.6245 },
  { label: 'HSR Layout',        lat: 12.9116, lng: 77.6389 },
  { label: 'BTM Layout',        lat: 12.9166, lng: 77.6101 },
  { label: 'JP Nagar',          lat: 12.9059, lng: 77.5844 },
  { label: 'Banashankari',      lat: 12.9250, lng: 77.5480 },
  { label: 'Jayanagar',         lat: 12.9258, lng: 77.5936 },
  { label: 'Electronic City',   lat: 12.8450, lng: 77.6601 },
  { label: 'Bommanahalli',      lat: 12.8960, lng: 77.6410 },
  { label: 'Begur',             lat: 12.8650, lng: 77.6200 },
  // East
  { label: 'Indiranagar',       lat: 12.9784, lng: 77.6408 },
  { label: 'Whitefield',        lat: 12.9698, lng: 77.7500 },
  { label: 'Marathahalli',      lat: 12.9591, lng: 77.6974 },
  { label: 'Bellandur',         lat: 12.9258, lng: 77.6762 },
  { label: 'Sarjapur Road',     lat: 12.9010, lng: 77.6860 },
  { label: 'Varthur',           lat: 12.9350, lng: 77.7360 },
  { label: 'KR Puram',          lat: 13.0050, lng: 77.6960 },
  // North
  { label: 'Hebbal',            lat: 13.0354, lng: 77.5970 },
  { label: 'Yelahanka',         lat: 13.1005, lng: 77.5963 },
  { label: 'Thanisandra',       lat: 13.0600, lng: 77.6300 },
  { label: 'Jakkur',            lat: 13.0720, lng: 77.6060 },
  { label: 'Devanahalli',       lat: 13.2465, lng: 77.7130 },
  // West
  { label: 'Malleswaram',       lat: 13.0035, lng: 77.5634 },
  { label: 'Rajajinagar',       lat: 12.9921, lng: 77.5555 },
  { label: 'Yeshwanthpur',      lat: 13.0274, lng: 77.5392 },
  { label: 'Peenya',            lat: 13.0290, lng: 77.5195 },
  { label: 'Magadi Road',       lat: 12.9760, lng: 77.5310 },
]

const RIDE_STATES = [
  { key: 'requested',        label: 'Ride Requested'    },
  { key: 'searching_driver', label: 'Finding Driver'    },
  { key: 'driver_assigned',  label: 'Driver Assigned'   },
  { key: 'driver_arriving',  label: 'Driver On the Way' },
  { key: 'on_trip',          label: 'Trip Started'      },
  { key: 'completed',        label: 'Trip Completed'    },
]

function pickRandomLocation() {
  const base = BENGALURU_LOCATIONS[Math.floor(Math.random() * BENGALURU_LOCATIONS.length)]
  const lat = +(base.lat + (Math.random() - 0.5) * 0.004).toFixed(4)
  const lng = +(base.lng + (Math.random() - 0.5) * 0.004).toFixed(4)
  return { label: base.label, lat, lng }
}

function stepState(status: string): (idx: number) => 'done' | 'active' | 'pending' {
  const order = RIDE_STATES.map(s => s.key)
  const currentIdx = order.indexOf(status)
  if (currentIdx < 0) return () => 'pending'
  const isTerminal = currentIdx === order.length - 1
  return (idx: number) => {
    if (idx < currentIdx) return 'done'
    if (idx === currentIdx) return isTerminal ? 'done' : 'active'
    return 'pending'
  }
}

function getSurgeColor(mult: number) {
  if (mult >= 2.0) return 'badge-red'
  if (mult >= 1.5) return 'badge-yellow'
  return 'badge-green'
}

function fmtCoord(lat: number | null | undefined, lng: number | null | undefined) {
  if (lat == null || lng == null) return '—'
  return `${lat.toFixed(4)}°N, ${lng.toFixed(4)}°E`
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function nearestLandmark(lat: number, lng: number) {
  if (isNaN(lat) || isNaN(lng)) return ''
  return BENGALURU_LOCATIONS.reduce((best, loc) =>
    haversineKm(lat, lng, loc.lat, loc.lng) < haversineKm(lat, lng, best.lat, best.lng) ? loc : best
  ).label
}

function ReceiptCard({ receipt, rideId }: { receipt: RideReceipt; rideId: string }) {
  return (
    <div className="card" style={{ border: '1px solid var(--border-success)', background: 'var(--surface-success)' }}>
      <div className="card-header" style={{ borderBottom: '1px solid var(--border-success)' }}>
        <span className="card-title" style={{ color: 'var(--green)' }}>Trip Receipt</span>
        <span className="badge badge-green">Completed</span>
      </div>
      <div className="card-body flex-col gap-10">

        <div className="info-row">
          <span className="info-label">Ride ID</span>
          <span className="info-value" style={{ fontFamily: 'ui-monospace, monospace', fontSize: 10, maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis' }}>{rideId}</span>
        </div>
        {receipt.driver_name && (
          <div className="info-row">
            <span className="info-label">Driver</span>
            <span className="info-value" style={{ fontWeight: 700, fontFamily: 'inherit', fontSize: 13 }}>{receipt.driver_name}</span>
          </div>
        )}

        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
          <div className="section-label">Route</div>
          <div className="info-row">
            <span className="info-label">Pickup</span>
            <span className="info-value" style={{ fontSize: 11 }}>{fmtCoord(receipt.pickup_lat, receipt.pickup_lng)}</span>
          </div>
          <div className="info-row">
            <span className="info-label">Drop-off</span>
            <span className="info-value" style={{ fontSize: 11 }}>{fmtCoord(receipt.dest_lat, receipt.dest_lng)}</span>
          </div>
          <div className="info-row">
            <span className="info-label">Distance</span>
            <span className="info-value" style={{ fontWeight: 600, fontFamily: 'inherit' }}>{receipt.distance_km} km</span>
          </div>
          <div className="info-row">
            <span className="info-label">Duration</span>
            <span className="info-value" style={{ fontWeight: 600, fontFamily: 'inherit' }}>{receipt.duration_display_min} min</span>
          </div>
        </div>

        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
          <div className="section-label">Fare Breakdown</div>
          <div className="info-row">
            <span className="info-label">Booking fee</span>
            <span className="info-value">₹{receipt.base_fare.toFixed(2)}</span>
          </div>
          <div className="info-row">
            <span className="info-label">{receipt.distance_km} km × ₹14/km</span>
            <span className="info-value">₹{receipt.distance_charge.toFixed(2)}</span>
          </div>
          <div className="info-row">
            <span className="info-label">{receipt.duration_display_min} min × ₹1.5/min</span>
            <span className="info-value">₹{receipt.time_charge.toFixed(2)}</span>
          </div>
          {receipt.surge_multiplier > 1.0 && (
            <div className="info-row">
              <span className="info-label" style={{ color: 'var(--yellow)' }}>Surge ({receipt.surge_multiplier}×)</span>
              <span className="badge badge-yellow" style={{ fontSize: 10 }}>{receipt.surge_multiplier}×</span>
            </div>
          )}
          <div className="info-row" style={{ borderTop: '1px solid var(--border)', marginTop: 6, paddingTop: 8 }}>
            <span style={{ fontWeight: 700, color: 'var(--text)', fontSize: 13 }}>Total</span>
            <span style={{ fontWeight: 800, color: 'var(--green)', fontSize: 16, fontFamily: 'inherit' }}>₹{receipt.fare_estimate.toFixed(2)}</span>
          </div>
        </div>

        <p style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }}>
          Go offline then back online to book another ride.
        </p>
      </div>
    </div>
  )
}

export default function RiderDashboard() {
  useEffect(() => { document.title = 'Rider | RideFlow AI' }, [])

  const { toast } = useToast()
  const { runsUsed, limit, limitReached, globalLimitReached, incrementRun } = useRunLimit('rideflow_rider_runs', 3)
  const prevWsStatusRef = useRef<string>('disconnected')
  const isDoneRef        = useRef(false)

  const [riderId] = useState<string>(() => {
    const stored = localStorage.getItem('rideflow_rider_id')
    if (stored) return stored
    const id = crypto.randomUUID()
    localStorage.setItem('rideflow_rider_id', id)
    return id
  })

  // Pickup is auto-set on going online — rider cannot change it
  const [pickupLat,          setPickupLat]          = useState('')
  const [pickupLng,          setPickupLng]          = useState('')
  const [pickupLocationName, setPickupLocationName] = useState('')

  // Destination is the only user-chosen field
  const [destLat,          setDestLat]          = useState('')
  const [destLng,          setDestLng]          = useState('')
  const [destLocationName, setDestLocationName] = useState('')

  const [rideId,             setRideId]             = useState<string | null>(null)
  const [rideStatus,         setRideStatus]         = useState<string | null>(null)
  const [surgeMultiplier,    setSurgeMultiplier]    = useState<number>(1.0)
  const [assignedDriverId,   setAssignedDriverId]   = useState<string | null>(null)
  const [assignedDriverName, setAssignedDriverName] = useState<string | null>(null)
  const [receipt,            setReceipt]            = useState<RideReceipt | null>(null)
  const [loading,            setLoading]            = useState(false)
  const [showExplainModal,   setShowExplainModal]   = useState(false)
  const [riderActive,        setRiderActive]        = useState(false)
  const [availableDrivers,   setAvailableDrivers]   = useState<AvailableDriver[]>([])
  const [mapAnimEvents,      setMapAnimEvents]      = useState<MapAnimEvent[]>([])
  const [mapFitTrigger,      setMapFitTrigger]      = useState(0)
  const [mapFocusTrigger,    setMapFocusTrigger]    = useState(0)
  const [simDriverPos,       setSimDriverPos]       = useState<[number, number] | null>(null)
  const simDriverPosRef       = useRef<[number, number] | null>(null)
  const prevMapStatusRef      = useRef<string | null>(null)
  // Ref so the WS onMessage closure can read the latest seeded drivers
  const availableDriversRef   = useRef<AvailableDriver[]>([])

  const [logs, setLogs] = useState<LogEntry[]>([
    logEntry('system', 'Welcome to the Rider Dashboard. Go online to book a ride.'),
    logEntry('info',   'Your rider ID was loaded from storage — you\'re all set.', `rider_id: ${localStorage.getItem('rideflow_rider_id')}`),
  ])

  const addLog = useCallback((entry: LogEntry) => {
    setLogs(prev => [...prev, entry])
  }, [])

  // Keep ref in sync so the WS handler always reads fresh driver list
  useEffect(() => { availableDriversRef.current = availableDrivers }, [availableDrivers])

  // Bump fitTrigger on every ride status change so AutoFitBounds re-fits the scene
  useEffect(() => {
    if (rideStatus) setMapFitTrigger(n => n + 1)
  }, [rideStatus])

  // Poll available drivers while online and not mid-ride
  useEffect(() => {
    if (!riderActive || rideId) return
    const poll = async () => {
      try { setAvailableDrivers((await getAvailableDrivers()).data) } catch { /* silent */ }
    }
    poll()
    const id = setInterval(poll, 10000)
    return () => clearInterval(id)
  }, [riderActive, rideId])

  const wsStatus = useWebSocket(
    rideId ? `/ws/ride/${rideId}` : '',
    {
      enabled: !!rideId && rideStatus !== 'completed' && rideStatus !== 'cancelled',
      onOpen: () => {
        addLog(logEntry('ws', 'Live updates active — changes arrive the moment they happen.', 'WebSocket /ws/ride/{id} · Redis Pub/Sub fanout'))
      },
      onMessage: (data) => {
        addLog(translateWsEvent(data))

        const event = data.event as string

        if (event === 'driver_assigned') {
          setRideStatus('driver_assigned')
          const driverId = data.driver_id as string
          setAssignedDriverId(driverId)
          setAssignedDriverName((data.driver_name as string) || null)

          // Use the real seeded driver position for accurate map marker + animation start
          const realDriver = availableDriversRef.current.find(d => d.id === driverId)
          if (realDriver) {
            const pos: [number, number] = [realDriver.lat, realDriver.lng]
            simDriverPosRef.current = pos
            setSimDriverPos(pos)
          }

          addLog(logEntry('event',
            `Driver assigned: ${data.driver_name || 'Unknown'}`,
            `driver_id: ${data.driver_id} · attempt ${data.attempt ?? 1} · ${data.radius_km ?? '?'} km radius`,
          ))

        } else if (event === 'status_update') {
          const newStatus = data.status as string
          setRideStatus(newStatus)
          if (data.driver_name && !assignedDriverName) {
            setAssignedDriverName(data.driver_name as string)
          }
          if (newStatus === 'driver_arriving') {
            addLog(logEntry('event',
              `${data.driver_name || 'Driver'} is on the way to your pickup.`,
              'state=driver_arriving',
            ))
          } else if (newStatus === 'on_trip') {
            addLog(logEntry('event',
              'You\'ve been picked up — trip is in progress!',
              'state=on_trip · fare meter running · scale 1s=1min',
            ))
          } else if (newStatus === 'completed') {
            addLog(logEntry('event',
              'Trip completed! See your receipt.',
              'state=completed · driver freed · fare calculated',
            ))
          }

        } else if (event === 'ride_completed') {
          setRideStatus('completed')
          if (data.driver_name) setAssignedDriverName(data.driver_name as string)
          const r: RideReceipt = {
            driver_id:            data.driver_id as string | null,
            driver_name:          data.driver_name as string | null,
            pickup_lat:           data.pickup_lat as number,
            pickup_lng:           data.pickup_lng as number,
            dest_lat:             data.dest_lat as number,
            dest_lng:             data.dest_lng as number,
            distance_km:          data.distance_km as number,
            duration_seconds:     data.duration_seconds as number,
            duration_display_min: data.duration_display_min as number,
            base_fare:            data.base_fare as number,
            distance_charge:      data.distance_charge as number,
            time_charge:          data.time_charge as number,
            surge_multiplier:     data.surge_multiplier as number,
            fare_estimate:        data.fare as number,
          }
          setReceipt(r)
          addLog(logEntry('event',
            `Trip complete! ₹${(data.fare as number).toFixed(2)} · ${data.distance_km} km · ${data.duration_display_min} min`,
            data.message_tech as string || 'state=completed',
          ))

        } else if (event === 'ride_cancelled') {
          setRideStatus('cancelled')
        }
      },
    },
  )

  // ── Ride actions ───────────────────────────────────────────────────────────

  const handleRequestRide = async () => {
    setLoading(true)
    setReceipt(null)
    addLog(logEntry('info', 'Sending your ride request...', 'POST /api/v1/rides'))
    try {
      const res = await createRide(
        riderId,
        parseFloat(pickupLat),
        parseFloat(pickupLng),
        parseFloat(destLat),
        parseFloat(destLng),
      )
      const { id, status, surge_multiplier } = res.data
      setRideId(id)
      setRideStatus(status)
      setSurgeMultiplier(surge_multiplier)
      addLog(logEntry('event',
        'Ride booked! Searching for the nearest available driver...',
        `ride_id: ${id} · status: ${status} · surge: ${surge_multiplier}x`,
      ))
      if (surge_multiplier > 1.0) {
        addLog(logEntry('system',
          `High demand nearby — surge pricing active (${surge_multiplier}x).`,
          'demand > supply · fare adjusted',
        ))
      }
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? 'Request failed'
      addLog(logEntry('error', `Failed to create ride: ${msg}`))
      toast({
        type: 'error',
        title: 'Ride Request Failed',
        message: 'Could not submit your ride request to the server.',
        steps: [
          'Verify the backend is running: cd backend && uvicorn app.main:app --reload',
          'Ensure DEMO_MODE=true is set in backend/.env',
          'Verify port 8000 is free and accessible',
        ],
      })
    } finally {
      setLoading(false)
    }
  }

  const handleCancelRide = async () => {
    if (!rideId) return
    try {
      await cancelRide(rideId)
      setRideStatus('cancelled')
      addLog(logEntry('system', 'You cancelled the ride. The driver slot has been freed.'))
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? 'Cancel failed'
      addLog(logEntry('error', `Cancel failed: ${msg}`))
      toast({
        type: 'warning',
        title: 'Cancellation Failed',
        message: 'Could not cancel the ride. It may already be in progress.',
        steps: [
          'If a driver is already assigned, cancellation may be blocked',
          'Wait for the trip to complete, or contact the driver',
        ],
      })
    }
  }

  // ── Online / Offline ───────────────────────────────────────────────────────

  const handleGoOnline = useCallback(async () => {
    const loc = pickRandomLocation()
    setPickupLat(String(loc.lat))
    setPickupLng(String(loc.lng))
    setPickupLocationName(loc.label)
    setRiderActive(true)
    addLog(logEntry('info', `Setting up your ride near ${loc.label}...`, `pickup=(${loc.lat}, ${loc.lng})`))
    try {
      const res = await seedDrivers(loc.lat, loc.lng)
      setAvailableDrivers(res.data.drivers)
      const nearby = res.data.drivers.slice(0, 3).map(d => d.name).join(', ')
      addLog(logEntry('event',
        `Ready! ${res.data.seeded} drivers online — ${nearby} and others are nearby.`,
        'POST /api/v1/drivers/seed · 3 drivers placed within ~2 km of pickup',
      ))
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? 'Setup failed'
      addLog(logEntry('error', `Could not place drivers: ${msg}`))
      toast({
        type: 'error',
        title: 'Setup Failed',
        message: 'Could not place drivers near your pickup location.',
        steps: ['Check that the backend is running on port 8000', 'Ensure DEMO_MODE=true is set in backend/.env'],
      })
    }
  }, [addLog, toast])

  const handleGoOffline = useCallback(() => {
    incrementRun()
    setRideId(null)
    setRideStatus(null)
    setSurgeMultiplier(1.0)
    setAssignedDriverId(null)
    setAssignedDriverName(null)
    setReceipt(null)
    setSimDriverPos(null)
    setMapAnimEvents([])
    simDriverPosRef.current = null
    prevMapStatusRef.current = null
    setPickupLat('')
    setPickupLng('')
    setPickupLocationName('')
    setAvailableDrivers([])
    setRiderActive(false)
    setLogs([logEntry('system', 'You\'re offline. Go online to book a new ride.')])
  }, [])

  useEffect(() => {
    if (prevWsStatusRef.current === 'connected' && wsStatus === 'disconnected' && !isDoneRef.current) {
      toast({
        type: 'warning',
        title: 'Live Updates Disconnected',
        message: 'Your ride WebSocket feed has dropped. Status changes will not arrive until reconnected.',
        steps: [
          'The system will attempt to reconnect automatically',
          'If this persists, refresh the page (F5)',
          'Check that the backend is running: cd backend && uvicorn app.main:app --reload',
        ],
      })
    }
    prevWsStatusRef.current = wsStatus
  }, [wsStatus, toast])

  // ── Map animation triggers ─────────────────────────────────────────────────

  useEffect(() => {
    if (!rideStatus || !rideId) {
      prevMapStatusRef.current = null
      return
    }
    const prev = prevMapStatusRef.current
    if (prev === rideStatus) return
    prevMapStatusRef.current = rideStatus

    const pLat = parseFloat(pickupLat)
    const pLng = parseFloat(pickupLng)
    const dLat = parseFloat(destLat)
    const dLng = parseFloat(destLng)

    // Fallback synthetic position if real driver wasn't found in availableDrivers
    if (rideStatus === 'driver_assigned' && !simDriverPosRef.current) {
      const pos: [number, number] = [pLat + 0.009, pLng + 0.011]
      simDriverPosRef.current = pos
      setSimDriverPos(pos)
    }

    if (rideStatus === 'driver_arriving' && assignedDriverId) {
      const from = simDriverPosRef.current ?? ([pLat + 0.009, pLng + 0.011] as [number, number])
      const to: [number, number] = [pLat, pLng]
      fetchRoute(from[0], from[1], to[0], to[1]).then(path => {
        setMapAnimEvents(prev => [...prev, {
          key:        `${rideId}-arriving`,
          rideId,
          phase:      'arriving',
          driverId:   assignedDriverId,
          fromLat:    from[0], fromLng: from[1],
          toLat:      to[0],   toLng:   to[1],
          durationMs: 12000,
          path,
        }])
      })
    }

    if (rideStatus === 'on_trip' && assignedDriverId) {
      const newPos: [number, number] = [pLat, pLng]
      simDriverPosRef.current = newPos
      setSimDriverPos(newPos)
      fetchRoute(pLat, pLng, dLat, dLng).then(path => {
        setMapAnimEvents(prev => [...prev, {
          key:        `${rideId}-on_trip`,
          rideId,
          phase:      'on_trip',
          driverId:   assignedDriverId,
          fromLat:    pLat, fromLng: pLng,
          toLat:      dLat, toLng:   dLng,
          durationMs: 16000,
          path,
        }])
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rideStatus, rideId])

  // ── Map data memos ─────────────────────────────────────────────────────────

  const riderMapDrivers = useMemo<Record<string, MapDriver>>(() => {
    // Idle: show seeded driver positions so the rider sees nearby cars
    if (!rideId) {
      return Object.fromEntries(
        availableDrivers.map(d => [d.id, { id: d.id, name: d.name, lat: d.lat, lng: d.lng, status: 'available' as const }])
      )
    }
    // Searching — rideId set but no driver yet: keep green dots visible inside the search circle
    if (!assignedDriverId) {
      return Object.fromEntries(
        availableDrivers.map(d => [d.id, { id: d.id, name: d.name, lat: d.lat, lng: d.lng, status: 'available' as const }])
      )
    }
    if (!simDriverPos) return {}

    const [sLat, sLng] = rideStatus === 'on_trip'
      ? [parseFloat(pickupLat), parseFloat(pickupLng)]
      : simDriverPos

    const mapStatus: MapDriver['status'] =
      rideStatus === 'driver_assigned' ? 'on_trip'   :  // blue once assigned
      rideStatus === 'driver_arriving' ? 'arriving'  :
      rideStatus === 'on_trip'         ? 'on_trip'   :
      'available'

    return {
      [assignedDriverId]: {
        id:     assignedDriverId,
        name:   assignedDriverName || 'Driver',
        lat:    sLat,
        lng:    sLng,
        status: mapStatus,
      },
    }
  }, [rideId, availableDrivers, assignedDriverId, assignedDriverName, simDriverPos, rideStatus, pickupLat, pickupLng])

  const riderMapTrips = useMemo(() => {
    const trips: Record<string, MapTrip> = {}
    const pLat = parseFloat(pickupLat)
    const pLng = parseFloat(pickupLng)
    const dLat = parseFloat(destLat)
    const dLng = parseFloat(destLng)
    if (isNaN(pLat) || isNaN(pLng) || isNaN(dLat) || isNaN(dLng)) return trips

    if (!rideId) {
      trips['preview'] = { rideId: 'preview', driverId: null, pickupLat: pLat, pickupLng: pLng, destLat: dLat, destLng: dLng, status: 'assigned', destLabel: destLocationName || 'Drop-off' }
      return trips
    }

    if (rideStatus === 'completed') {
      trips['dest'] = { rideId: 'rider-at-dest', driverId: null, pickupLat: dLat, pickupLng: dLng, destLat: dLat, destLng: dLng, status: 'assigned' }
      return trips
    }

    if (rideStatus === 'cancelled') return trips

    if (rideStatus === 'requested' || rideStatus === 'searching_driver') {
      trips[rideId] = { rideId, driverId: null, pickupLat: pLat, pickupLng: pLng, destLat: dLat, destLng: dLng, status: 'searching', destLabel: destLocationName || 'Drop-off' }
      return trips
    }

    const tripStatus: MapTrip['status'] =
      rideStatus === 'driver_arriving' ? 'arriving' :
      rideStatus === 'on_trip'         ? 'on_trip'  :
      'assigned'

    trips[rideId] = { rideId, driverId: assignedDriverId, pickupLat: pLat, pickupLng: pLng, destLat: dLat, destLng: dLng, status: tripStatus, destLabel: destLocationName || 'Drop-off' }
    return trips
  }, [rideId, rideStatus, assignedDriverId, pickupLat, pickupLng, destLat, destLng, destLocationName])

  const riderSearchCircle = useMemo(() => {
    if (rideStatus !== 'requested' && rideStatus !== 'searching_driver') return undefined
    const pLat = parseFloat(pickupLat)
    const pLng = parseFloat(pickupLng)
    if (isNaN(pLat) || isNaN(pLng)) return undefined
    return { lat: pLat, lng: pLng, radiusKm: 3 }
  }, [rideStatus, pickupLat, pickupLng])

  const riderMapLabel = useMemo(() => {
    if (!rideId) {
      const n = availableDrivers.length
      if (n === 0) return 'Setting up drivers — please wait a moment'
      return `${n} driver${n > 1 ? 's' : ''} online near your pickup`
    }
    if (rideStatus === 'requested' || rideStatus === 'searching_driver') return 'Searching for a driver within 3 km...'
    if (rideStatus === 'driver_assigned')  return assignedDriverName ? `${assignedDriverName} has been assigned to your ride` : 'Driver assigned — on their way'
    if (rideStatus === 'driver_arriving')  return assignedDriverName ? `${assignedDriverName} is heading to your pickup` : 'Driver is on the way'
    if (rideStatus === 'on_trip')          return 'Trip in progress — heading to your destination'
    if (rideStatus === 'completed')        return 'You have arrived at your destination!'
    if (rideStatus === 'cancelled')        return 'Ride cancelled'
    return 'Ready to book a ride'
  }, [rideId, rideStatus, assignedDriverName, availableDrivers])

  const riderMapCenter = useMemo<[number, number]>(() => {
    const pLat = parseFloat(pickupLat)
    const pLng = parseFloat(pickupLng)
    if (!isNaN(pLat) && !isNaN(pLng)) return [pLat, pLng]
    return [12.9716, 77.5946]
  }, [pickupLat, pickupLng])

  // ── Derived state ──────────────────────────────────────────────────────────

  const getStep: (idx: number) => 'done' | 'active' | 'pending' =
    rideStatus ? stepState(rideStatus) : () => 'pending'
  const isCancelled = rideStatus === 'cancelled'
  const isCompleted = rideStatus === 'completed'
  const isDone      = isCancelled || isCompleted
  isDoneRef.current = isDone

  // Rough fare estimate shown before completion receipt arrives
  // Matches backend formula: ₹50 base + ₹14/km + ₹1.5/min (at 25 km/h city speed), min ₹80
  const estimatedFare = useMemo(() => {
    const pLat = parseFloat(pickupLat)
    const pLng = parseFloat(pickupLng)
    const dLat = parseFloat(destLat)
    const dLng = parseFloat(destLng)
    if (isNaN(pLat) || isNaN(pLng) || isNaN(dLat) || isNaN(dLng)) return null
    const distKm = haversineKm(pLat, pLng, dLat, dLng)
    const estMin = Math.round(distKm / 25 * 60)   // 25 km/h avg city speed
    const raw = 50 + 14 * distKm + 1.5 * estMin
    return Math.max(80, Math.round(raw * surgeMultiplier))
  }, [pickupLat, pickupLng, destLat, destLng, surgeMultiplier])

  const isSearching = rideStatus === 'requested' || rideStatus === 'searching_driver'
  const hasDestination = !!destLat && !!destLng

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="app-shell">
      <header className="topbar">
        <span className="topbar-logo">RideFlow AI</span>
        <AppNav />
      </header>

      <PageHeader
        icon={Route}
        title="Rider Dashboard"
        subtitle="Book a ride and watch it progress live — driver found, arriving, trip started, complete"
        accent="var(--blue)"
        accentBg="var(--blue-light)"
        infoDescription="Go online to auto-set your pickup location and place drivers nearby. Choose a destination, hit Request Ride, and watch the status update in real time over WebSocket. The full lifecycle — assigned, arriving, on trip, completed — runs automatically in demo mode."
        infoTags={['Auto-seeded drivers', 'WebSocket updates', '6-step lifecycle']}
      />

      {/* ── Live ride map — only while online ── */}
      {riderActive && (
        <div className="ride-map-section">
          <DispatchMap
            drivers={riderMapDrivers}
            trips={riderMapTrips}
            animEvents={mapAnimEvents}
            searchCircle={riderSearchCircle}
            center={riderMapCenter}
            zoom={13}
            uberStyle
            fitTrigger={mapFitTrigger}
            focusTrigger={mapFocusTrigger}
            riderLocation={pickupLat ? { lat: parseFloat(pickupLat), lng: parseFloat(pickupLng), label: 'You' } : undefined}
            legend={RIDER_LEGEND}
          />
          <div className="map-status-pill">{riderMapLabel}</div>
          <button
            className="map-focus-btn"
            onClick={() => setMapFocusTrigger(n => n + 1)}
            title="Re-centre map to your pickup location"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3"/>
              <line x1="12" y1="2" x2="12" y2="6"/>
              <line x1="12" y1="18" x2="12" y2="22"/>
              <line x1="2" y1="12" x2="6" y2="12"/>
              <line x1="18" y1="12" x2="22" y2="12"/>
            </svg>
            Focus
          </button>
        </div>
      )}

      {/* ── Horizontal ride steps — shown between map and columns once a ride starts ── */}
      {riderActive && rideId && (
        <div className="ride-steps-bar">
          <div className="h-stepper">
            {RIDE_STATES.map((s, idx) => {
              const state = getStep(idx)
              return (
                <div key={s.key} style={{ display: 'contents' }}>
                  {idx > 0 && (
                    <div className={`h-connector ${getStep(idx - 1) === 'done' ? 'done' : getStep(idx - 1) === 'active' ? 'active' : ''}`} />
                  )}
                  <div className={`h-step ${state}`}>
                    <div className="h-step-icon">{state === 'done' ? '✓' : ''}</div>
                    <div className="h-step-label">{s.label}</div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      <div className="page-body">

        {/* ── Left Column ── */}
        <div className="left-col">

          {/* Identity + Online/Offline */}
          <div className="card">
            <div className="card-header">
              <span className="card-title">Your Identity</span>
              <button className="info-link-btn" style={{ marginLeft: 'auto' }} onClick={() => setShowExplainModal(true)} title="Open rider guide">
                <span className="info-link-icon">i</span>
                Guide
              </button>
            </div>
            <div className="card-body flex-col gap-12">

              {/* Online / Offline toggle — styled as a status row */}
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
                padding: '10px 12px', borderRadius: 6,
                background: riderActive ? 'var(--green-light)' : 'var(--gray-light)',
                border: `1px solid ${riderActive ? 'var(--border-success)' : 'var(--border)'}`,
                transition: 'background 0.2s, border-color 0.2s',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                  {riderActive
                    ? <span className="badge badge-blue"><span className="badge-dot" />Online</span>
                    : <span className="badge badge-gray"><span className="badge-dot" />Offline</span>
                  }
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {riderActive
                      ? (rideId && !isDone ? 'Ride in progress' : 'Ready to book')
                      : 'Go online to book'}
                  </span>
                </div>
                <button
                  className={`btn btn-sm ${riderActive ? 'btn-danger' : 'btn-success'}`}
                  onClick={riderActive ? handleGoOffline : handleGoOnline}
                  disabled={(!!rideId && !isDone) || (!riderActive && limitReached)}
                  style={{ minWidth: 96, flexShrink: 0 }}
                >
                  {riderActive ? 'Go Offline' : 'Go Online'}
                </button>
              </div>

              {/* Usage counter banner */}
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '6px 10px', borderRadius: 6,
                background: limitReached ? 'rgba(220,38,38,0.08)' : 'rgba(0,0,0,0.03)',
                border: `1px solid ${limitReached ? 'rgba(220,38,38,0.2)' : 'var(--border)'}`,
              }}>
                <span style={{ fontSize: 11, color: limitReached ? 'var(--red)' : 'var(--text-muted)' }}>
                  {limitReached ? 'Demo limit reached' : `Rider sessions: ${runsUsed} / ${limit}`}
                </span>
                <span style={{ display: 'flex', gap: 4 }}>
                  {Array.from({ length: limit }).map((_, i) => (
                    <span key={i} style={{
                      width: 7, height: 7, borderRadius: '50%',
                      background: i < runsUsed ? 'var(--red)' : 'var(--border)',
                    }} />
                  ))}
                </span>
              </div>

              <div className="field">
                <label>Rider ID</label>
                <input value={riderId} readOnly className="mono" />
              </div>

            </div>
          </div>

          {/* Book a Ride */}
          <div className="card">
            <div className="card-header">
              <span className="card-title">Where to?</span>
              {!riderActive && (
                <span className="badge badge-gray" style={{ fontSize: 10 }}>Offline</span>
              )}
            </div>
            <div className="card-body flex-col gap-12">

              {/* Auto-set pickup display */}
              {riderActive && pickupLocationName && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  <div className="section-label">Your Pickup (auto-set)</div>
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '10px 12px', borderRadius: 6,
                    background: 'var(--green-light)', border: '1px solid var(--border-success)',
                  }}>
                    <span style={{ color: 'var(--green)', fontSize: 18, lineHeight: 1, flexShrink: 0 }}>◉</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{pickupLocationName}</div>
                      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2, fontFamily: 'ui-monospace, monospace' }}>
                        {pickupLat}°N, {pickupLng}°E
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Destination */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: riderActive && pickupLocationName ? 4 : 0 }}>
                <div className="section-label">Choose Destination</div>
                <div className="field">
                  <label>Pick an area</label>
                  <select
                    value={destLocationName ? `${destLat},${destLng},${destLocationName}` : ''}
                    disabled={!!rideId || !riderActive}
                    onChange={e => {
                      if (!e.target.value) return
                      const parts = e.target.value.split(',')
                      setDestLat(parts[0])
                      setDestLng(parts[1])
                      setDestLocationName(parts[2] || '')
                    }}
                  >
                    <option value="">— select a destination —</option>
                    {BENGALURU_LOCATIONS.map(loc => (
                      <option key={loc.label} value={`${loc.lat},${loc.lng},${loc.label}`}>{loc.label}</option>
                    ))}
                  </select>
                </div>
                <div className="field-row">
                  <div className="field">
                    <label>Latitude</label>
                    <input
                      value={destLat}
                      onChange={e => { setDestLat(e.target.value); setDestLocationName('') }}
                      disabled={!!rideId || !riderActive}
                      placeholder="12.9758"
                    />
                  </div>
                  <div className="field">
                    <label>Longitude</label>
                    <input
                      value={destLng}
                      onChange={e => { setDestLng(e.target.value); setDestLocationName('') }}
                      disabled={!!rideId || !riderActive}
                      placeholder="77.6045"
                    />
                  </div>
                </div>
              </div>

              {!rideId ? (
                <>
                  {!riderActive && (
                    <p className="text-muted" style={{ fontSize: 11, color: 'var(--yellow)', textAlign: 'center' }}>
                      Go online to enable ride booking.
                    </p>
                  )}
                  {riderActive && !hasDestination && (
                    <p className="text-muted" style={{ fontSize: 11, textAlign: 'center' }}>
                      Select a destination above to continue.
                    </p>
                  )}
                  <button
                    className="btn btn-primary btn-full"
                    onClick={handleRequestRide}
                    disabled={loading || !riderActive || !hasDestination}
                  >
                    {loading ? 'Booking...' : 'Request Ride'}
                  </button>
                </>
              ) : (
                <div className="flex gap-8">
                  {!isDone && (
                    <button className="btn btn-danger btn-sm" onClick={handleCancelRide}>
                      Cancel Ride
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

        </div>

        {/* ── Center Column: Event Log ── */}
        <div className="center-col">
          <EventLog entries={logs} wsStatus={rideId ? wsStatus : 'disconnected'} />
        </div>

        {/* ── Right Column ── */}
        <div className="right-col">

          {/* ── Top widget: Your Ride (mirrors Driver's active-ride card) ── */}
          {isCompleted && receipt && rideId ? (
            <ReceiptCard receipt={receipt} rideId={rideId} />
          ) : (
            <div className={`card${isSearching ? ' searching-ride-card' : ''}`}>
              <div className="card-header">
                <span className="card-title">Your Ride</span>
                {/* Status chip — visual only, not clickable */}
                {!riderActive ? (
                  <span className="badge badge-gray" style={{ fontSize: 10 }}>Offline</span>
                ) : isSearching ? (
                  <span className="badge badge-yellow" style={{ fontSize: 10 }}>
                    <span className="badge-dot" style={{ animation: 'pulse 1s ease-in-out infinite' }} />
                    Searching
                  </span>
                ) : rideStatus === 'driver_assigned' ? (
                  <span className="badge badge-purple" style={{ fontSize: 10 }}>Driver Assigned</span>
                ) : rideStatus === 'driver_arriving' ? (
                  <span className="badge badge-blue" style={{ fontSize: 10 }}>Driver Arriving</span>
                ) : rideStatus === 'on_trip' ? (
                  <span className="badge badge-green" style={{ fontSize: 10 }}>Trip Started</span>
                ) : isCancelled ? (
                  <span className="badge badge-red" style={{ fontSize: 10 }}>Cancelled</span>
                ) : null}
              </div>

              <div className="card-body flex-col gap-12">
                {isCancelled ? (
                  <div style={{
                    padding: '10px 12px', borderRadius: 6, fontSize: 12, lineHeight: 1.55,
                    background: 'var(--surface-error)', border: '1px solid var(--border-error)', color: 'var(--red)',
                  }}>
                    No drivers found within range. Go offline and back online to try again.
                  </div>
                ) : !riderActive ? (
                  <p className="text-muted" style={{ fontSize: 12, lineHeight: 1.6 }}>
                    Go online to book a ride — pickup is auto-set and drivers are placed nearby.
                  </p>
                ) : (
                  <>
                    {/* From → To route summary */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span style={{ color: 'var(--green)', fontSize: 16, lineHeight: 1, flexShrink: 0 }}>◉</span>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 12, fontWeight: 600, lineHeight: 1.3 }}>
                            {pickupLocationName || nearestLandmark(parseFloat(pickupLat), parseFloat(pickupLng)) || 'Pickup'}
                          </div>
                          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 1 }}>Pickup</div>
                        </div>
                      </div>
                      <div style={{ paddingLeft: 23, fontSize: 10, color: 'var(--border)', lineHeight: 1, letterSpacing: 1 }}>┊</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span style={{ color: 'var(--red)', fontSize: 16, lineHeight: 1, flexShrink: 0 }}>●</span>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 12, fontWeight: 600, color: hasDestination ? 'var(--text)' : 'var(--text-muted)', lineHeight: 1.3 }}>
                            {destLocationName || (hasDestination ? nearestLandmark(parseFloat(destLat), parseFloat(destLng)) : 'Choose destination →')}
                          </div>
                          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 1 }}>Drop-off</div>
                        </div>
                      </div>
                    </div>

                    {/* Fare + surge — shown once a destination is chosen */}
                    {hasDestination && estimatedFare != null && (
                      <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 2 }}>
                        <div className="info-row">
                          <span className="info-label" style={{ fontWeight: 600 }}>Est. Fare</span>
                          <span style={{ fontWeight: 700, color: 'var(--green)', fontSize: 15, fontFamily: 'inherit' }}>
                            ~₹{estimatedFare}
                          </span>
                        </div>
                        {surgeMultiplier > 1.0 && (
                          <div className="info-row">
                            <span className="info-label" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                              Surge pricing
                              <span className="info-tip">
                                <button className="info-tip-btn" tabIndex={-1}>i</button>
                                <div className="info-tip-content" style={{ right: 'auto', left: 0 }}>
                                  <strong style={{ color: 'var(--text)', display: 'block', marginBottom: 4 }}>Why surge pricing?</strong>
                                  Demand near your pickup is higher than available supply right now. The multiplier is applied to the full fare and automatically drops back to 1× when demand eases.
                                </div>
                              </span>
                            </span>
                            <span className={`badge ${getSurgeColor(surgeMultiplier)}`} style={{ fontSize: 11 }}>
                              {surgeMultiplier}×
                            </span>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Driver name once assigned */}
                    {assignedDriverName && (
                      <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Your driver</span>
                        <span style={{ fontSize: 13, fontWeight: 700 }}>{assignedDriverName}</span>
                      </div>
                    )}

                    {/* Contextual status description */}
                    <p style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6, margin: 0 }}>
                      {isSearching
                        ? 'Searching for the nearest available driver within 3 km…'
                        : rideStatus === 'driver_assigned'
                        ? `${assignedDriverName || 'Your driver'} has been assigned and is heading to your pickup.`
                        : rideStatus === 'driver_arriving'
                        ? `${assignedDriverName || 'Your driver'} is on the way to your location.`
                        : rideStatus === 'on_trip'
                        ? 'Ride in progress — heading to your destination.'
                        : !rideId
                        ? hasDestination
                          ? 'Tap Request Ride to find a driver.'
                          : 'Select a destination to get started.'
                        : ''}
                    </p>
                  </>
                )}
              </div>
            </div>
          )}

          {/* Searching helper tips */}
          {rideStatus === 'searching_driver' && (
            <div className="card" style={{ border: '1px solid var(--border-warning)', background: 'var(--surface-warning)' }}>
              <div className="card-header" style={{ borderBottom: '1px solid var(--border-warning)' }}>
                <span className="card-title" style={{ color: 'var(--yellow)' }}>Still searching?</span>
              </div>
              <div className="card-body">
                {[
                  { label: 'Open the Driver tab', detail: 'Register with a name and phone — your location is auto-assigned. Then click "Go Online".' },
                  { label: 'Or use the Playground', detail: 'Run Steps 1–3 to seed many drivers and fire requests automatically.' },
                ].map(({ label, detail }) => (
                  <div key={label} style={{ display: 'flex', gap: 10, marginBottom: 8 }}>
                    <span style={{ color: 'var(--yellow)', fontWeight: 700, fontSize: 14, flexShrink: 0 }}>→</span>
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>{label}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{detail}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

        </div>
      </div>

      {(limitReached || globalLimitReached) && (
        <UsageLimitModal
          page="Rider Dashboard"
          runsUsed={runsUsed}
          limit={limit}
          isGlobal={globalLimitReached && !limitReached}
        />
      )}

      <InfoModal open={showExplainModal} title="Rider Guide: Simple Flow" onClose={() => setShowExplainModal(false)}>
        {/* Run-limit notice */}
        <div style={{
          background: 'linear-gradient(135deg, rgba(234,179,8,0.18) 0%, rgba(234,179,8,0.08) 100%)',
          border: '1.5px solid rgba(234,179,8,0.55)',
          borderRadius: 10, padding: '14px 16px', marginBottom: 4,
        }}>
          <div style={{
            fontSize: 11, fontWeight: 800, color: '#b45309',
            textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8,
          }}>
            Demo Run Limit
          </div>
          <p style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.65, margin: 0 }}>
            The <strong>Rider Dashboard</strong> allows{' '}
            <span style={{ color: '#dc2626', fontWeight: 800, fontSize: 14 }}>3 free runs</span>.{' '}
            One run is counted each time you click{' '}
            <strong style={{ color: '#dc2626' }}>Go Offline</strong>.{' '}
            Runs are stored in your browser and persist across refreshes.
          </p>
          <div style={{
            marginTop: 10, display: 'flex', alignItems: 'center', gap: 10,
            padding: '8px 10px', background: 'rgba(0,0,0,0.06)', borderRadius: 6,
          }}>
            <span style={{ fontSize: 18 }}>🔒</span>
            <span style={{ fontSize: 11, color: 'var(--text)', lineHeight: 1.5 }}>
              Once the limit is hit, a modal blocks the page. Return to Home to reset your session.
            </span>
          </div>
        </div>

        <div className="info-modal-block">
          <div className="info-modal-block-title">Goal</div>
          <p className="info-modal-block-text">Book one ride and follow it live from request to receipt — driver found, arriving, trip, done.</p>
        </div>
        <div className="info-modal-block">
          <div className="info-modal-block-title">Going online</div>
          <p className="info-modal-block-text">Click Go Online — your pickup location is auto-set to a random Bengaluru area and drivers are automatically seeded nearby. No manual steps needed.</p>
        </div>
        <div className="info-modal-block">
          <div className="info-modal-block-title">Booking</div>
          <p className="info-modal-block-text">Choose a destination from the dropdown (or enter coordinates), then hit Request Ride. The system searches for the nearest driver using PostGIS ST_DWithin and assigns one atomically via SELECT FOR UPDATE SKIP LOCKED.</p>
        </div>
        <div className="info-modal-block">
          <div className="info-modal-block-title">What happens after booking</div>
          <p className="info-modal-block-text">In demo mode the full lifecycle runs automatically — driver arriving, trip started, completed — with scaled timing. Every status change is pushed instantly over WebSocket.</p>
        </div>
        <div className="info-modal-block">
          <div className="info-modal-block-title">Receipt &amp; next ride</div>
          <p className="info-modal-block-text">On completion you'll see a full fare receipt. Go offline then back online to book another ride with a fresh pickup location.</p>
        </div>
      </InfoModal>
    </div>
  )
}
