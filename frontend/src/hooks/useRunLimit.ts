import { useState, useEffect } from 'react'

const BROADCAST_KEY = 'rideflow_limit_broadcast'

export function useRunLimit(storageKey: string, limit: number) {
  const [runsUsed, setRunsUsed] = useState<number>(() =>
    parseInt(localStorage.getItem(storageKey) ?? '0', 10)
  )

  const [globalLimitReached, setGlobalLimitReached] = useState<boolean>(
    () => localStorage.getItem(BROADCAST_KEY) === '1'
  )

  const limitReached = runsUsed >= limit

  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === BROADCAST_KEY && e.newValue === '1') {
        setGlobalLimitReached(true)
      }
    }
    window.addEventListener('storage', handler)
    return () => window.removeEventListener('storage', handler)
  }, [])

  // Reads current value from localStorage so stale closures (e.g. useCallback([])) stay correct.
  const incrementRun = () => {
    const current = parseInt(localStorage.getItem(storageKey) ?? '0', 10)
    const next = current + 1
    localStorage.setItem(storageKey, String(next))
    setRunsUsed(next)
    if (next >= limit) {
      localStorage.setItem(BROADCAST_KEY, '1')
      setGlobalLimitReached(true)
    }
  }

  return { runsUsed, limit, limitReached, globalLimitReached, incrementRun }
}
