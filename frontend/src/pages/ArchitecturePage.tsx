import { useState, useEffect } from 'react'
import { AppNav } from '../components/AppNav'
import { PageHeader } from '../components/PageHeader'
import { Layers } from 'lucide-react'

type Tab = 'overview' | 'dispatch' | 'realtime' | 'statemachine' | 'techstack'

const TABS: { key: Tab; label: string }[] = [
  { key: 'overview',     label: 'System Overview' },
  { key: 'dispatch',     label: 'Dispatch Flow' },
  { key: 'realtime',     label: 'Real-time Updates' },
  { key: 'statemachine', label: 'State Machine' },
  { key: 'techstack',    label: 'Tech Stack' },
]

const TECH_ROWS = [
  {
    component: 'Geospatial queries',
    used: 'PostgreSQL + PostGIS',
    realworld: 'Uber: H3 + custom indexing; Google Maps: PostGIS variant',
    why: 'PostGIS ST_DWithin with a GiST index runs in <2 ms at demo scale. Same concepts apply at Uber scale with sharding.',
  },
  {
    component: 'Async dispatch',
    used: 'Celery + Redis broker',
    realworld: 'Uber: Kafka + Go workers; Ola: RabbitMQ',
    why: 'Celery maps 1:1 to the same distributed queue patterns. Swap Redis for Kafka and the architecture is identical.',
  },
  {
    component: 'Location cache',
    used: 'Redis HASH with 30s TTL',
    realworld: 'Uber: in-memory + Cassandra; Lyft: Redis',
    why: 'TTL auto-expires stale drivers — no cleanup job. If heartbeats stop, the driver disappears from dispatch automatically.',
  },
  {
    component: 'Real-time push',
    used: 'WebSocket + Redis Pub/Sub',
    realworld: 'Ola, Lyft: MQTT; some use SSE',
    why: 'Pub/Sub decouples the API from WebSocket servers. Multiple backend pods can each publish; all WS connections receive it.',
  },
  {
    component: 'Race condition guard',
    used: 'SELECT FOR UPDATE SKIP LOCKED',
    realworld: 'Redis SETNX; optimistic locking + retry',
    why: 'Native to PostgreSQL — zero extra infrastructure. SKIP LOCKED means workers never block each other.',
  },
  {
    component: 'Background tasks',
    used: 'Celery + Celery Beat',
    realworld: "Uber: Cadence/Temporal; Airbnb: Airflow",
    why: 'Beat runs the 5-minute AI prediction schedule. Scales to complex multi-step workflows in production.',
  },
  {
    component: 'API framework',
    used: 'FastAPI + asyncio',
    realworld: 'Uber: gRPC (Go); Ola: Express.js',
    why: 'Async I/O means a single worker handles thousands of concurrent WebSocket connections without blocking.',
  },
  {
    component: 'Ride lifecycle',
    used: '7-state finite state machine',
    realworld: 'Every major ride-hailing app uses FSM for trip state',
    why: 'Explicit states prevent invalid transitions. Operators can reconstruct exactly what happened from the event log.',
  },
  {
    component: 'Demand prediction',
    used: 'DBSCAN clustering (Phase 5)',
    realworld: 'Uber: deep learning surge models; Ola: XGBoost',
    why: 'DBSCAN detects spatial demand clusters without needing labelled data — a good first-pass hotspot detector.',
  },
]

function DiagramBox({ children, color = '' }: { children: React.ReactNode; color?: string }) {
  return (
    <div className={`diag-box ${color}`}>{children}</div>
  )
}

function Arrow() {
  return <span className="diag-arrow">→</span>
}

function OverviewTab() {
  return (
    <div className="arch-section">
      <p className="arch-plain">
        RideFlow AI is a three-tier distributed system. Clients talk to a FastAPI server over REST and
        WebSocket. The API delegates heavy work to Celery workers through a Redis message queue.
        All persistent state lives in PostgreSQL with PostGIS. Redis also doubles as a fast
        location cache and the Pub/Sub backbone for real-time events.
      </p>

      <div className="diagram-wrap">
        <div className="diag-tier">
          <div className="diag-tier-label">Clients</div>
          <div className="diag-boxes">
            <DiagramBox>Rider App</DiagramBox>
            <DiagramBox>Driver App</DiagramBox>
            <DiagramBox>Admin Dashboard</DiagramBox>
          </div>
        </div>
        <div style={{ color: '#484f58', padding: '4px 0 4px 8px', fontSize: 13 }}>↕ REST + WebSocket (HTTP/WS)</div>
        <div className="diag-tier">
          <div className="diag-tier-label">API Layer</div>
          <div className="diag-boxes">
            <DiagramBox color="highlight">FastAPI (asyncio)</DiagramBox>
            <Arrow />
            <DiagramBox color="highlight">WebSocket handlers</DiagramBox>
          </div>
        </div>
        <div style={{ color: '#484f58', padding: '4px 0 4px 8px', fontSize: 13 }}>↕ Celery tasks / Redis Pub/Sub</div>
        <div className="diag-tier">
          <div className="diag-tier-label">Processing &amp; Cache</div>
          <div className="diag-boxes">
            <DiagramBox color="yellow">Celery Workers</DiagramBox>
            <Arrow />
            <DiagramBox color="yellow">Redis broker</DiagramBox>
            <Arrow />
            <DiagramBox color="yellow">Redis Pub/Sub + Location Cache</DiagramBox>
          </div>
        </div>
        <div style={{ color: '#484f58', padding: '4px 0 4px 8px', fontSize: 13 }}>↕ SQL queries + GiST spatial index</div>
        <div className="diag-tier" style={{ marginBottom: 0 }}>
          <div className="diag-tier-label">Persistent Storage</div>
          <div className="diag-boxes">
            <DiagramBox color="green">PostgreSQL + PostGIS  (drivers · rides · events · logs)</DiagramBox>
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginTop: 24 }}>
        {[
          { title: 'FastAPI', desc: 'Async REST + WebSocket endpoints. Depends injection for DB sessions.' },
          { title: 'Celery', desc: 'Processes ride dispatch tasks from the Redis queue. One task per ride request.' },
          { title: 'Redis', desc: 'Three roles: task broker, Pub/Sub backbone, and 30s TTL location store.' },
          { title: 'PostgreSQL', desc: 'Source of truth for all rides, drivers, events, and dispatch logs.' },
          { title: 'PostGIS', desc: 'Extension that adds spatial types and functions. Powers the nearest-driver query.' },
          { title: 'WebSocket', desc: 'Long-lived connections for Rider, Driver, and Admin. Kept alive via Redis Pub/Sub.' },
        ].map(c => (
          <div key={c.title} className="card" style={{ padding: 0 }}>
            <div className="card-header" style={{ paddingBottom: 10 }}>
              <span className="card-title">{c.title}</span>
            </div>
            <div className="card-body" style={{ paddingTop: 10 }}>
              <p className="text-muted" style={{ fontSize: 13, lineHeight: 1.6 }}>{c.desc}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function DispatchTab() {
  const steps = [
    {
      title: 'Rider submits a booking',
      plain: 'The Rider app sends pickup and destination coordinates to the backend.',
      tech: 'POST /api/v1/rides → creates Ride row (status: requested)',
    },
    {
      title: 'Dispatch task is queued',
      plain: "The API doesn't do the driver search itself — it hands the job to a background worker and responds immediately.",
      tech: 'dispatch_ride.delay(ride_id) → Celery task enqueued in Redis broker',
    },
    {
      title: 'Celery worker picks up the task',
      plain: 'One of potentially many workers claims the task from the queue.',
      tech: 'Worker dequeues from Redis; ride transitions to status: searching_driver',
    },
    {
      title: 'Nearest driver found via PostGIS',
      plain: 'The worker queries the database for the closest available driver within 3 km, using real map geometry.',
      tech: 'SELECT … FROM drivers WHERE ST_DWithin(location, pickup, 3000) AND status = \'available\' ORDER BY ST_Distance … LIMIT 1',
    },
    {
      title: 'Driver locked to prevent double-booking',
      plain: 'Once a candidate is found, the worker claims exclusive ownership of that driver row so no other worker can assign them simultaneously.',
      tech: 'SELECT … FOR UPDATE SKIP LOCKED — other workers skip this driver and move on',
    },
    {
      title: 'Ride and driver records updated',
      plain: 'The ride is marked as assigned; the driver is marked as busy with this specific ride.',
      tech: 'UPDATE rides SET status=\'driver_assigned\', driver_id=… — UPDATE drivers SET status=\'busy\', active_ride_id=…',
    },
    {
      title: 'Redis Pub/Sub publishes the event',
      plain: 'The worker broadcasts the assignment to two channels — one for the rider, one for the driver.',
      tech: 'PUBLISH dispatch:{ride_id} {"event":"driver_assigned"} — PUBLISH driver:{driver_id} {"event":"ride_assigned"}',
    },
    {
      title: 'WebSocket handlers push to clients',
      plain: 'The Pub/Sub listener forwards the message to the correct open WebSocket connections.',
      tech: 'pubsub_listener → asyncio.create_task(ws.send_json(…)) for each subscribed connection',
    },
    {
      title: 'Rider and Driver apps update instantly',
      plain: 'Both screens update at the same moment — no polling, no page refresh.',
      tech: 'onMessage callback in useWebSocket hook → React state update → re-render',
    },
  ]

  return (
    <div className="arch-section">
      <p className="arch-plain">
        When a rider books a trip, the system goes through nine steps — from the API call to
        the real-time update on both screens. Here's exactly what happens and why each step exists.
      </p>
      <div className="flow-steps">
        {steps.map((s, i) => (
          <div key={i} className="flow-step">
            <div className="flow-step-num">{i + 1}</div>
            <div className="flow-step-body">
              <div className="flow-step-title">{s.title}</div>
              <div className="flow-step-plain">{s.plain}</div>
              <div className="flow-step-tech">{s.tech}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function RealtimeTab() {
  return (
    <div className="arch-section">
      <p className="arch-plain">
        Every status change in the system — driver assigned, trip started, trip completed — reaches
        the right screens in under a second. This works through a chain of three layers:
        backend publishes to Redis, a listener forwards to WebSocket connections, and the React
        app updates on message receipt.
      </p>

      <div className="diagram-wrap">
        <div className="diag-tier">
          <div className="diag-tier-label">Publishers (who writes events)</div>
          <div className="diag-boxes">
            <DiagramBox color="yellow">Celery dispatch worker</DiagramBox>
            <DiagramBox color="yellow">FastAPI ride endpoints</DiagramBox>
          </div>
        </div>
        <div style={{ color: '#484f58', padding: '4px 0 4px 8px', fontSize: 13 }}>↓ redis.publish(channel, json)</div>
        <div className="diag-tier">
          <div className="diag-tier-label">Redis Pub/Sub Channels</div>
          <div className="diag-boxes">
            <DiagramBox>dispatch:{'{ride_id}'}</DiagramBox>
            <DiagramBox>driver:{'{driver_id}'}</DiagramBox>
            <DiagramBox color="purple">admin:metrics</DiagramBox>
            <DiagramBox color="purple">ai:alerts</DiagramBox>
          </div>
        </div>
        <div style={{ color: '#484f58', padding: '4px 0 4px 8px', fontSize: 13 }}>↓ asyncio pubsub_listener → per-connection task</div>
        <div className="diag-tier">
          <div className="diag-tier-label">WebSocket Consumers</div>
          <div className="diag-boxes">
            <DiagramBox color="highlight">/ws/ride/{'{ride_id}'}  (Rider)</DiagramBox>
            <DiagramBox color="highlight">/ws/driver/{'{driver_id}'}  (Driver)</DiagramBox>
            <DiagramBox color="highlight">/ws/admin  (Admin)</DiagramBox>
          </div>
        </div>
        <div style={{ color: '#484f58', padding: '4px 0 4px 8px', fontSize: 13 }}>↓ onMessage → React setState → re-render</div>
        <div className="diag-tier" style={{ marginBottom: 0 }}>
          <div className="diag-tier-label">Browser Clients</div>
          <div className="diag-boxes">
            <DiagramBox color="green">Rider Dashboard updates</DiagramBox>
            <DiagramBox color="green">Driver Dashboard updates</DiagramBox>
            <DiagramBox color="green">Admin metrics update</DiagramBox>
          </div>
        </div>
      </div>

      <div style={{ marginTop: 24, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div className="card">
          <div className="card-header"><span className="card-title">Why Redis Pub/Sub?</span></div>
          <div className="card-body">
            <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.7 }}>
              The Celery worker and the WebSocket handler run in different processes.
              Redis Pub/Sub is the message bus that connects them without tight coupling.
              If you add more backend pods, each pod subscribes to the same channels
              and all connected clients receive updates — horizontal scale for free.
            </p>
          </div>
        </div>
        <div className="card">
          <div className="card-header"><span className="card-title">Why WebSocket over polling?</span></div>
          <div className="card-body">
            <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.7 }}>
              A rider's app polling every second generates 60 HTTP requests per minute per rider.
              With 100,000 concurrent riders, that's 100M requests/min — just for status checks.
              WebSocket keeps one persistent connection open. The server pushes only when something
              actually changes — near-zero overhead per idle connection.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

function StateMachineTab() {
  const states = [
    { key: 'requested',       label: 'Requested',       color: 'initial',      who: 'Rider books via API' },
    { key: 'searching',       label: 'Searching',       color: '',             who: 'Celery task starts' },
    { key: 'driver_assigned', label: 'Driver Assigned', color: '',             who: 'Worker locks driver' },
    { key: 'driver_arriving', label: 'Arriving',        color: '',             who: 'Driver taps "I\'m Arriving"' },
    { key: 'on_trip',         label: 'On Trip',         color: '',             who: 'Driver taps "Start Trip"' },
    { key: 'completed',       label: 'Completed',       color: 'terminal-ok',  who: 'Driver taps "Complete"' },
  ]

  return (
    <div className="arch-section">
      <p className="arch-plain">
        Every ride exists in exactly one of seven states at any point in time.
        The state can only move forward (except to "Cancelled" which can happen from most states).
        This design makes the system auditable — you can always reconstruct what happened and when.
      </p>

      <div className="state-machine">
        {states.map((s, i) => (
          <>
            <div key={s.key} className={`state-node ${s.color}`}>{s.label}</div>
            {i < states.length - 1 && <span key={`arr-${i}`} className="state-arrow">→</span>}
          </>
        ))}
        <span className="state-arrow" style={{ marginLeft: 8 }}>or</span>
        <div className="state-node terminal-err" style={{ marginLeft: 8 }}>Cancelled</div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12, marginTop: 24 }}>
        {[
          { state: 'requested → searching_driver', trigger: 'Celery task queued and started', detail: 'The API hands off to the worker. No driver found yet.' },
          { state: 'searching_driver → driver_assigned', trigger: 'Worker finds and locks a driver', detail: 'SELECT FOR UPDATE SKIP LOCKED completes. Both records updated atomically.' },
          { state: 'driver_assigned → driver_arriving', trigger: 'Driver taps "I\'m Arriving"', detail: 'PATCH /rides/{id}/arrive — rider notified via WebSocket.' },
          { state: 'driver_arriving → on_trip', trigger: 'Driver taps "Start Trip"', detail: 'PATCH /rides/{id}/start — confirms rider pickup.' },
          { state: 'on_trip → completed', trigger: 'Driver taps "Complete Trip"', detail: 'PATCH /rides/{id}/complete — driver reset to available.' },
          { state: 'any → cancelled', trigger: 'Rider cancels, or no driver found after 5 km', detail: 'ride.status = cancelled. If dispatching, driver_id never set.' },
        ].map(t => (
          <div key={t.state} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: 14 }}>
            <div style={{ fontSize: 12, fontFamily: 'ui-monospace, monospace', color: 'var(--blue)', marginBottom: 6 }}>{t.state}</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>{t.trigger}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>{t.detail}</div>
          </div>
        ))}
      </div>

      <div className="surge-banner mt-12">
        Every state transition is logged to the <code style={{ fontFamily: 'ui-monospace, monospace' }}>ride_events</code> table
        as an append-only record. This means the full history of every ride is preserved and
        queryable — useful for debugging, auditing, and ML training data.
      </div>
    </div>
  )
}

function TechStackTab() {
  return (
    <div className="arch-section">
      <p className="arch-plain">
        Every technology choice maps to a real-world industry practice.
        The table below shows what we use, what major players use for the same problem,
        and why the approach is sound at scale.
      </p>
      <div style={{ overflowX: 'auto' }}>
        <table className="tech-table">
          <thead>
            <tr>
              <th>Component</th>
              <th>What We Use</th>
              <th>Real-World Equivalent</th>
              <th>Why This Approach</th>
            </tr>
          </thead>
          <tbody>
            {TECH_ROWS.map(r => (
              <tr key={r.component}>
                <td><span className="tech-component">{r.component}</span></td>
                <td><span className="tech-used">{r.used}</span></td>
                <td><span className="tech-realworld">{r.realworld}</span></td>
                <td><span className="tech-why">{r.why}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default function ArchitecturePage() {
  useEffect(() => { document.title = 'Architecture | RideFlow AI' }, [])
  const [tab, setTab] = useState<Tab>('overview')

  return (
    <div className="app-shell">
      <header className="topbar">
        <span className="topbar-logo">RideFlow AI</span>
        <AppNav />
      </header>

      <PageHeader
        icon={Layers}
        title="System Architecture"
        subtitle="How RideFlow AI is built — from tech stack decisions to the live dispatch pipeline"
        accent="var(--purple)"
        accentBg="var(--purple-light)"
        infoDescription="Five tabs, each covering a different layer: System Overview (3-tier diagram), Dispatch Flow (9 steps from request to assignment), Real-time Pipeline (WebSocket + Redis Pub/Sub), State Machine (7 ride states), and Tech Stack (why each tool was chosen). Every section pairs plain-English explanation with technical detail and real-world comparisons to Uber, Ola, and Lyft."
        infoTags={['5 deep-dive tabs', 'Plain English + technical', 'Uber / Ola / Lyft comparisons']}
      />

      <div style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)', padding: '16px 24px' }}>
        <div style={{ maxWidth: 1152, margin: '0 auto' }}>
          <div className="arch-tabs">
            {TABS.map(t => (
              <button
                key={t.key}
                className={`arch-tab ${tab === t.key ? 'active' : ''}`}
                onClick={() => setTab(t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 1152, margin: '0 auto', padding: '0 24px 48px' }}>
        {tab === 'overview'     && <OverviewTab />}
        {tab === 'dispatch'     && <DispatchTab />}
        {tab === 'realtime'     && <RealtimeTab />}
        {tab === 'statemachine' && <StateMachineTab />}
        {tab === 'techstack'    && <TechStackTab />}
      </div>
    </div>
  )
}
