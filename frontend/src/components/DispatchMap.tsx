import React, { useEffect, useRef, useState } from 'react'
import { MapContainer, TileLayer, Marker, Circle, Polyline, Tooltip, ZoomControl, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

export interface MapDriver {
  id: string
  name: string
  lat: number
  lng: number
  status: 'available' | 'assigned' | 'arriving' | 'on_trip'
  glowing?: boolean      // show concentric pulsing rings (driver's own marker on Driver page)
  reposition?: boolean   // show orange pulsing ring (AI-recommended reposition target)
}

export interface LegendItem {
  label: string
  color: string
  shape: 'dot' | 'ring' | 'pin'
}

export interface MapTrip {
  rideId: string
  driverId: string | null
  pickupLat: number
  pickupLng: number
  destLat: number
  destLng: number
  status: 'searching' | 'assigned' | 'arriving' | 'on_trip'
  pickupLabel?: string   // permanent label on pickup pin (uberStyle only); omit to suppress pin when riderLocation is shown
  destLabel?: string     // permanent label on dest pin (uberStyle only)
}

export interface MapAnimEvent {
  key: string
  rideId?: string              // which ride this animation belongs to
  phase?: 'arriving' | 'on_trip'
  driverId: string
  fromLat: number
  fromLng: number
  toLat: number
  toLng: number
  durationMs: number
  path?: [number, number][]   // road-following waypoints from OSRM; straight line if absent
}

interface Props {
  drivers: Record<string, MapDriver>
  trips: Record<string, MapTrip>
  animEvents: MapAnimEvent[]
  center: [number, number]
  zoom: number
  focusTrigger?: number
  fitTrigger?: number            // increment to force AutoFitBounds refit on status change
  showNumbers?: boolean          // show sequential index on each driver marker
  uberStyle?: boolean            // clean Positron/DarkMatter tile + permanent labels (Driver/Rider pages)
  showTooltips?: boolean         // false = suppress all tooltips (Playground — legend is enough)
  searchCircle?: { lat: number; lng: number; radiusKm: number }
  hotspots?: Array<{ center_lat: number; center_lng: number; radius_km: number; demand: number; shortage: number }>
  activeHotspotIdx?: number
  riderLocation?: { lat: number; lng: number; label?: string }
  legend?: LegendItem[]
  onAnimComplete?: (key: string) => void   // fired when an animation key finishes
  cancelAnimKeys?: string[]                // keys to immediately cancel (stop + clear)
  staticCamera?: boolean                   // skip smart phase tracking; always fit all markers (Playground)
}

// ── Module-level OSRM route cache ─────────────────────────────────────────
const _routeCache  = new Map<string, [number, number][]>()
const _inFlight    = new Map<string, Promise<[number, number][]>>()

export async function fetchRoute(
  fromLat: number, fromLng: number,
  toLat: number,   toLng: number,
): Promise<[number, number][]> {
  const key = `${fromLng.toFixed(4)},${fromLat.toFixed(4)};${toLng.toFixed(4)},${toLat.toFixed(4)}`
  if (_routeCache.has(key)) return _routeCache.get(key)!
  if (_inFlight.has(key))   return _inFlight.get(key)!

  const promise = (async (): Promise<[number, number][]> => {
    try {
      const ctrl    = new AbortController()
      const timeout = setTimeout(() => ctrl.abort(), 6000)
      const res = await fetch(
        `https://router.project-osrm.org/route/v1/driving/${key}?overview=full&geometries=geojson&steps=false`,
        { signal: ctrl.signal },
      )
      clearTimeout(timeout)
      if (!res.ok) throw new Error('non-ok')
      const data = await res.json()
      if (data.routes?.[0]?.geometry?.coordinates) {
        const coords: [number, number][] = data.routes[0].geometry.coordinates.map(
          ([lng, lat]: [number, number]) => [lat, lng] as [number, number],
        )
        _routeCache.set(key, coords)
        return coords
      }
    } catch { /* fall through */ }
    const fallback: [number, number][] = [[fromLat, fromLng], [toLat, toLng]]
    _routeCache.set(key, fallback)
    return fallback
  })()

  _inFlight.set(key, promise)
  promise.finally(() => _inFlight.delete(key))
  return promise
}

// ── Icon factories ────────────────────────────────────────────────────────

const DRIVER_COLORS: Record<string, string> = {
  available: '#16a34a',
  assigned:  '#d97706',
  arriving:  '#ea580c',
  on_trip:   '#2563eb',
}

// Cached driver icons: keyed by "status-num"
const _driverIconCache = new Map<string, L.DivIcon>()

function getDriverIcon(status: string, glowing?: boolean, num?: number, reposition?: boolean): L.DivIcon {
  const key  = `${status}:${glowing ? 'g' : ''}:${num ?? ''}:${reposition ? 'r' : ''}`
  if (_driverIconCache.has(key)) return _driverIconCache.get(key)!

  const color = DRIVER_COLORS[status] ?? '#6b7280'
  const size  = 16

  // Dual staggered pulsing rings — only for the driver's own marker
  const rings = glowing ? `
    <span style="position:absolute;inset:-5px;border-radius:50%;border:2px solid ${color};animation:map-ping 2s ease-out infinite;pointer-events:none;"></span>
    <span style="position:absolute;inset:-11px;border-radius:50%;border:2px solid ${color};opacity:0.5;animation:map-ping 2s ease-out infinite 0.7s;pointer-events:none;"></span>
  ` : ''

  // Orange blinking border — AI reposition recommendation
  const repositionRing = reposition ? `
    <span style="position:absolute;inset:-4px;border-radius:50%;border:2.5px solid #f97316;animation:reposition-blink 0.9s ease-in-out infinite;pointer-events:none;"></span>
  ` : ''

  // Small numbered badge for Playground
  const numBadge = num != null
    ? `<span style="position:absolute;top:-5px;right:-7px;background:white;color:${color};border:1.5px solid ${color};border-radius:4px;padding:0 3px;font-size:8px;font-weight:700;line-height:1.5;font-family:Inter,system-ui,sans-serif;">${num}</span>`
    : ''

  const icon = L.divIcon({
    className: '',
    iconSize:  [size, size],
    iconAnchor:[size / 2, size / 2],
    html: `<span style="position:relative;display:flex;align-items:center;justify-content:center;width:${size}px;height:${size}px;border-radius:50%;background:${color};border:2px solid white;box-shadow:0 2px 6px rgba(0,0,0,0.3);">${numBadge}${rings}${repositionRing}</span>`,
  })
  _driverIconCache.set(key, icon)
  return icon
}

// Pin shape helper: 22×28, iconAnchor at tip
function makePinIcon(pinFill: string, circleFill: string, inner: string): L.DivIcon {
  return L.divIcon({
    className: '',
    iconSize:  [22, 28],
    iconAnchor:[11, 27],
    html: `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="28" viewBox="0 0 22 28">
      <path d="M11 0C4.93 0 0 4.93 0 11 0 19.3 11 28 11 28S22 19.3 22 11C22 4.93 17.07 0 11 0Z" fill="${pinFill}"/>
      <circle cx="11" cy="11" r="7" fill="${circleFill}"/>
      ${inner}
    </svg>`,
  })
}

// Pickup: person silhouette inside pin
function makePickupIcon(searching: boolean): L.DivIcon {
  const pin = searching ? '#d97706' : '#16a34a'
  const bg  = searching ? '#fef3c7' : '#dcfce7'
  const person = `
    <circle cx="11" cy="8.5" r="2.8" fill="${pin}"/>
    <path d="M5.5 17c0-3 2.5-5.5 5.5-5.5s5.5 2.5 5.5 5.5" fill="${pin}"/>
  `
  return makePinIcon(pin, bg, person)
}

// Destination: checkmark inside pin
function makeDestIcon(): L.DivIcon {
  const check = `<polyline points="7.5,11.5 10,14.5 14.5,8" fill="none" stroke="#dc2626" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`
  return makePinIcon('#dc2626', '#fee2e2', check)
}

// Pre-create stable icons for pickup/dest (no per-driver variation)
const _pickupSearching = makePickupIcon(true)
const _pickupMatched   = makePickupIcon(false)
const _destIcon        = makeDestIcon()

// Rider "you are here" — 28px amber circle with dual pulsing rings
const _riderIcon = (() => {
  const size  = 28
  const half  = size / 2
  const color = '#f59e0b'
  const person = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="14" height="14" style="display:block;">
    <circle cx="10" cy="6" r="3.5" fill="white"/>
    <path d="M3 18c0-3.87 3.13-7 7-7s7 3.13 7 7" fill="white"/>
  </svg>`
  const rings = `
    <span style="position:absolute;inset:-6px;border-radius:50%;border:2px solid ${color};animation:map-ping 2s ease-out infinite;pointer-events:none;"></span>
    <span style="position:absolute;inset:-13px;border-radius:50%;border:2px solid ${color};opacity:0.5;animation:map-ping 2s ease-out infinite 0.7s;pointer-events:none;"></span>
  `
  return L.divIcon({
    className: '',
    iconSize:  [size, size],
    iconAnchor:[half, half],
    html: `<span style="position:relative;display:flex;align-items:center;justify-content:center;width:${size}px;height:${size}px;border-radius:50%;background:${color};border:2.5px solid white;box-shadow:0 3px 10px rgba(245,158,11,0.45);">${person}${rings}</span>`,
  })
})()

// ── Path-following animation helpers ─────────────────────────────────────

interface AnimEntry extends MapAnimEvent {
  startTs:  number
  cumLens?: number[]     // precomputed cumulative euclidean lengths along path
  totalLen?: number
}

function buildCumLens(path: [number, number][]): { cumLens: number[]; totalLen: number } {
  const cumLens = [0]
  for (let i = 1; i < path.length; i++) {
    const dlat = path[i][0] - path[i - 1][0]
    const dlng = path[i][1] - path[i - 1][1]
    cumLens.push(cumLens[i - 1] + Math.sqrt(dlat * dlat + dlng * dlng))
  }
  return { cumLens, totalLen: cumLens[cumLens.length - 1] }
}

function posOnEntry(entry: AnimEntry, ease: number): [number, number] {
  const { path, cumLens, totalLen } = entry
  if (path && cumLens && totalLen && totalLen > 0) {
    const target = ease * totalLen
    let lo = 0, hi = cumLens.length - 1
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1
      if (cumLens[mid] <= target) lo = mid; else hi = mid
    }
    const segLen = cumLens[hi] - cumLens[lo]
    const t = segLen > 0 ? Math.min((target - cumLens[lo]) / segLen, 1) : 0
    return [
      path[lo][0] + (path[hi][0] - path[lo][0]) * t,
      path[lo][1] + (path[hi][1] - path[lo][1]) * t,
    ]
  }
  return [
    entry.fromLat + (entry.toLat - entry.fromLat) * ease,
    entry.fromLng + (entry.toLng - entry.fromLng) * ease,
  ]
}

// ── Internal sub-components ───────────────────────────────────────────────

// Fits the map to all supplied points when trigger increments;
// falls back to flyTo(center, zoom) when fewer than 2 points are visible.
function FitAllPoints({
  points, center, zoom, trigger,
}: { points: [number, number][]; center: [number, number]; zoom: number; trigger: number }) {
  const map  = useMap()
  const prev = useRef(trigger)
  useEffect(() => {
    if (trigger !== prev.current) {
      prev.current = trigger
      if (points.length >= 2) {
        const bounds = L.latLngBounds(points)
        if (bounds.isValid()) {
          map.fitBounds(bounds, { padding: [55, 55], maxZoom: 15, animate: true })
          return
        }
      }
      map.flyTo(center, zoom, { animate: true, duration: 0.8 })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trigger, map])
  return null
}

// Fly to selected hotspot when activeHotspotIdx changes
function FlyToHotspot({ hotspots, activeIdx }: {
  hotspots?: Array<{ center_lat: number; center_lng: number; radius_km: number }>
  activeIdx?: number
}) {
  const map = useMap()
  const prevIdx = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (activeIdx === undefined || !hotspots || hotspots.length === 0) return
    if (activeIdx === prevIdx.current) return
    prevIdx.current = activeIdx
    const h = hotspots[activeIdx]
    if (!h) return
    const rad = (h.radius_km * 1.8) / 111.0
    const bounds = L.latLngBounds(
      [h.center_lat - rad, h.center_lng - rad],
      [h.center_lat + rad, h.center_lng + rad],
    )
    map.fitBounds(bounds, { padding: [30, 30], animate: true, duration: 0.7, maxZoom: 15 })
  }, [activeIdx, hotspots, map])
  return null
}

// Smart camera: phase-aware bounds fitting with live tracking during animations
function SmartCamera({
  drivers, trips, animPos, riderLocation, searchCircle, hotspots, center, zoom, fitTrigger, staticCamera,
}: {
  drivers: Record<string, MapDriver>
  trips: Record<string, MapTrip>
  animPos: Record<string, [number, number]>
  riderLocation?: { lat: number; lng: number }
  searchCircle?: { lat: number; lng: number; radiusKm: number }
  hotspots?: Array<{ center_lat: number; center_lng: number; radius_km: number; demand: number; shortage: number }>
  center: [number, number]
  zoom: number
  fitTrigger: number
  staticCamera?: boolean
}) {
  const map = useMap()

  // Always-current fit function — updated each render, called via ref to avoid stale closures
  const fitRef = useRef<() => void>(() => {})
  fitRef.current = () => {
    // ── Phase 0: AI Hotspots — zoom to show circles fully ───────────────────────────────────
    if (!staticCamera && hotspots && hotspots.length > 0) {
      const valid = hotspots.filter(h => h.center_lat && h.center_lng)
      if (valid.length > 0) {
        // Start from first hotspot and extend by each circle's actual radius in degrees
        const first = valid[0]
        const firstRad = (first.radius_km * 1.6) / 111.0
        const bounds = L.latLngBounds(
          [first.center_lat - firstRad, first.center_lng - firstRad],
          [first.center_lat + firstRad, first.center_lng + firstRad],
        )
        valid.slice(1).forEach(h => {
          const rad = (h.radius_km * 1.6) / 111.0
          bounds.extend([h.center_lat - rad, h.center_lng - rad])
          bounds.extend([h.center_lat + rad, h.center_lng + rad])
        })
        map.fitBounds(bounds, { padding: [30, 30], animate: true, duration: 0.8, maxZoom: 15 })
        return
      }
    }
    // ── Phase 1: Searching — fit the search circle ──────────────────────────
    if (!staticCamera && searchCircle) {
      const { lat, lng, radiusKm } = searchCircle
      const latDeg = (radiusKm / 111) * 1.5
      const lngDeg = (radiusKm / (111 * Math.cos(lat * Math.PI / 180))) * 1.5
      const bounds = L.latLngBounds(
        [lat - latDeg, lng - lngDeg],
        [lat + latDeg, lng + lngDeg],
      )
      map.fitBounds(bounds, { padding: [16, 16], animate: true, duration: 0.7 })
      return
    }

    // ── Phase 2: Driver arriving — track animated driver + pickup ────────────
    // Each periodic call tightens bounds as driver approaches → natural zoom-in
    const arrivingTrip = !staticCamera && Object.values(trips).find(t => t.status === 'arriving')
    if (arrivingTrip && arrivingTrip.driverId) {
      const driverPos = animPos[arrivingTrip.driverId]
      if (driverPos) {
        const bounds = L.latLngBounds([
          driverPos,
          [arrivingTrip.pickupLat, arrivingTrip.pickupLng],
        ])
        if (bounds.isValid()) {
          map.fitBounds(bounds, { padding: [60, 60], maxZoom: 17, animate: true, duration: 0.8 })
          return
        }
      }
    }

    // ── Fallback: fit all visible points ─────────────────────────────────────
    const pts: [number, number][] = []
    if (riderLocation) pts.push([riderLocation.lat, riderLocation.lng])
    Object.values(drivers).forEach(d => pts.push(animPos[d.id] ?? [d.lat, d.lng]))
    Object.values(trips).forEach(t => {
      pts.push([t.pickupLat, t.pickupLng])
      pts.push([t.destLat,   t.destLng])
    })
    if (pts.length >= 2) {
      const bounds = L.latLngBounds(pts)
      if (bounds.isValid()) {
        map.fitBounds(bounds, { padding: staticCamera ? [25, 25] : [55, 55], maxZoom: 15, animate: true })
        return
      }
    }
    if (pts.length === 1) {
      map.flyTo(pts[0], 15, { animate: true, duration: 0.8 })
      return
    }
    map.flyTo(center, zoom, { animate: true, duration: 0.8 })
  }

  // Re-fit on explicit status transitions (fitTrigger bump from parent)
  const prevTrigger = useRef(fitTrigger)
  useEffect(() => {
    if (fitTrigger !== prevTrigger.current) {
      prevTrigger.current = fitTrigger
      fitRef.current()
    }
  }, [fitTrigger])

  // Re-fit when new drivers/trips appear (initial data load)
  const fitKey = `${Object.keys(drivers).length}|${Object.keys(trips).sort().join(',')}`
  const prevFitKey = useRef('')
  useEffect(() => {
    if (fitKey !== prevFitKey.current && fitKey !== '0|') {
      prevFitKey.current = fitKey
      const t = setTimeout(() => fitRef.current(), 150)
      return () => clearTimeout(t)
    }
  }, [fitKey])

  // Live tracking: re-fit every 2s during searching + arriving phases so zoom evolves naturally
  useEffect(() => {
    const isLive = !staticCamera && (!!searchCircle || Object.values(trips).some(t => t.status === 'arriving'))
    if (!isLive) return
    const id = setInterval(() => fitRef.current(), 2000)
    return () => clearInterval(id)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchCircle, Object.values(trips).map(t => t.status).join(',')])

  return null
}

// Renders OSRM road-following routes for on_trip rides
function OsrmRouteLines({ trips }: { trips: Record<string, MapTrip> }) {
  const [routes, setRoutes] = useState<Record<string, [number, number][]>>({})

  useEffect(() => {
    Object.entries(trips).forEach(([id, t]) => {
      if (t.status !== 'on_trip') return
      fetchRoute(t.pickupLat, t.pickupLng, t.destLat, t.destLng).then(coords => {
        setRoutes(prev => (prev[id] ? prev : { ...prev, [id]: coords }))
      })
    })
    setRoutes(prev => {
      let changed = false
      const next: Record<string, [number, number][]> = {}
      Object.keys(prev).forEach(id => { if (trips[id]) next[id] = prev[id]; else changed = true })
      return changed ? next : prev
    })
  }, [trips])

  return (
    <>
      {Object.entries(routes).map(([id, coords]) => (
        <Polyline
          key={`osrm-${id}`}
          positions={coords}
          pathOptions={{ color: '#2563eb', weight: 3.5, opacity: 0.82 }}
        />
      ))}
    </>
  )
}

// ── Main component ────────────────────────────────────────────────────────

export function DispatchMap({
  drivers, trips, animEvents,
  center, zoom, focusTrigger = 0, fitTrigger = 0,
  showNumbers = false,
  uberStyle = false,
  showTooltips = true,
  searchCircle,
  hotspots,
  activeHotspotIdx,
  riderLocation,
  legend,
  onAnimComplete,
  cancelAnimKeys,
  staticCamera = false,
}: Props) {
  const animRef              = useRef<Map<string, AnimEntry>>(new Map())
  const [animPos, setAnimPos] = useState<Record<string, [number, number]>>({})
  const processedKeysRef     = useRef<Set<string>>(new Set())
  const prevDriverStatusRef  = useRef<Record<string, string>>({})
  const onAnimCompleteRef    = useRef(onAnimComplete)
  const [arrivingRoutes, setArrivingRoutes] = useState<Record<string, [number, number][]>>({})

  // Keep callback ref current so the setInterval closure never goes stale
  useEffect(() => { onAnimCompleteRef.current = onAnimComplete }, [onAnimComplete])

  // Theme-aware tile: CartoDB Positron (light) / Dark Matter (dark) in uber mode
  const [isDark, setIsDark] = useState(
    () => document.documentElement.getAttribute('data-theme') === 'dark'
  )
  useEffect(() => {
    const el  = document.documentElement
    const obs = new MutationObserver(() => setIsDark(el.getAttribute('data-theme') === 'dark'))
    obs.observe(el, { attributes: true, attributeFilter: ['data-theme'] })
    return () => obs.disconnect()
  }, [])

  const tileUrl = uberStyle
    ? (isDark
        ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
        : 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png')
    : 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png'

  // Register new animation events (each key once), precompute path lengths
  useEffect(() => {
    animEvents.forEach(ev => {
      if (processedKeysRef.current.has(ev.key)) return
      processedKeysRef.current.add(ev.key)
      const entry: AnimEntry = { ...ev, startTs: Date.now() }
      if (ev.path && ev.path.length > 1) {
        const { cumLens, totalLen } = buildCumLens(ev.path)
        entry.cumLens  = cumLens
        entry.totalLen = totalLen
      }
      animRef.current.set(ev.key, entry)
      // Store arriving OSRM path so we can draw the road polyline
      if (ev.phase === 'arriving' && ev.rideId && ev.path && ev.path.length > 1) {
        setArrivingRoutes(prev => ({ ...prev, [ev.rideId!]: ev.path! }))
      }
    })
  }, [animEvents])

  // Clear animated position when driver returns to available
  useEffect(() => {
    Object.values(drivers).forEach(driver => {
      const prev = prevDriverStatusRef.current[driver.id]
      if (prev && prev !== 'available' && driver.status === 'available') {
        setAnimPos(p => { const n = { ...p }; delete n[driver.id]; return n })
      }
      prevDriverStatusRef.current[driver.id] = driver.status
    })
  }, [drivers])

  // Cancel specific animations immediately (e.g. trip completed mid-animation)
  useEffect(() => {
    if (!cancelAnimKeys?.length) return
    cancelAnimKeys.forEach(key => animRef.current.delete(key))
  }, [cancelAnimKeys])

  // Clean up arriving routes when trips are no longer in arriving state
  useEffect(() => {
    setArrivingRoutes(prev => {
      const arrivingIds = new Set(
        Object.values(trips).filter(t => t.status === 'arriving').map(t => t.rideId)
      )
      let changed = false
      const next: Record<string, [number, number][]> = {}
      Object.entries(prev).forEach(([id, route]) => {
        if (arrivingIds.has(id)) { next[id] = route } else { changed = true }
      })
      return changed ? next : prev
    })
  }, [trips])

  // Animation loop — 80 ms ticks, smoothstep easing + path following
  useEffect(() => {
    const id = setInterval(() => {
      if (animRef.current.size === 0) return
      const now   = Date.now()
      const patch: Record<string, [number, number]> = {}
      animRef.current.forEach((anim, key) => {
        const raw  = (now - anim.startTs) / anim.durationMs
        const t    = Math.min(raw, 1)
        const ease = t * t * (3 - 2 * t)
        patch[anim.driverId] = posOnEntry(anim, ease)
        if (t >= 1) {
          animRef.current.delete(key)
          onAnimCompleteRef.current?.(key)
        }
      })
      if (Object.keys(patch).length > 0) setAnimPos(prev => ({ ...prev, ...patch }))
    }, 80)
    return () => clearInterval(id)
  }, [])

  const driverList = Object.values(drivers)
  const tripList   = Object.values(trips)

  // Stable sorted index for number labels
  const driverNumMap: Record<string, number> = {}
  if (showNumbers) {
    Object.keys(drivers).sort().forEach((id, i) => { driverNumMap[id] = i + 1 })
  }

  // All visible points for the focus-all button: rider position + animated drivers + trip pins
  const focusPoints = (riderLocation ? [[riderLocation.lat, riderLocation.lng] as [number, number]] : [])
    .concat(Object.values(drivers).map(d => (animPos[d.id] ?? [d.lat, d.lng]) as [number, number]))
    .concat(
      Object.values(trips).flatMap(t => [
        [t.pickupLat, t.pickupLng] as [number, number],
        [t.destLat,   t.destLng]   as [number, number],
      ])
    )

  // Theme-aware legend colours
  const legendBg     = isDark ? 'rgba(18,18,18,0.9)'          : 'rgba(255,255,255,0.93)'
  const legendBorder = isDark ? 'rgba(255,255,255,0.1)'        : 'rgba(0,0,0,0.13)'
  const legendText   = isDark ? '#e0e0e0'                      : '#1a1a1a'

  return (
    <div style={{ position: 'relative', height: '100%', width: '100%' }}>

    {/* ── Theme-aware legend overlay — top-left ── */}
    {legend && legend.length > 0 && (
      <div style={{
        position: 'absolute', top: 10, left: 10, zIndex: 1000,
        background: legendBg,
        border: `1px solid ${legendBorder}`,
        borderRadius: 8,
        padding: '7px 11px',
        display: 'flex', flexDirection: 'column', gap: 6,
        backdropFilter: 'blur(6px)',
        pointerEvents: 'none',
        boxShadow: '0 2px 10px rgba(0,0,0,0.15)',
      }}>
        {legend.map((item, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {/* dot — plain filled circle */}
            {item.shape === 'dot' && (
              <span style={{
                width: 10, height: 10, borderRadius: '50%', flexShrink: 0,
                background: item.color, border: '1.5px solid rgba(255,255,255,0.75)',
                boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
              }} />
            )}
            {/* ring — filled circle + static outer ring */}
            {item.shape === 'ring' && (
              <span style={{ position: 'relative', width: 16, height: 16, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                <span style={{ position: 'absolute', inset: 0, borderRadius: '50%', border: `2px solid ${item.color}`, opacity: 0.45 }} />
                <span style={{ width: 10, height: 10, borderRadius: '50%', background: item.color, border: '1.5px solid rgba(255,255,255,0.8)', boxShadow: `0 0 6px ${item.color}55` }} />
              </span>
            )}
            {/* pin — teardrop shape matching the actual map pins */}
            {item.shape === 'pin' && (
              <svg width="10" height="13" viewBox="0 0 22 28" style={{ flexShrink: 0 }}>
                <path d="M11 0C4.93 0 0 4.93 0 11 0 19.3 11 28 11 28S22 19.3 22 11C22 4.93 17.07 0 11 0Z" fill={item.color}/>
                <circle cx="11" cy="11" r="6" fill="rgba(255,255,255,0.3)"/>
              </svg>
            )}
            <span style={{ fontSize: 11, fontWeight: 500, color: legendText, fontFamily: 'Inter, system-ui, sans-serif', whiteSpace: 'nowrap' }}>
              {item.label}
            </span>
          </div>
        ))}
      </div>
    )}

    <MapContainer center={center} zoom={zoom} style={{ height: '100%', width: '100%' }} zoomControl={false}>
      <TileLayer
        url={tileUrl}
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
        subdomains="abcd"
        maxZoom={19}
      />
      <ZoomControl position={uberStyle ? 'bottomright' : 'topleft'} />

      <FitAllPoints points={focusPoints} center={center} zoom={zoom} trigger={focusTrigger} />
      <FlyToHotspot hotspots={hotspots} activeIdx={activeHotspotIdx} />
      <SmartCamera
        drivers={drivers} trips={trips} animPos={animPos}
        riderLocation={riderLocation} searchCircle={searchCircle} hotspots={hotspots}
        center={center} zoom={zoom} fitTrigger={fitTrigger}
        staticCamera={staticCamera}
      />

      {/* ── Rider "You" — yellow pulsing circle, largest marker ── */}
      {riderLocation && (
        <Marker position={[riderLocation.lat, riderLocation.lng]} icon={_riderIcon}>
          {showTooltips && (
            <Tooltip permanent={uberStyle} direction="top" offset={[0, -20]} className={uberStyle ? 'uber-tip' : ''}>
              <span style={{ fontSize: 12, fontWeight: 600 }}>{riderLocation.label ?? 'You'}</span>
            </Tooltip>
          )}
        </Marker>
      )}

      {/* ── Drivers — colored circle, glow rings only for driver's own marker ── */}
      {driverList.map(driver => {
        const pos  = animPos[driver.id] ?? ([driver.lat, driver.lng] as [number, number])
        const icon = getDriverIcon(driver.status, driver.glowing, showNumbers ? driverNumMap[driver.id] : undefined, driver.reposition)
        return <Marker key={driver.id} position={pos} icon={icon} />
      })}

      {/* ── Pickup markers — omitted when riderLocation covers the source ── */}
      {tripList
        .filter(trip => !riderLocation || trip.pickupLabel != null)
        .map(trip => (
          <Marker
            key={`pk-${trip.rideId}`}
            position={[trip.pickupLat, trip.pickupLng]}
            icon={trip.status === 'searching' ? _pickupSearching : _pickupMatched}
          >
            {showTooltips && uberStyle && trip.pickupLabel && (
              <Tooltip permanent direction="top" offset={[0, -30]} className="uber-tip uber-tip-green">
                {trip.pickupLabel}
              </Tooltip>
            )}
          </Marker>
        ))}

      {/* ── Destination markers ── */}
      {tripList
        .filter(t => uberStyle ? t.status !== 'searching' : (t.status === 'arriving' || t.status === 'on_trip'))
        .map(trip => (
          <Marker key={`dest-${trip.rideId}`} position={[trip.destLat, trip.destLng]} icon={_destIcon}>
            {showTooltips && uberStyle && trip.destLabel && (
              <Tooltip permanent direction="top" offset={[0, -30]} className="uber-tip uber-tip-red">
                {trip.destLabel}
              </Tooltip>
            )}
          </Marker>
        ))}

      {/* ── Driver → Pickup OSRM road route (arriving) — solid orange ── */}
      {tripList
        .filter(t => t.status === 'arriving')
        .map(trip => {
          const route = arrivingRoutes[trip.rideId]
          if (!route) return null
          return (
            <Polyline
              key={`arr-route-${trip.rideId}`}
              positions={route}
              pathOptions={{ color: '#ea580c', weight: 3.5, opacity: 0.82 }}
            />
          )
        })}

      {/* ── Faint route preview pickup→dest while arriving ── */}
      {tripList
        .filter(t => t.status === 'arriving')
        .map(trip => (
          <Polyline
            key={`prev-${trip.rideId}`}
            positions={[[trip.pickupLat, trip.pickupLng], [trip.destLat, trip.destLng]]}
            pathOptions={{ color: '#94a3b8', weight: 1.5, dashArray: '4 7', opacity: 0.35 }}
          />
        ))}

      {/* ── OSRM road-following blue routes for on_trip rides ── */}
      <OsrmRouteLines trips={trips} />

      {/* ── Search radius circles (rider searching for driver) ── */}
      {searchCircle && (
        <>
          <Circle
            center={[searchCircle.lat, searchCircle.lng]}
            radius={searchCircle.radiusKm * 1000}
            pathOptions={{ color: '#d97706', fillColor: '#d97706', fillOpacity: 0.06, weight: 2.5, opacity: 0.7, dashArray: '8 5', className: 'search-radius-outer' }}
          />
          <Circle
            center={[searchCircle.lat, searchCircle.lng]}
            radius={searchCircle.radiusKm * 600}
            pathOptions={{ color: '#d97706', fillColor: '#d97706', fillOpacity: 0.04, weight: 1.5, opacity: 0.4, className: 'search-radius-inner' }}
          />
        </>
      )}

      {/* ── AI Hotspot circles — active zone glows, others dim ── */}
      {hotspots && hotspots.map((hotspot, idx) => {
        if (!hotspot.center_lat || !hotspot.center_lng) return null
        const isActive = activeHotspotIdx === undefined || idx === activeHotspotIdx
        return (
          <React.Fragment key={`hotspot-${idx}`}>
            {isActive && (
              <Circle
                center={[hotspot.center_lat, hotspot.center_lng]}
                radius={hotspot.radius_km * 1000 * 1.35}
                pathOptions={{ color: '#dc2626', fillColor: '#dc2626', fillOpacity: 0.05, weight: 1, opacity: 0.35, className: 'hotspot-glow-outer' }}
              />
            )}
            <Circle
              center={[hotspot.center_lat, hotspot.center_lng]}
              radius={hotspot.radius_km * 1000}
              pathOptions={{
                color: '#dc2626', fillColor: '#dc2626',
                fillOpacity: isActive ? 0.18 : 0.04,
                weight: isActive ? 2.5 : 1,
                opacity: isActive ? 0.85 : 0.25,
                className: isActive ? 'hotspot-glow' : '',
              }}
            />
            <Marker
              position={[hotspot.center_lat, hotspot.center_lng]}
              icon={L.divIcon({
                html: `<div style="background: rgba(185,28,28,${isActive ? '0.88' : '0.35'}); color: #fff; padding: 3px 9px; border-radius: 4px; font-size: 10px; font-weight: 600; white-space: nowrap; letter-spacing: 0.3px; box-shadow: 0 1px 4px rgba(0,0,0,0.25); opacity: ${isActive ? 1 : 0.4}">Hotspot Zone ${idx + 1}</div>`,
                className: '',
                iconSize: [120, 24],
                iconAnchor: [60, 38],
              })}
            />
          </React.Fragment>
        )
      })}
    </MapContainer>
    </div>
  )
}
