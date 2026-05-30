import { NavLink } from 'react-router-dom'
import { useTheme } from '../hooks/useTheme'
import { useGlobalLimitListener } from '../hooks/useGlobalLimitListener'

function SunIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="5"/>
      <line x1="12" y1="1"     x2="12" y2="3"/>
      <line x1="12" y1="21"    x2="12" y2="23"/>
      <line x1="4.22" y1="4.22"   x2="5.64" y2="5.64"/>
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
      <line x1="1"  y1="12"   x2="3"  y2="12"/>
      <line x1="21" y1="12"   x2="23" y2="12"/>
      <line x1="4.22" y1="19.78"  x2="5.64" y2="18.36"/>
      <line x1="18.36" y1="5.64"  x2="19.78" y2="4.22"/>
    </svg>
  )
}

function MoonIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
    </svg>
  )
}

function LockIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
      style={{ marginLeft: 4, opacity: 0.65, flexShrink: 0 }}>
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
      <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
    </svg>
  )
}

export function AppNav() {
  const { theme, toggle } = useTheme()
  const limitReached = useGlobalLimitListener()

  return (
    <nav className="topbar-nav">
      <NavLink to="/" end>Home</NavLink>
      <NavLink to="/playground">
        <span style={{ display: 'inline-flex', alignItems: 'center' }}>
          Playground{limitReached && <LockIcon />}
        </span>
      </NavLink>
      <NavLink to="/rider">
        <span style={{ display: 'inline-flex', alignItems: 'center' }}>
          Rider{limitReached && <LockIcon />}
        </span>
      </NavLink>
      <NavLink to="/driver">
        <span style={{ display: 'inline-flex', alignItems: 'center' }}>
          Driver{limitReached && <LockIcon />}
        </span>
      </NavLink>
      <NavLink to="/admin">Admin</NavLink>
      <NavLink to="/architecture">Architecture</NavLink>
      <button
        className="theme-toggle"
        onClick={toggle}
        title={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
      >
        {theme === 'light' ? <MoonIcon /> : <SunIcon />}
      </button>
    </nav>
  )
}
