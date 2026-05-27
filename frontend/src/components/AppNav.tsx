import { NavLink } from 'react-router-dom'
import { useTheme } from '../hooks/useTheme'

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

export function AppNav() {
  const { theme, toggle } = useTheme()
  return (
    <nav className="topbar-nav">
      <NavLink to="/" end>Home</NavLink>
      <NavLink to="/playground">Playground</NavLink>
      <NavLink to="/rider">Rider</NavLink>
      <NavLink to="/driver">Driver</NavLink>
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
