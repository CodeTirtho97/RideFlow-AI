import axios from 'axios'

const envApiBase = import.meta.env.VITE_API_BASE_URL?.trim()
const apiBase = envApiBase ? envApiBase.replace(/\/+$/, '') : ''

const http = axios.create({ baseURL: apiBase ? `${apiBase}/api/v1` : '/api/v1' })
const demoHttp = axios.create({ baseURL: apiBase ? `${apiBase}/api/demo` : '/api/demo' })

// ── Drivers ──────────────────────────────────────────────────────────────

export interface DriverInfo {
  id: string
  name: string
  phone: string
  status: 'available' | 'busy' | 'offline'
  active_ride_id: string | null
  location_fresh: boolean
}

export interface AvailableDriver {
  id: string
  name: string
  lat: number
  lng: number
}

export const getAvailableDrivers = () =>
  http.get<AvailableDriver[]>('/drivers')

export const seedDrivers = (nearLat?: number, nearLng?: number) =>
  http.post<{ seeded: number; drivers: AvailableDriver[] }>('/drivers/seed', {
    near_lat: nearLat ?? null,
    near_lng: nearLng ?? null,
  })

export const registerDriver = (name: string, phone: string) =>
  http.post<{ id: string; name: string; status: string }>('/drivers', { name, phone })

export const getDriver = (driverId: string) =>
  http.get<DriverInfo>(`/drivers/${driverId}`)

export const updateDriverLocation = (driverId: string, lat: number, lng: number) =>
  http.patch(`/drivers/${driverId}/location`, { lat, lng })

export const setDriverStatus = (driverId: string, status: 'available' | 'offline') =>
  http.patch(`/drivers/${driverId}/status`, { status })

// ── Rides ─────────────────────────────────────────────────────────────────

export interface RideReceipt {
  driver_id: string | null
  driver_name: string | null
  pickup_lat: number
  pickup_lng: number
  dest_lat: number
  dest_lng: number
  distance_km: number
  duration_seconds: number
  duration_display_min: number
  base_fare: number
  distance_charge: number
  time_charge: number
  surge_multiplier: number
  fare_estimate: number
}

export interface RideInfo {
  id: string
  rider_id: string
  driver_id: string | null
  driver_name: string | null
  status: string
  surge_multiplier: number
  fare_estimate: number | null
  created_at: string
  updated_at: string | null
  pickup_lat: number | null
  pickup_lng: number | null
  dest_lat: number | null
  dest_lng: number | null
}

export const createRide = (
  rider_id: string,
  pickup_lat: number,
  pickup_lng: number,
  destination_lat: number,
  destination_lng: number,
) =>
  http.post<{ id: string; status: string; surge_multiplier: number }>('/rides', {
    rider_id,
    pickup_lat,
    pickup_lng,
    destination_lat,
    destination_lng,
  })

export const getRide = (rideId: string) =>
  http.get<RideInfo>(`/rides/${rideId}`)

export const cancelRide = (rideId: string) =>
  http.patch(`/rides/${rideId}/cancel`)

export const driverArriving = (rideId: string) =>
  http.patch(`/rides/${rideId}/arrive`)

export const startTrip = (rideId: string) =>
  http.patch(`/rides/${rideId}/start`)

export const completeTrip = (rideId: string) =>
  http.patch<{ id: string; status: string; receipt: RideReceipt }>(`/rides/${rideId}/complete`)

// ── Demo Simulation ───────────────────────────────────────────────────────

export interface DriverSummary {
  id: string
  name: string
  phone: string
  lat: number
  lng: number
  status: string
}

export interface RideSummary {
  id: string
  rider_id: string
  rider_name: string
  pickup_lat: number
  pickup_lng: number
  dest_lat: number
  dest_lng: number
  surge_multiplier: number
}

export interface PresetMeta {
  label: string
  description: string
  what_it_shows: string
  supply_demand: string
  radius_km: number
  driver_count: number
  request_count: number
}

export const getPresets = () =>
  demoHttp.get<Record<string, PresetMeta>>('/presets')

export const demoSeed = (preset: string) =>
  demoHttp.post<{
    seeded: number
    label: string
    zone: string
    drivers: DriverSummary[]
    message: string
  }>('/seed', { preset })

export const demoMove = () =>
  demoHttp.post<{ message: string; detail?: string }>('/move')

export const demoRequests = (preset: string) =>
  demoHttp.post<{
    created: number
    message: string
    rides: RideSummary[]
  }>('/requests', { preset })

export const demoAiRun = () =>
  demoHttp.post<{ status: string; message: string }>('/ai/run')

export const demoReset = () =>
  demoHttp.post<{ status: string; message: string }>('/reset')

// ── Metrics ───────────────────────────────────────────────────────────────

export interface SystemMetrics {
  drivers: { available: number; busy: number; offline: number; total: number }
  rides: { active: number; completed: number; cancelled: number; total: number }
  by_status: Record<string, number>
}

export const getMetrics = () =>
  http.get<SystemMetrics>('/metrics')
