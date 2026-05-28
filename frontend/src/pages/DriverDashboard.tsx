import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { AppNav } from '../components/AppNav'
import { PageHeader } from '../components/PageHeader'
import { Gauge } from 'lucide-react'
import { EventLog, logEntry, translateWsEvent } from '../components/EventLog'
import type { LogEntry } from '../components/EventLog'
import { useWebSocket } from '../hooks/useWebSocket'
import { InfoModal } from '../components/InfoModal'
import { useToast } from '../components/Toast'
import {
  registerDriver,
  getDriver,
  updateDriverLocation,
  setDriverStatus as apiSetDriverStatus,
  getRide,
  createRide,
  cancelRide,
  driverArriving,
  startTrip,
  completeTrip,
} from '../api/client'
import type { RideInfo, RideReceipt } from '../api/client'
import { DispatchMap, fetchRoute } from '../components/DispatchMap'
import type { MapDriver, MapTrip, MapAnimEvent, LegendItem } from '../components/DispatchMap'

const DRIVER_LEGEND: LegendItem[] = [
  { label: 'You — available',  color: '#16a34a', shape: 'ring' },
  { label: 'You — assigned',   color: '#d97706', shape: 'ring' },
  { label: 'You — arriving',   color: '#ea580c', shape: 'ring' },
  { label: 'You — on trip',    color: '#2563eb', shape: 'ring' },
  { label: 'Pickup point',     color: '#16a34a', shape: 'pin'  },
  { label: 'Drop-off point',   color: '#dc2626', shape: 'pin'  },
]

const DEFAULT_LAT = '12.9716'
const DEFAULT_LNG = '77.5946'

const BENGALURU_LOCATIONS = [
  // Central
  { label: 'MG Road',              lat: 12.9758, lng: 77.6045 },
  { label: 'Brigade Road',         lat: 12.9719, lng: 77.6074 },
  { label: 'Cubbon Park',          lat: 12.9763, lng: 77.5929 },
  { label: 'Shivajinagar',         lat: 12.9856, lng: 77.6010 },
  // South
  { label: 'Koramangala',          lat: 12.9352, lng: 77.6245 },
  { label: 'HSR Layout',           lat: 12.9116, lng: 77.6389 },
  { label: 'BTM Layout',           lat: 12.9166, lng: 77.6101 },
  { label: 'JP Nagar',             lat: 12.9059, lng: 77.5844 },
  { label: 'Banashankari',         lat: 12.9250, lng: 77.5480 },
  { label: 'Jayanagar',            lat: 12.9258, lng: 77.5936 },
  { label: 'Electronic City',      lat: 12.8450, lng: 77.6601 },
  { label: 'Bommanahalli',         lat: 12.8960, lng: 77.6410 },
  { label: 'Begur',                lat: 12.8650, lng: 77.6200 },
  // East
  { label: 'Indiranagar',          lat: 12.9784, lng: 77.6408 },
  { label: 'Whitefield',           lat: 12.9698, lng: 77.7500 },
  { label: 'Marathahalli',         lat: 12.9591, lng: 77.6974 },
  { label: 'Bellandur',            lat: 12.9258, lng: 77.6762 },
  { label: 'Sarjapur Road',        lat: 12.9010, lng: 77.6860 },
  { label: 'Varthur',              lat: 12.9350, lng: 77.7360 },
  { label: 'KR Puram',             lat: 13.0050, lng: 77.6960 },
  // North
  { label: 'Hebbal',               lat: 13.0354, lng: 77.5970 },
  { label: 'Yelahanka',            lat: 13.1005, lng: 77.5963 },
  { label: 'Thanisandra',          lat: 13.0600, lng: 77.6300 },
  { label: 'Jakkur',               lat: 13.0720, lng: 77.6060 },
  { label: 'Devanahalli',          lat: 13.2465, lng: 77.7130 },
  // West
  { label: 'Malleswaram',          lat: 13.0035, lng: 77.5634 },
  { label: 'Rajajinagar',          lat: 12.9921, lng: 77.5555 },
  { label: 'Yeshwanthpur',         lat: 13.0274, lng: 77.5392 },
  { label: 'Peenya',               lat: 13.0290, lng: 77.5195 },
  { label: 'Magadi Road',          lat: 12.9760, lng: 77.5310 },
]

function pickRandomBengaluruLocation() {
  const base = BENGALURU_LOCATIONS[Math.floor(Math.random() * BENGALURU_LOCATIONS.length)]
  // ±0.002° jitter (~200 m) so drivers aren't all pinned to the same spot
  const lat = +(base.lat + (Math.random() - 0.5) * 0.004).toFixed(4)
  const lng = +(base.lng + (Math.random() - 0.5) * 0.004).toFixed(4)
  return { label: base.label, lat, lng }
}

function fmtCoord(lat: number | null | undefined, lng: number | null | undefined) {
  if (lat == null || lng == null) return '—'
  return `${lat.toFixed(4)}°N, ${lng.toFixed(4)}°E`
}

function CompletionReceiptCard({ receipt }: { receipt: RideReceipt }) {
  return (
    <div className="card" style={{ border: '1px solid var(--border-success)', background: 'var(--surface-success)' }}>
      <div className="card-header" style={{ borderBottom: '1px solid var(--border-success)' }}>
        <span className="card-title" style={{ color: 'var(--green)' }}>Trip Complete — Earnings</span>
        <span className="badge badge-green">Done</span>
      </div>
      <div className="card-body flex-col gap-8">
        <div className="info-row">
          <span className="info-label">Distance</span>
          <span className="info-value" style={{ fontWeight: 600 }}>{receipt.distance_km} km</span>
        </div>
        <div className="info-row">
          <span className="info-label">Duration</span>
          <span className="info-value" style={{ fontWeight: 600 }}>{receipt.duration_display_min} min</span>
        </div>
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 8, marginTop: 2 }}>
          <div className="section-label" style={{ marginBottom: 4 }}>Fare</div>
          <div className="info-row">
            <span className="info-label">Base</span>
            <span className="info-value">₹{receipt.base_fare.toFixed(2)}</span>
          </div>
          <div className="info-row">
            <span className="info-label">Distance</span>
            <span className="info-value">₹{receipt.distance_charge.toFixed(2)}</span>
          </div>
          <div className="info-row">
            <span className="info-label">Time</span>
            <span className="info-value">₹{receipt.time_charge.toFixed(2)}</span>
          </div>
          {receipt.surge_multiplier > 1.0 && (
            <div className="info-row">
              <span className="info-label" style={{ color: 'var(--yellow)' }}>Surge</span>
              <span className="info-value" style={{ color: 'var(--yellow)', fontWeight: 600 }}>{receipt.surge_multiplier}x</span>
            </div>
          )}
          <div className="info-row" style={{ borderTop: '1px solid var(--border)', marginTop: 4, paddingTop: 6 }}>
            <span className="info-label" style={{ fontWeight: 700, fontSize: 13 }}>Total</span>
            <span className="info-value" style={{ fontWeight: 700, color: 'var(--green)', fontSize: 15 }}>₹{receipt.fare_estimate.toFixed(2)}</span>
          </div>
        </div>
        <p className="text-muted" style={{ fontSize: 11, marginTop: 4 }}>
          You're back in the pool — the dispatch engine can assign you to the next nearby ride.
        </p>
      </div>
    </div>
  )
}

export default function DriverDashboard() {
  useEffect(() => { document.title = 'Driver | RideFlow AI' }, [])

  const { toast } = useToast()
  const prevWsStatusRef = useRef<string>('disconnected')

  const [driverName,  setDriverName]  = useState('')
  const [driverPhone, setDriverPhone] = useState('')
  const [driverId,    setDriverId]    = useState<string | null>(() =>
    localStorage.getItem('rideflow_driver_id'),
  )
  const [driverStatus, setDriverStatus] = useState<'available' | 'busy' | 'offline'>('offline')
  const [driverNameStored, setDriverNameStored] = useState<string>(() =>
    localStorage.getItem('rideflow_driver_name') ?? '',
  )

  const [lat,          setLat]          = useState(() => localStorage.getItem('rideflow_driver_lat') ?? DEFAULT_LAT)
  const [lng,          setLng]          = useState(() => localStorage.getItem('rideflow_driver_lng') ?? DEFAULT_LNG)
  const [locationName, setLocationName] = useState(() => localStorage.getItem('rideflow_driver_location') ?? '')
  const [locationSet,  setLocationSet]  = useState(() => !!localStorage.getItem('rideflow_driver_lat'))

  const [activeRide,   setActiveRide]   = useState<RideInfo | null>(null)
  const [lastReceipt,  setLastReceipt]  = useState<RideReceipt | null>(null)

  const [loading,  setLoading]  = useState(false)
  const [showExplainModal, setShowExplainModal] = useState(false)
  const [seedMode,        setSeedMode]        = useState(false)
  const [mapAnimEvents,   setMapAnimEvents]   = useState<MapAnimEvent[]>([])
  const [mapFitTrigger,   setMapFitTrigger]   = useState(0)
  const [mapFocusTrigger, setMapFocusTrigger] = useState(0)
  const [animDone,        setAnimDone]        = useState<Set<string>>(new Set())
  const [cancelKeys,      setCancelKeys]      = useState<string[]>([])
  const prevRideStatusRef  = useRef<string | null>(null)
  const activeRideRef      = useRef<typeof activeRide>(null)
  const seedQueueRef       = useRef(0)
  const [logs, setLogs] = useState<LogEntry[]>([
    logEntry('system', 'Welcome to the Driver Dashboard.'),
    driverId
      ? logEntry('info', 'Welcome back! Your previous driver session was found.', `driver_id: ${driverId}`)
      : logEntry('info', 'No previous session found. Register below to start receiving rides.'),
  ])

  const addLog = useCallback((entry: LogEntry) => {
    setLogs(prev => [...prev, entry])
  }, [])

  const wsStatus = useWebSocket(
    driverId ? `/ws/driver/${driverId}` : '',
    {
      enabled: !!driverId,
      onOpen: () => {
        addLog(logEntry('ws', "You're connected! Ride requests will appear here instantly when dispatched to you.", 'WebSocket /ws/driver/{id} · Redis Pub/Sub'))
      },
      onMessage: async (data) => {
        addLog(translateWsEvent(data))

        if (data.event === 'ride_assigned') {
          const rideId = data.ride_id as string
          addLog(logEntry('info', 'Loading the details of your new ride...', 'GET /api/v1/rides/{id}'))
          try {
            const res = await getRide(rideId)
            setActiveRide(res.data)
            setLastReceipt(null)
            setDriverStatus('busy')
            addLog(logEntry('event',
              `Ride assigned! Pickup: ${fmtCoord(res.data.pickup_lat, res.data.pickup_lng)}`,
              `ride_id: ${res.data.id} · rider: ${res.data.rider_id.slice(0, 8)}… · surge: ${res.data.surge_multiplier}x`,
            ))
          } catch {
            addLog(logEntry('error', 'Could not load ride details. Please try syncing your state.'))
            toast({
              type: 'error',
              title: 'Ride Details Failed',
              message: 'A ride was assigned but its details could not be loaded from the server.',
              steps: [
                'Click "Sync State" to manually reload your active ride',
                'Check that the backend is running and responsive on port 8000',
              ],
            })
          }
        }
      },
    },
  )

  useEffect(() => {
    if (prevWsStatusRef.current === 'connected' && wsStatus === 'disconnected') {
      toast({
        type: 'warning',
        title: 'Live Stream Disconnected',
        message: 'Your driver WebSocket feed has dropped. Ride assignments will not arrive until reconnected.',
        steps: [
          'The system will attempt to reconnect automatically',
          'If this persists, refresh the page (F5)',
          'Check that the backend is running: cd backend && uvicorn app.main:app --reload',
        ],
      })
    }
    prevWsStatusRef.current = wsStatus
  }, [wsStatus, toast])

  const handleRegister = async () => {
    if (!driverName.trim() || !driverPhone.trim()) return
    setLoading(true)
    addLog(logEntry('info', 'Creating your driver account...', 'POST /api/v1/drivers'))
    try {
      const res = await registerDriver(driverName.trim(), driverPhone.trim())
      const id = res.data.id
      const autoLoc = pickRandomBengaluruLocation()
      localStorage.setItem('rideflow_driver_id', id)
      localStorage.setItem('rideflow_driver_name', driverName.trim())
      localStorage.setItem('rideflow_driver_lat', String(autoLoc.lat))
      localStorage.setItem('rideflow_driver_lng', String(autoLoc.lng))
      localStorage.setItem('rideflow_driver_location', autoLoc.label)
      setDriverId(id)
      setDriverNameStored(driverName.trim())
      setDriverStatus('offline')
      setLat(String(autoLoc.lat))
      setLng(String(autoLoc.lng))
      setLocationName(autoLoc.label)
      setLocationSet(true)
      try { await updateDriverLocation(id, autoLoc.lat, autoLoc.lng) } catch { /* non-fatal */ }
      addLog(logEntry('event', `Registered! Location auto-set near ${autoLoc.label} — go online to start receiving rides.`, `driver_id: ${id} · lat: ${autoLoc.lat} · lng: ${autoLoc.lng}`))
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? 'Registration failed'
      addLog(logEntry('error', `Registration failed: ${detail}`))
      const isPhoneInUse = detail.toLowerCase().includes('already') || detail.toLowerCase().includes('unique') || detail.toLowerCase().includes('phone')
      toast({
        type: 'error',
        title: isPhoneInUse ? 'Phone Number Already Registered' : 'Registration Failed — Server Unreachable',
        message: isPhoneInUse
          ? 'This phone number is already linked to another driver account.'
          : 'Could not connect to the backend. The server may be down.',
        steps: isPhoneInUse
          ? ['Use a different phone number', 'Or click "New Session" if you want to start fresh with a new account']
          : [
              'Start the backend: cd backend && uvicorn app.main:app --reload',
              'Ensure DEMO_MODE=true is set in backend/.env',
              'Verify port 8000 is free: lsof -i :8000 (Mac/Linux) or netstat -ano | findstr :8000 (Windows)',
            ],
      })
    } finally {
      setLoading(false)
    }
  }

  const handleToggleOnline = async () => {
    if (!driverId) return
    const newStatus = driverStatus === 'available' ? 'offline' : 'available'
    setLoading(true)
    addLog(logEntry('info', 'Updating your availability...', `PATCH /drivers/{id}/status → ${newStatus}`))
    try {
      await apiSetDriverStatus(driverId, newStatus)
      setDriverStatus(newStatus)
      if (newStatus === 'available') {
        addLog(logEntry('event', "You're online! The system can now match you with nearby riders.", 'status: available · included in PostGIS dispatch pool'))
      } else {
        setLastReceipt(null)
        addLog(logEntry('system', "You're offline. No new rides will be sent to you.", 'status: offline · removed from dispatch pool'))
      }
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? 'Status update failed'
      addLog(logEntry('error', `Status update failed: ${detail}`))
      toast({
        type: 'error',
        title: 'Status Change Failed',
        message: `Could not set your availability to ${newStatus}.`,
        steps: [
          'Verify the backend is running on port 8000',
          'Try clicking "Sync State" to refresh your session',
          'Refresh the page if the problem persists (F5)',
        ],
      })
    } finally {
      setLoading(false)
    }
  }

  const handleArrive = async () => {
    if (!activeRide) return
    setLoading(true)
    try {
      await driverArriving(activeRide.id)
      setActiveRide(prev => prev ? { ...prev, status: 'driver_arriving' } : prev)
      addLog(logEntry('event', 'Marked as arriving — the rider has been notified in real time.', 'state=driver_arriving · WebSocket push via Redis Pub/Sub'))
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? 'Failed'
      addLog(logEntry('error', `Failed: ${detail}`))
      toast({
        type: 'error',
        title: 'Arrive Action Failed',
        message: 'Could not mark you as arriving. The ride state may have changed.',
        steps: [
          'Click "Sync State" to refresh your current ride status',
          'Check backend logs for state machine errors',
        ],
      })
    } finally {
      setLoading(false)
    }
  }

  const handleStartTrip = async () => {
    if (!activeRide) return
    setLoading(true)
    try {
      await startTrip(activeRide.id)
      setActiveRide(prev => prev ? { ...prev, status: 'on_trip' } : prev)
      addLog(logEntry('event', "Trip started! Rider picked up. Fare meter running.", 'state=on_trip · scale 1s=1min'))
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? 'Failed'
      addLog(logEntry('error', `Failed: ${detail}`))
      toast({
        type: 'error',
        title: 'Start Trip Failed',
        message: 'Could not start the trip. The ride must be in driver_arriving state.',
        steps: [
          "Ensure you clicked \"I'm Arriving\" first",
          'Click "Sync State" to check the current ride status',
        ],
      })
    } finally {
      setLoading(false)
    }
  }

  const handleComplete = async () => {
    if (!activeRide) return
    setLoading(true)
    // Stop any in-flight animations immediately so the marker doesn't keep moving
    setCancelKeys([`${activeRide.id}-arriving`, `${activeRide.id}-on_trip`])
    try {
      const res = await completeTrip(activeRide.id)
      const { receipt } = res.data
      setActiveRide(null)
      setLastReceipt(receipt)
      setDriverStatus('available')
      // Advance driver's registered position to the drop-off point so the marker
      // stays at the destination after going offline/online instead of teleporting back
      const newLat = String(receipt.dest_lat)
      const newLng = String(receipt.dest_lng)
      setLat(newLat)
      setLng(newLng)
      localStorage.setItem('rideflow_driver_lat', newLat)
      localStorage.setItem('rideflow_driver_lng', newLng)
      addLog(logEntry('event',
        `Trip complete! ₹${receipt.fare_estimate.toFixed(2)} · ${receipt.distance_km} km · ${receipt.duration_display_min} min`,
        `state=completed · fare breakdown: ₹${receipt.base_fare}+₹${receipt.distance_charge}+₹${receipt.time_charge} · surge=${receipt.surge_multiplier}x · driver reset=available`,
      ))
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? 'Failed'
      addLog(logEntry('error', `Failed: ${detail}`))
      toast({
        type: 'error',
        title: 'Complete Trip Failed',
        message: 'Could not complete the trip. The ride must be in on_trip state.',
        steps: [
          'Click "Sync State" to check the current ride status',
          'Ensure you clicked "Start Trip" before attempting to complete',
          'Check backend logs if this error persists',
        ],
      })
    } finally {
      setLoading(false)
    }
  }

  // Keep ref current so countdown timer can read latest ride without stale closure
  useEffect(() => { activeRideRef.current = activeRide }, [activeRide])

  const handleDeclineRide = async () => {
    const ride = activeRideRef.current
    if (!ride) return
    setLoading(true)
    try {
      await cancelRide(ride.id)
      setActiveRide(null)
      setDriverStatus('available')
      addLog(logEntry('system', 'Ride declined — back in the pool. Next request incoming shortly...', `ride_id: ${ride.id}`))
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? 'Failed'
      addLog(logEntry('error', `Decline failed: ${detail}`))
    } finally {
      setLoading(false)
    }
  }

  const handleForgetSession = () => {
    localStorage.removeItem('rideflow_driver_id')
    localStorage.removeItem('rideflow_driver_name')
    localStorage.removeItem('rideflow_driver_lat')
    localStorage.removeItem('rideflow_driver_lng')
    localStorage.removeItem('rideflow_driver_location')
    setDriverId(null)
    setDriverNameStored('')
    setDriverStatus('offline')
    setActiveRide(null)
    setLastReceipt(null)
    setLat(DEFAULT_LAT)
    setLng(DEFAULT_LNG)
    setLocationName('')
    setLocationSet(false)
    setSeedMode(false)
    seedQueueRef.current = 0
    setMapAnimEvents([])
    prevRideStatusRef.current = null
    setLogs([logEntry('system', 'Session cleared. Register a new account to start fresh.')])
  }

  const handleRestoreSession = async () => {
    if (!driverId) return
    addLog(logEntry('info', 'Checking your current status from the server...', 'GET /api/v1/drivers/{id}'))
    try {
      const res = await getDriver(driverId)
      setDriverStatus(res.data.status)
      if (res.data.active_ride_id) {
        const rideRes = await getRide(res.data.active_ride_id)
        setActiveRide(rideRes.data)
        addLog(logEntry('event', 'You have an active ride — details loaded.', `ride_id: ${res.data.active_ride_id}`))
      }
      if (!locationSet) {
        const autoLoc = pickRandomBengaluruLocation()
        localStorage.setItem('rideflow_driver_lat', String(autoLoc.lat))
        localStorage.setItem('rideflow_driver_lng', String(autoLoc.lng))
        localStorage.setItem('rideflow_driver_location', autoLoc.label)
        setLat(String(autoLoc.lat))
        setLng(String(autoLoc.lng))
        setLocationName(autoLoc.label)
        setLocationSet(true)
        try { await updateDriverLocation(driverId, autoLoc.lat, autoLoc.lng) } catch { /* non-fatal */ }
        addLog(logEntry('event', `Location auto-set near ${autoLoc.label} (${autoLoc.lat}, ${autoLoc.lng}).`, 'PATCH /drivers/{id}/location'))
      }
      addLog(logEntry('event', `Session restored! Status: ${res.data.status.toUpperCase()} · Name: ${res.data.name} · Phone: ${res.data.phone}`))
    } catch {
      addLog(logEntry('error', 'Could not load your session. It may have expired.'))
      toast({
        type: 'error',
        title: 'Session Not Found',
        message: 'Your previous driver session could not be restored from the server.',
        steps: [
          'The session may have expired — click "New Session" to register a fresh account',
          'Verify the backend is running on port 8000',
        ],
      })
    }
  }

  // Countdown: 5 s when a demo ride is assigned
  // Clear seed mode once the demo ride is done (driver back to available, no more queued)
  useEffect(() => {
    if (seedMode && driverStatus === 'available' && seedQueueRef.current <= 0) {
      setSeedMode(false)
      addLog(logEntry('system', 'Demo ride complete — driver is now idle.', 'seed mode cleared'))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedMode, driverStatus])

  // Seed mode: create one request near driver
  useEffect(() => {
    if (!seedMode || driverStatus !== 'available' || !driverId || seedQueueRef.current <= 0) return
    const dLat = parseFloat(lat)
    const dLng = parseFloat(lng)
    const timer = setTimeout(async () => {
      if (seedQueueRef.current <= 0) return
      seedQueueRef.current -= 1
      const R = 0.027  // ~3 km in degrees latitude
      const pLat = +(dLat + (Math.random() - 0.5) * 2 * R).toFixed(4)
      const pLng = +(dLng + (Math.random() - 0.5) * 2 * R).toFixed(4)
      const dest = BENGALURU_LOCATIONS[Math.floor(Math.random() * BENGALURU_LOCATIONS.length)]
      try {
        await createRide(crypto.randomUUID() as string, pLat, pLng, dest.lat, dest.lng)
        addLog(logEntry('info',
          `Demo ride — pickup near you → ${dest.label}`,
          `pickup=(${pLat}, ${pLng}) · 3 km radius · dispatch searching...`,
        ))
      } catch { /* non-fatal */ }
    }, 1500)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedMode, driverStatus, driverId])

  // Seed mode terminates inside the auto-accept handler after the single demo trip completes.

  // Reset animation tracking when the active ride changes (new ride or cleared)
  useEffect(() => {
    setAnimDone(new Set())
    setCancelKeys([])
  }, [activeRide?.id])

  const handleAnimComplete = (key: string) => {
    setAnimDone(prev => new Set([...prev, key]))
  }

  // Bump fitTrigger whenever ride status changes so AutoFitBounds re-shows the scene
  useEffect(() => {
    setMapFitTrigger(n => n + 1)
  }, [activeRide?.status])

  // Fire OSRM-route animations when ride status transitions
  useEffect(() => {
    if (!activeRide || !driverId) {
      prevRideStatusRef.current = null
      return
    }
    const status = activeRide.status
    if (prevRideStatusRef.current === status) return
    prevRideStatusRef.current = status

    if (status === 'driver_arriving' && activeRide.pickup_lat != null) {
      const from: [number, number] = [parseFloat(lat), parseFloat(lng)]
      const to: [number, number] = [activeRide.pickup_lat, activeRide.pickup_lng!]
      fetchRoute(from[0], from[1], to[0], to[1]).then(path => {
        setMapAnimEvents(prev => [...prev, {
          key: `${activeRide.id}-arriving`,
          rideId: activeRide.id,
          phase: 'arriving',
          driverId: driverId,
          fromLat: from[0], fromLng: from[1],
          toLat: to[0],     toLng: to[1],
          durationMs: 12000,
          path,
        }])
      })
    }

    if (status === 'on_trip' && activeRide.pickup_lat != null && activeRide.dest_lat != null) {
      const from: [number, number] = [activeRide.pickup_lat, activeRide.pickup_lng!]
      const to: [number, number]   = [activeRide.dest_lat,   activeRide.dest_lng!]
      fetchRoute(from[0], from[1], to[0], to[1]).then(path => {
        setMapAnimEvents(prev => [...prev, {
          key: `${activeRide.id}-on_trip`,
          rideId: activeRide.id,
          phase: 'on_trip',
          driverId: driverId,
          fromLat: from[0], fromLng: from[1],
          toLat: to[0],     toLng: to[1],
          durationMs: 16000,
          path,
        }])
      })
    }
    // intentionally narrow deps — only fire on status/id change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRide?.status, activeRide?.id])

  const mapDrivers = useMemo<Record<string, MapDriver>>(() => {
    if (!driverId || !locationSet) return {}
    let dLat = parseFloat(lat) || 12.9716
    let dLng = parseFloat(lng) || 77.5946
    // On trip: driver has reached pickup; snap base position there
    if (activeRide?.status === 'on_trip' && activeRide.pickup_lat != null) {
      dLat = activeRide.pickup_lat
      dLng = activeRide.pickup_lng!
    }
    // After completion: driver is at destination
    if (!activeRide && lastReceipt?.dest_lat != null) {
      dLat = lastReceipt.dest_lat
      dLng = lastReceipt.dest_lng ?? dLng
    }
    const mapStatus: MapDriver['status'] =
      activeRide?.status === 'driver_assigned' ? 'assigned' :
      activeRide?.status === 'driver_arriving' ? 'arriving' :
      activeRide?.status === 'on_trip'         ? 'on_trip'  :
      'available'
    return {
      [driverId]: {
        id: driverId,
        name: driverNameStored || 'You',
        lat: dLat,
        lng: dLng,
        glowing: true,
        status: mapStatus,
      },
    }
  }, [driverId, locationSet, lat, lng, driverNameStored, activeRide, lastReceipt])

  const mapTrips = useMemo<Record<string, MapTrip>>(() => {
    if (!activeRide || activeRide.pickup_lat == null || activeRide.dest_lat == null) return {}
    const tripStatus: MapTrip['status'] =
      activeRide.status === 'driver_arriving' ? 'arriving' :
      activeRide.status === 'on_trip'         ? 'on_trip'  :
      'assigned'
    const onTrip = activeRide.status === 'on_trip'
    return {
      [activeRide.id]: {
        rideId:      activeRide.id,
        driverId,
        pickupLat:   activeRide.pickup_lat,
        pickupLng:   activeRide.pickup_lng!,
        destLat:     activeRide.dest_lat,
        destLng:     activeRide.dest_lng!,
        status:      tripStatus,
        pickupLabel: 'Pickup',
        destLabel:   onTrip ? 'Drop-off' : undefined,
      },
    }
  }, [activeRide, driverId])

  const driverMapLabel = useMemo(() => {
    if (activeRide?.status === 'driver_assigned') return 'Ride assigned — navigate to pickup'
    if (activeRide?.status === 'driver_arriving') return 'En route to pickup'
    if (activeRide?.status === 'on_trip')         return 'Trip in progress — navigate to destination'
    if (lastReceipt)                              return 'Trip complete — you have arrived'
    if (driverStatus === 'available')             return 'Online — waiting for a ride request'
    return 'Go online to start receiving rides'
  }, [activeRide?.status, lastReceipt, driverStatus])

  const statusBadge = () => {
    if (driverStatus === 'available') return <span className="badge badge-green"><span className="badge-dot" />Online</span>
    if (driverStatus === 'busy')      return <span className="badge badge-blue"><span className="badge-dot" />On Ride</span>
    return <span className="badge badge-gray"><span className="badge-dot" />Offline</span>
  }

  const rideStatusBadge = (status: string) => {
    const rideId = activeRide?.id ?? ''

    const colorMap: Record<string, string> = {
      driver_assigned: 'badge-purple',
      driver_arriving: 'badge-blue',
      on_trip:         'badge-green',
      completed:       'badge-gray',
    }

    let label: string
    if (status === 'driver_arriving') {
      label = animDone.has(`${rideId}-arriving`) ? 'DRIVER ARRIVED' : 'DRIVER ARRIVING'
    } else if (status === 'on_trip') {
      label = animDone.has(`${rideId}-on_trip`) ? 'REACHED DESTINATION' : 'ON TRIP'
    } else if (status === 'completed') {
      label = 'TRIP COMPLETED'
    } else {
      label = status.replace(/_/g, ' ').toUpperCase()
    }

    return <span className={`badge ${colorMap[status] ?? 'badge-gray'}`}>{label}</span>
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <span className="topbar-logo">RideFlow AI</span>
        <AppNav />
      </header>

      <PageHeader
        icon={Gauge}
        title="Driver Dashboard"
        subtitle="Go online, receive rides instantly, and step through the full trip lifecycle"
        accent="var(--green)"
        accentBg="var(--green-light)"
        infoDescription="Register, set your GPS location, and go online — you enter the dispatch pool immediately. The moment a nearby rider books a trip, you're notified via WebSocket. Step through: I'm Arriving → Start Trip → Complete. Open the Rider tab alongside to see both perspectives update in sync."
        infoTags={['Manual walkthrough', 'Live assignment', 'State transitions']}
      />

      {/* ── Live ride map — only visible when online or on a ride ── */}
      {driverId && locationSet && driverStatus !== 'offline' && (
        <div className="ride-map-section">
          <DispatchMap
            drivers={mapDrivers}
            trips={mapTrips}
            animEvents={mapAnimEvents}
            center={[parseFloat(lat) || 12.9716, parseFloat(lng) || 77.5946]}
            zoom={14}
            uberStyle
            fitTrigger={mapFitTrigger}
            focusTrigger={mapFocusTrigger}
            onAnimComplete={handleAnimComplete}
            cancelAnimKeys={cancelKeys}
            legend={DRIVER_LEGEND}
          />
          <div className="map-status-pill">{driverMapLabel}</div>
          <button
            className="map-focus-btn"
            onClick={() => setMapFocusTrigger(n => n + 1)}
            title="Re-centre map to your location"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/>
            </svg>
            Focus
          </button>
        </div>
      )}

      <div className="page-body">
        {/* ── Left Column ── */}
        <div className="left-col">

          <div className="card">
            <div className="card-header">
              <span className="card-title">Driver Identity</span>
              <div className="header-action-group">
                {driverId && statusBadge()}
                <button className="info-link-btn" onClick={() => setShowExplainModal(true)} title="Open driver guide">
                  <span className="info-link-icon">i</span>
                  Guide
                </button>
              </div>
            </div>
            <div className="card-body flex-col gap-12">
              {!driverId ? (
                <>
                  <div className="field">
                    <label>Full Name</label>
                    <input value={driverName} onChange={e => setDriverName(e.target.value)} placeholder="e.g. Rajesh Kumar" />
                  </div>
                  <div className="field">
                    <label>Phone (must be unique)</label>
                    <input value={driverPhone} onChange={e => setDriverPhone(e.target.value)} placeholder="e.g. +91-9876543210" />
                  </div>
                  <button
                    className="btn btn-primary btn-full"
                    onClick={handleRegister}
                    disabled={loading || !driverName.trim() || !driverPhone.trim()}
                  >
                    {loading ? 'Registering...' : 'Register as Driver'}
                  </button>
                </>
              ) : (
                <>
                  <div className="field">
                    <label>Driver ID</label>
                    <input value={driverId} readOnly className="mono" />
                  </div>
                  {driverNameStored && (
                    <div className="info-row">
                      <span className="info-label">Name</span>
                      <span className="info-value" style={{ fontWeight: 600 }}>{driverNameStored}</span>
                    </div>
                  )}
                  <div className="info-row">
                    <span className="info-label">WS channel</span>
                    <span className="info-value" style={{ fontFamily: 'ui-monospace, monospace', fontSize: 10 }}>/ws/driver/{driverId.slice(0, 8)}…</span>
                  </div>
                  {locationSet && (
                    <>
                      <div className="info-row">
                        <span className="info-label">Area</span>
                        <span className="info-value" style={{ fontWeight: 600 }}>{locationName || 'Bengaluru'}</span>
                      </div>
                      <div className="info-row">
                        <span className="info-label">Coords</span>
                        <span className="info-value" style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11 }}>{lat}°N, {lng}°E</span>
                      </div>
                    </>
                  )}
                  <div className="flex gap-8">
                    <button className="btn btn-ghost btn-sm" onClick={handleRestoreSession}>Sync State</button>
                    <button className="btn btn-ghost btn-sm" onClick={handleForgetSession}>New Session</button>
                  </div>
                </>
              )}
            </div>
          </div>

          {driverId && (
            <div className="card">
              <div className="card-header"><span className="card-title">Availability</span></div>
              <div className="card-body">
                <button
                  className={`btn btn-full ${driverStatus === 'available' ? 'btn-danger' : 'btn-success'}`}
                  onClick={handleToggleOnline}
                  disabled={loading || driverStatus === 'busy'}
                >
                  {driverStatus === 'available' ? 'Go Offline' : 'Go Online'}
                </button>
              </div>
            </div>
          )}

        </div>

        {/* ── Center Column: Event Log ── */}
        <div className="center-col">
          <EventLog entries={logs} wsStatus={driverId ? wsStatus : 'disconnected'} />
        </div>

        {/* ── Right Column ── */}
        <div className="right-col">

          {activeRide ? (
            activeRide.status === 'driver_assigned' ? (
              /* ── Incoming Request card (Uber-style accept/decline) ── */
              <div className="card incoming-request-card">
                <div className="card-header" style={{ background: 'var(--green)', borderColor: 'var(--green)' }}>
                  <span className="card-title" style={{ color: 'white' }}>Incoming Ride Request</span>
                </div>
                <div className="card-body flex-col gap-10">
                  {activeRide.fare_estimate != null && (
                    <div style={{ textAlign: 'center', padding: '6px 0 2px' }}>
                      <span style={{ fontSize: 30, fontWeight: 800, color: 'var(--green)', letterSpacing: '-1px' }}>
                        ₹{activeRide.fare_estimate.toFixed(0)}
                      </span>
                      {activeRide.surge_multiplier > 1.0 && (
                        <span className="badge badge-yellow" style={{ marginLeft: 8, verticalAlign: 'middle' }}>
                          {activeRide.surge_multiplier}x surge
                        </span>
                      )}
                    </div>
                  )}
                  <div className="info-row">
                    <span className="info-label">Pickup</span>
                    <span className="info-value" style={{ fontSize: 11 }}>{fmtCoord(activeRide.pickup_lat, activeRide.pickup_lng)}</span>
                  </div>
                  <div className="info-row">
                    <span className="info-label">Drop</span>
                    <span className="info-value" style={{ fontSize: 11 }}>{fmtCoord(activeRide.dest_lat, activeRide.dest_lng)}</span>
                  </div>
                  <div className="info-row">
                    <span className="info-label">Rider</span>
                    <span className="info-value" style={{ fontFamily: 'ui-monospace, monospace', fontSize: 10 }}>{activeRide.rider_id.slice(0, 8)}…</span>
                  </div>
                  <div className="flex gap-8" style={{ marginTop: 4 }}>
                    <button className="btn btn-success flex-1" onClick={handleArrive} disabled={loading}>
                      Accept
                    </button>
                    <button className="btn btn-danger flex-1" onClick={handleDeclineRide} disabled={loading}>
                      Decline
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              /* ── In-progress ride card (driver_arriving / on_trip) ── */
              <div className="card">
                <div className="card-header">
                  <span className="card-title">Active Ride</span>
                  {rideStatusBadge(activeRide.status)}
                </div>
                <div className="card-body flex-col gap-12">
                  <div className="ride-card">
                    <div className="ride-card-title">Ride Details</div>
                    <div className="ride-card-id">{activeRide.id}</div>
                    <div className="ride-meta">
                      <div className="ride-meta-row">
                        <span className="ride-meta-label">Rider</span>
                        <span className="ride-meta-value" style={{ fontFamily: 'ui-monospace, monospace', fontSize: 10 }}>
                          {activeRide.rider_id.slice(0, 8)}…
                        </span>
                      </div>
                      <div className="ride-meta-row">
                        <span className="ride-meta-label">Pickup</span>
                        <span className="ride-meta-value">{fmtCoord(activeRide.pickup_lat, activeRide.pickup_lng)}</span>
                      </div>
                      <div className="ride-meta-row">
                        <span className="ride-meta-label">Drop</span>
                        <span className="ride-meta-value">{fmtCoord(activeRide.dest_lat, activeRide.dest_lng)}</span>
                      </div>
                      {activeRide.fare_estimate != null && (
                        <div className="ride-meta-row">
                          <span className="ride-meta-label">Est. Fare</span>
                          <span className="ride-meta-value" style={{ fontWeight: 600, color: 'var(--green)' }}>₹{activeRide.fare_estimate.toFixed(2)}</span>
                        </div>
                      )}
                      {activeRide.surge_multiplier > 1.0 && (
                        <div className="ride-meta-row">
                          <span className="ride-meta-label">Surge</span>
                          <span className="ride-meta-value" style={{ color: 'var(--yellow)', fontWeight: 600 }}>{activeRide.surge_multiplier}x</span>
                        </div>
                      )}
                    </div>
                    <div className="ride-actions">
                      {activeRide.status === 'driver_arriving' && (() => {
                        const ready = animDone.has(`${activeRide.id}-arriving`)
                        return (
                          <button
                            className="btn btn-primary btn-sm"
                            onClick={handleStartTrip}
                            disabled={loading || !ready}
                            title={!ready ? 'Reaching pickup — wait for the driver to arrive' : ''}
                          >
                            {ready ? 'Start Trip' : 'Reaching pickup…'}
                          </button>
                        )
                      })()}
                      {activeRide.status === 'on_trip' && (() => {
                        const ready = animDone.has(`${activeRide.id}-on_trip`)
                        return (
                          <button
                            className="btn btn-success btn-sm"
                            onClick={handleComplete}
                            disabled={loading || !ready}
                            title={!ready ? 'En route to destination — wait for arrival' : ''}
                          >
                            {ready ? 'Complete Trip' : 'En route…'}
                          </button>
                        )
                      })()}
                    </div>
                  </div>
                  <p className="text-muted" style={{ fontSize: 11 }}>
                    Tap each button as the trip progresses. The rider sees your status update instantly.
                  </p>
                </div>
              </div>
            )
          ) : lastReceipt ? (
            <CompletionReceiptCard receipt={lastReceipt} />
          ) : driverId && driverStatus === 'available' ? (
            <div className="card">
              <div className="card-header">
                <span className="card-title">Simulate Requests</span>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginLeft: 'auto' }}>
                  {seedMode && <span className="badge badge-blue"><span className="badge-dot" />Demo</span>}
                  <div className="info-tip">
                    <button className="info-tip-btn">ℹ</button>
                    <div className="info-tip-content">
                      <strong style={{ color: 'var(--text)', display: 'block', marginBottom: 4 }}>How it works in production</strong>
                      The dispatch engine continuously monitors all online drivers via PostGIS.
                      When a rider books, the server scores nearby drivers by distance, acceptance
                      rate, and surge zone, then pushes a request over a persistent WebSocket
                      connection. The driver gets a countdown to accept — if they decline or time
                      out, the next closest driver is tried. No polling; every notification is a
                      real-time server push.
                    </div>
                  </div>
                </div>
              </div>
              <div className="card-body flex-col gap-10">
                <div className="empty-state" style={{ padding: '6px 0' }}>
                  <span className="empty-state-icon">⏳</span>
                  Online — waiting for a ride
                </div>
                <p className="text-muted" style={{ fontSize: 12 }}>
                  Test the dispatch cycle without the Rider tab. A simulated request will appear near your location — accept, decline, or let the timer resolve it.
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, margin: '6px 0' }}>
                  <button
                    className={`btn btn-full ${seedMode ? 'btn-danger' : 'btn-success'}`}
                    onClick={() => {
                      if (seedMode) {
                        setSeedMode(false); seedQueueRef.current = 0
                      } else {
                        setSeedMode(true); seedQueueRef.current = 1
                        addLog(logEntry('info', 'Demo ride — a simulated request will appear shortly.', 'accept or decline manually · stops after completion'))
                      }
                    }}
                  >
                    {seedMode ? 'Stop Demo' : 'Demo Ride'}
                  </button>
                  <p className="text-muted" style={{ fontSize: 11 }}>1 simulated trip · accept or decline manually</p>
                </div>
              </div>
            </div>
          ) : (
            <div className="card">
              <div className="card-header"><span className="card-title">Active Ride</span></div>
              <div className="card-body">
                <p className="text-muted" style={{ fontSize: 12 }}>
                  Register and go online — trip details will appear here once dispatched.
                </p>
              </div>
            </div>
          )}

          {/* Driver summary */}
          {driverId && (
            <div className="card">
              <div className="card-header">
                <span className="card-title">Driver Summary</span>
                {statusBadge()}
              </div>
              <div className="card-body flex-col gap-8">
                <div className="info-row">
                  <span className="info-label">Driver ID</span>
                  <span className="info-value truncate" style={{ fontFamily: 'ui-monospace, monospace', fontSize: 10, maxWidth: 130 }}>{driverId}</span>
                </div>
                {driverNameStored && (
                  <div className="info-row">
                    <span className="info-label">Name</span>
                    <span className="info-value" style={{ fontWeight: 600 }}>{driverNameStored}</span>
                  </div>
                )}
                <div className="info-row">
                  <span className="info-label">Status</span>
                  <span className="info-value" style={{ textTransform: 'capitalize' }}>{driverStatus}</span>
                </div>
                <div className="info-row">
                  <span className="info-label">Location</span>
                  <span className="info-value" style={{ fontSize: 11 }}>
                    {locationSet ? (locationName ? `${locationName} · ${lat}°N` : `${lat}°N, ${lng}°E`) : 'Not set'}
                  </span>
                </div>
              </div>
            </div>
          )}

        </div>
      </div>

      <InfoModal open={showExplainModal} title="Driver Guide: Simple Flow" onClose={() => setShowExplainModal(false)}>
        <div className="info-modal-block">
          <div className="info-modal-block-title">Goal</div>
          <p className="info-modal-block-text">Go online, receive a dispatch, and complete one trip lifecycle.</p>
        </div>
        <div className="info-modal-block">
          <div className="info-modal-block-title">Setup steps</div>
          <p className="info-modal-block-text">Register with name and phone — your GPS location is automatically placed near a Bengaluru landmark. Switch to online and the dispatch engine immediately considers you for nearby rides.</p>
        </div>
        <div className="info-modal-block">
          <div className="info-modal-block-title">When a ride arrives</div>
          <p className="info-modal-block-text">You get a live assignment over WebSocket with full ride details. Use: I'm Arriving → Start Trip → Complete Trip. Each button triggers a state machine transition with WebSocket push to the rider.</p>
        </div>
        <div className="info-modal-block">
          <div className="info-modal-block-title">After completion</div>
          <p className="info-modal-block-text">You'll see a fare receipt and return to available status automatically — the dispatch engine can assign you to the next ride immediately.</p>
        </div>
      </InfoModal>
    </div>
  )
}
