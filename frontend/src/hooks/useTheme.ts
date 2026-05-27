type Theme = 'light' | 'dark'

function getStored(): Theme {
  try { return (localStorage.getItem('rideflow_theme') as Theme) ?? 'light' }
  catch { return 'light' }
}

// Apply on module load — prevents flash of wrong theme before React mounts
const _initial = getStored()
document.documentElement.setAttribute('data-theme', _initial)

import { useState } from 'react'

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(_initial)

  const toggle = () => {
    const next: Theme = theme === 'light' ? 'dark' : 'light'
    setTheme(next)
    document.documentElement.setAttribute('data-theme', next)
    localStorage.setItem('rideflow_theme', next)
  }

  return { theme, toggle }
}
