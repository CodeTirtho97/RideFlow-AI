import { useState, useEffect } from 'react'

const BROADCAST_KEY = 'rideflow_limit_broadcast'

export function useGlobalLimitListener() {
  const [reached, setReached] = useState<boolean>(
    () => localStorage.getItem(BROADCAST_KEY) === '1'
  )

  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === BROADCAST_KEY && e.newValue === '1') setReached(true)
    }
    window.addEventListener('storage', handler)
    return () => window.removeEventListener('storage', handler)
  }, [])

  return reached
}
