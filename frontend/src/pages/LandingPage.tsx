import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { AppNav } from '../components/AppNav'

const FEATURES = [
  {
    icon: '📍',
    bg: '#dbeafe',
    title: 'Geospatial Dispatch',
    plain: 'Finds the nearest available driver using real GPS coordinates and map geometry — not just straight-line distance.',
    tech: 'PostGIS ST_DWithin + GiST spatial index',
  },
  {
    icon: '🔒',
    bg: '#dcfce7',
    title: 'Race Condition Prevention',
    plain: 'Two workers can never assign the same driver to two different riders at the same time — even under peak load.',
    tech: 'SELECT FOR UPDATE SKIP LOCKED',
  },
  {
    icon: '⚡',
    bg: '#fef3c7',
    title: 'Real-time Updates',
    plain: 'Both the rider and driver see every status change the instant it happens — no page refresh, no polling.',
    tech: 'WebSocket + Redis Pub/Sub fanout',
  },
  {
    icon: '⚙️',
    bg: '#ede9fe',
    title: 'Async Processing',
    plain: 'Ride requests are processed in the background so the API stays fast and responsive under high load.',
    tech: 'Celery + Redis message broker',
  },
  {
    icon: '📡',
    bg: '#fee2e2',
    title: 'Location Tracking',
    plain: "Driver locations are cached for speed and expire automatically if a driver stops sending heartbeats.",
    tech: 'Redis HASH (30s TTL) + PostgreSQL PostGIS',
  },
  {
    icon: '💰',
    bg: '#fef3c7',
    title: 'Surge Pricing',
    plain: 'When more riders are requesting than drivers are available in an area, fares adjust automatically.',
    tech: 'Demand/supply ratio per geohash zone',
  },
]

export default function LandingPage() {
  useEffect(() => { document.title = 'RideFlow AI — Live Dispatch System' }, [])

  return (
    <div className="app-shell">
      <header className="topbar">
        <span className="topbar-logo">RideFlow AI</span>
        <AppNav />
      </header>

      {/* ── Hero ── */}
      <div className="landing-hero">
        <p className="hero-eyebrow">System Design Portfolio Project</p>
        <h1 className="hero-title">RideFlow AI</h1>
        <p className="hero-sub">
          A production-grade ride dispatch system built from scratch —
          demonstrating the backend engineering behind apps like Uber and Ola.
        </p>
        <div className="hero-actions">
          <Link to="/playground" className="btn-hero-primary">Try the Playground →</Link>
          <Link to="/architecture" className="btn-hero-ghost">View Architecture</Link>
        </div>
        <div className="hero-tech-stack">
          {['FastAPI', 'PostgreSQL + PostGIS', 'Redis', 'Celery', 'WebSocket', 'React + TypeScript'].map(t => (
            <span key={t} className="tech-chip">{t}</span>
          ))}
        </div>
      </div>

      {/* ── How It Works ── */}
      <div style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
        <div className="landing-section" style={{ paddingTop: 52, paddingBottom: 52 }}>
          <h2 className="section-title">How a Ride Works</h2>
          <p className="section-desc">The full lifecycle — from booking to drop-off — in three steps.</p>
          <div className="how-grid">
            <div className="how-card">
              <div className="how-num">1</div>
              <div className="how-title">Rider Books a Trip</div>
              <div className="how-desc">
                A rider enters pickup and drop-off coordinates. The API creates a ride record and immediately
                hands off a dispatch job to background workers.
              </div>
              <div className="how-tech">POST /api/v1/rides → Celery task queued in Redis</div>
            </div>
            <div className="how-card">
              <div className="how-num">2</div>
              <div className="how-title">System Finds the Nearest Driver</div>
              <div className="how-desc">
                A Celery worker queries the database using real map geometry to find the closest available driver
                within 3 km. If none, it expands to 5 km. The driver is locked instantly to prevent double-booking.
              </div>
              <div className="how-tech">PostGIS ST_DWithin + SELECT FOR UPDATE SKIP LOCKED</div>
            </div>
            <div className="how-card">
              <div className="how-num">3</div>
              <div className="how-title">Both Sides Update in Real Time</div>
              <div className="how-desc">
                The moment a driver is assigned, both apps update instantly — no polling.
                The backend publishes to Redis channels; WebSocket connections push the update to both clients.
              </div>
              <div className="how-tech">Redis Pub/Sub → WebSocket push → rider + driver</div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Explore Dashboards ── */}
      <div className="landing-section" style={{ paddingTop: 52, paddingBottom: 52 }}>
        <h2 className="section-title">Explore the System</h2>
        <p className="section-desc">
          Start with the Playground to see everything at once, or open individual dashboards
          to explore each perspective.
        </p>

        {/* Featured: Playground */}
        <Link to="/playground" className="playground-feature-card">
          <div>
            <span style={{ fontSize: 32, display: 'block', marginBottom: 12 }}>🎮</span>
            <div style={{ fontSize: 20, fontWeight: 700, color: 'white', marginBottom: 8 }}>
              Playground — Start Here
            </div>
            <div style={{ fontSize: 14, color: 'rgba(255,255,255,0.75)', lineHeight: 1.6, maxWidth: 480 }}>
              Seed a city with drivers, fire multiple ride requests at once, and watch the dispatch
              engine handle them in parallel. Choose Light, Moderate, or Dense traffic scenarios.
            </div>
          </div>
          <span className="playground-feature-cta">Open Playground →</span>
        </Link>

        {/* 3 Dashboards */}
        <div className="dash-grid" style={{ marginTop: 16 }}>
          <Link to="/rider" className="dash-card">
            <span className="dash-card-icon">🧍</span>
            <div className="dash-card-title">Rider Dashboard</div>
            <div className="dash-card-desc">
              Book a ride and watch every step — driver search, assignment, arrival, and trip — with a
              plain-English explanation of what the system is doing at each moment.
            </div>
            <div className="dash-card-link">Open Rider View →</div>
          </Link>
          <Link to="/driver" className="dash-card">
            <span className="dash-card-icon">🚗</span>
            <div className="dash-card-title">Driver Dashboard</div>
            <div className="dash-card-desc">
              Register as a driver, set your location, go online, and receive a ride over WebSocket.
              Tap through Arriving → Trip Started → Completed to see the rider's view update live.
            </div>
            <div className="dash-card-link">Open Driver View →</div>
          </Link>
          <Link to="/admin" className="dash-card">
            <span className="dash-card-icon">📊</span>
            <div className="dash-card-title">Admin Dashboard</div>
            <div className="dash-card-desc">
              A live ops view — active rides, driver pool status, surge zones, and AI demand alerts —
              all streaming from the same backend in real time.
            </div>
            <div className="dash-card-link">Open Admin View →</div>
          </Link>
        </div>
      </div>

      {/* ── Engineering Highlights ── */}
      <div style={{ background: 'var(--surface)', borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)' }}>
        <div className="landing-section" style={{ paddingTop: 52, paddingBottom: 52 }}>
          <h2 className="section-title">Engineering Highlights</h2>
          <p className="section-desc">
            Six real-world backend patterns — each built, wired, and demonstrated end-to-end.
          </p>
          <div className="feature-grid">
            {FEATURES.map(f => (
              <div key={f.title} className="feature-card">
                <div className="feature-icon" style={{ background: f.bg }}>{f.icon}</div>
                <div className="feature-title">{f.title}</div>
                <div className="feature-plain">{f.plain}</div>
                <div className="feature-tech">{f.tech}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Architecture CTA ── */}
      <div className="landing-section" style={{ paddingTop: 40, paddingBottom: 52 }}>
        <div className="arch-banner">
          <div className="arch-banner-text">
            <div className="arch-banner-title">Want the full system design breakdown?</div>
            <div className="arch-banner-sub">
              Diagrams, dispatch flow, state machines, and tech stack comparisons with Uber, Ola, and Lyft.
            </div>
          </div>
          <Link to="/architecture" className="btn-hero-primary" style={{ flexShrink: 0 }}>
            View Architecture →
          </Link>
        </div>
      </div>

      <div style={{ borderTop: '1px solid var(--border)', padding: '20px 24px', textAlign: 'center', background: 'var(--surface)' }}>
        <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          RideFlow AI — Built with FastAPI · PostgreSQL + PostGIS · Redis · Celery · React · TypeScript
        </p>
      </div>
    </div>
  )
}
