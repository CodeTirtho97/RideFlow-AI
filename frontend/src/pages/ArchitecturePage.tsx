import { useEffect, useState, type ReactNode } from 'react'
import { Layers } from 'lucide-react'
import { AppNav } from '../components/AppNav'
import { PageHeader } from '../components/PageHeader'

type ViewKey = 'blueprint' | 'rideflow' | 'realtime' | 'resilience' | 'stack'

const VIEW_TABS: { key: ViewKey; label: string }[] = [
  { key: 'blueprint', label: 'System Blueprint' },
  { key: 'rideflow', label: 'Ride Request Flow' },
  { key: 'realtime', label: 'Realtime Data Plane' },
  { key: 'resilience', label: 'Reliability & Scale' },
  { key: 'stack', label: 'Technology Decisions' },
]

const SNAPSHOT = [
  { label: 'Dispatch Trigger', value: '< 150ms', detail: 'API returns quickly while workers process matching.' },
  { label: 'Realtime Fanout', value: 'Sub-second', detail: 'Redis Pub/Sub → WebSocket push to every dashboard.' },
  { label: 'Concurrency Guard', value: 'DB row lock', detail: 'SKIP LOCKED prevents duplicate driver assignment.' },
  { label: 'AI Hotspot Loop', value: 'Every 8s', detail: 'DBSCAN re-runs on live unmatched rides; results stream via WebSocket.' },
]

const FLOW_STEPS = [
  {
    title: 'Request is accepted at the API edge',
    goal: 'Acknowledge rider action immediately and start orchestration.',
    operation: 'POST /api/v1/rides inserts a ride in requested state and enqueues dispatch_ride(ride_id).',
    guardrail: 'Synchronous work is minimal, so spikes in rider traffic do not block the request thread.',
  },
  {
    title: 'Worker claims the dispatch job',
    goal: 'Move matching logic away from the user-facing API process.',
    operation: 'Celery worker consumes from Redis broker and transitions ride to searching_driver.',
    guardrail: 'Queue-driven processing smooths burst traffic and protects API latency.',
  },
  {
    title: 'Nearest available driver is searched',
    goal: 'Find the best candidate quickly using spatial data.',
    operation: 'PostGIS query uses ST_DWithin + ST_Distance over indexed coordinates.',
    guardrail: 'Radius expansion strategy prevents starvation when local supply is low.',
  },
  {
    title: 'Driver row is locked for exclusive assignment',
    goal: 'Guarantee one driver can only be assigned once at a time.',
    operation: 'SELECT ... FOR UPDATE SKIP LOCKED claims the candidate row atomically.',
    guardrail: 'Competing workers skip locked rows instead of blocking or double-booking.',
  },
  {
    title: 'Ride and driver state commit together',
    goal: 'Persist a consistent source of truth for both entities.',
    operation: 'Ride status becomes driver_assigned; driver status becomes busy with active_ride_id.',
    guardrail: 'Single transaction avoids split-brain state across ride and driver tables.',
  },
  {
    title: 'Assignment event is published',
    goal: 'Decouple backend processing from websocket delivery.',
    operation: 'Worker publishes structured payloads to dispatch:{ride_id} and driver:{driver_id}.',
    guardrail: 'Publish-subscribe model allows multiple API instances to forward the same event stream.',
  },
  {
    title: 'WebSocket gateway fans out updates',
    goal: 'Deliver state changes to the right clients in realtime.',
    operation: 'Subscriber listener forwards payloads to rider, driver, and admin sockets.',
    guardrail: 'Connection registry isolates channels so only relevant sessions receive each event.',
  },
  {
    title: 'UI state transitions instantly',
    goal: 'Keep rider and driver views synchronized without polling.',
    operation: 'useWebSocket hook receives message and mutates React state per dashboard.',
    guardrail: 'Event-driven rendering removes repetitive HTTP status checks.',
  },
]

const TECH_DECISIONS = [
  {
    area: 'Geospatial matching',
    current: 'PostgreSQL + PostGIS (ST_DWithin, ST_Distance, GiST index)',
    scalePath: 'Partition by city and shard by geohash/H3 cell when traffic grows.',
    rationale: 'Strong correctness and query transparency for location-heavy search workloads.',
  },
  {
    area: 'Async orchestration',
    current: 'Celery workers with Redis broker',
    scalePath: 'Move to Kafka-backed pipelines for high-volume event replay and ordering controls.',
    rationale: 'Queue boundaries keep request path fast and isolate CPU-intensive dispatch logic.',
  },
  {
    area: 'Realtime delivery',
    current: 'Redis Pub/Sub + FastAPI WebSocket handlers',
    scalePath: 'Add dedicated gateway layer and channel partitioning per region.',
    rationale: 'Simple fanout model that is easy to reason about and horizontalize.',
  },
  {
    area: 'Driver liveness',
    current: 'Redis cache + TTL heartbeat expiry',
    scalePath: 'Dual-write to stream for recovery analytics and late heartbeat diagnostics.',
    rationale: 'Automatic expiry removes stale supply without custom cleanup schedulers.',
  },
  {
    area: 'Lifecycle governance',
    current: 'Finite state transitions with event log table',
    scalePath: 'Enforce transitions as policy modules and emit audit events to warehouse.',
    rationale: 'Explicit state model improves debugging, replayability, and compliance readiness.',
  },
  {
    area: 'Demand prediction',
    current: 'DBSCAN clustering on live ride request coordinates (scikit-learn)',
    scalePath: 'Feed time-of-day, weather, and event data into a supervised model for predictive (not reactive) surge.',
    rationale: 'DBSCAN requires no preset cluster count and handles irregular hotspot shapes — ideal when demand patterns are unknown in advance.',
  },
  {
    area: 'Driver repositioning',
    current: 'PostGIS ST_Distance ranked nearest idle drivers per hotspot centroid',
    scalePath: 'Optimize globally across all hotspots with a matching solver; account for driver acceptance rates.',
    rationale: 'Spatial proximity is the dominant signal for reposition latency. Simple, fast, and explainable.',
  },
]

const FAILURE_MODES = [
  {
    mode: 'No nearby drivers',
    detection: 'No eligible result in 3 km search window.',
    response: 'Expand search to 5 km and retry; otherwise mark as cancelled with reason.',
    impact: 'Rider receives deterministic failure event, never hangs in unknown state.',
  },
  {
    mode: 'Driver heartbeat drops',
    detection: 'Redis TTL expires for location/status key.',
    response: 'Driver is removed from available pool until heartbeats resume.',
    impact: 'Dispatch avoids routing to stale or disconnected drivers.',
  },
  {
    mode: 'Competing workers race for same driver',
    detection: 'Concurrent candidate scans overlap under burst load.',
    response: 'Row-level lock with SKIP LOCKED ensures only one winner.',
    impact: 'No duplicate assignment or manual reconciliation needed.',
  },
  {
    mode: 'Socket consumer reconnects',
    detection: 'WebSocket disconnect event from browser/app network change.',
    response: 'Client reconnects and re-subscribes; server resumes channel stream.',
    impact: 'Short-lived gaps recover automatically without page refresh.',
  },
  {
    mode: 'No demand clusters detected by AI',
    detection: 'DBSCAN finds fewer than min_samples (3) requests within eps (1.5 km).',
    response: 'Loop publishes no hotspot batch; UI shows "no clusters detected" empty state.',
    impact: 'Correct result — sparse demand genuinely has no actionable hotspot. Loop stops cleanly.',
  },
]

const ARCH_STYLES = `
.arch2-shell {
  max-width: 1180px;
  margin: 0 auto;
  padding: 28px 24px 56px;
}

.arch2-snapshot {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  margin-bottom: 20px;
}

.arch2-snapshot-card {
  border: 1px solid var(--border);
  border-radius: 12px;
  background: color-mix(in srgb, var(--surface) 83%, var(--blue-light) 17%);
  padding: 13px 14px;
  box-shadow: var(--shadow);
}

.arch2-snapshot-value {
  font-size: 18px;
  font-weight: 800;
  color: var(--text);
  letter-spacing: -0.25px;
  line-height: 1.1;
  margin-bottom: 5px;
}

.arch2-snapshot-label {
  font-size: 11px;
  font-weight: 700;
  color: var(--blue);
  text-transform: uppercase;
  letter-spacing: 0.45px;
  margin-bottom: 5px;
}

.arch2-snapshot-detail {
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.55;
}

.arch2-tabs-wrap {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 8px;
  margin-bottom: 20px;
  box-shadow: var(--shadow);
}

.arch2-tabs {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 6px;
}

.arch2-tab {
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-muted);
  border-radius: 8px;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.2px;
  padding: 10px 8px;
  cursor: pointer;
  font-family: inherit;
  transition: all 0.15s;
}

.arch2-tab:hover {
  color: var(--text);
  border-color: var(--border);
  background: color-mix(in srgb, var(--surface) 70%, var(--gray-light) 30%);
}

.arch2-tab.active {
  color: var(--text);
  background: color-mix(in srgb, var(--surface) 72%, var(--blue-light) 28%);
  border-color: color-mix(in srgb, var(--blue) 28%, var(--border) 72%);
  box-shadow: var(--shadow);
}

.arch2-panel {
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--surface);
  box-shadow: var(--shadow);
  overflow: hidden;
}

.arch2-panel-head {
  background: linear-gradient(180deg, color-mix(in srgb, var(--surface) 72%, var(--blue-light) 28%) 0%, var(--surface) 100%);
  border-bottom: 1px solid var(--border);
  padding: 17px 20px;
}

.arch2-eyebrow {
  font-size: 11px;
  color: var(--blue);
  font-weight: 700;
  letter-spacing: 0.45px;
  text-transform: uppercase;
  margin-bottom: 6px;
}

.arch2-panel-title {
  font-size: 23px;
  font-weight: 800;
  color: var(--text);
  letter-spacing: -0.4px;
  margin-bottom: 8px;
  line-height: 1.2;
}

.arch2-panel-summary {
  font-size: 14px;
  color: var(--text-muted);
  line-height: 1.65;
  max-width: 900px;
}

.arch2-panel-body {
  padding: 20px;
}

.arch2-grid-2 {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.arch2-grid-3 {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

.arch2-dark-board {
  border-radius: 12px;
  border: 1px solid #2d3340;
  background: #0f1522;
  padding: 16px;
}

.arch2-lane { margin-bottom: 11px; }
.arch2-lane:last-child { margin-bottom: 0; }

.arch2-lane-title {
  color: #8f9cb4;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.8px;
  text-transform: uppercase;
  margin-bottom: 6px;
}

.arch2-chip-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.arch2-chip {
  font-size: 11px;
  color: #d5deef;
  border: 1px solid #384457;
  border-radius: 999px;
  padding: 5px 9px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  background: #182031;
}

.arch2-chip-blue { border-color: #2f6feb; color: #8cb8ff; background: rgba(47, 111, 235, 0.18); }
.arch2-chip-green { border-color: #2ea043; color: #80e29f; background: rgba(46, 160, 67, 0.18); }
.arch2-chip-yellow { border-color: #c69026; color: #f4cb70; background: rgba(198, 144, 38, 0.18); }

.arch2-list {
  display: grid;
  gap: 9px;
}

.arch2-list-item {
  border: 1px solid var(--border);
  border-radius: 10px;
  background: color-mix(in srgb, var(--surface) 86%, var(--gray-light) 14%);
  padding: 10px 12px;
}

.arch2-list-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--text);
  margin-bottom: 4px;
}

.arch2-list-desc {
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.6;
}

.arch2-flow {
  display: grid;
  gap: 10px;
}

.arch2-flow-item {
  position: relative;
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 12px 12px 12px 56px;
  background: color-mix(in srgb, var(--surface) 84%, var(--gray-light) 16%);
}

.arch2-flow-index {
  position: absolute;
  left: 13px;
  top: 12px;
  width: 30px;
  height: 30px;
  border-radius: 999px;
  background: var(--blue);
  color: #fff;
  font-weight: 800;
  font-size: 13px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.arch2-flow-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--text);
  margin-bottom: 5px;
}

.arch2-line {
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-muted);
  margin-bottom: 4px;
}

.arch2-line strong { color: var(--text); }

.arch2-pipeline {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}

.arch2-pipe-col {
  border: 1px solid var(--border);
  border-radius: 10px;
  background: color-mix(in srgb, var(--surface) 90%, var(--gray-light) 10%);
  padding: 10px;
}

.arch2-pipe-title {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.45px;
  color: var(--blue);
  font-weight: 700;
  margin-bottom: 8px;
}

.arch2-pipe-node {
  font-size: 12px;
  color: var(--text);
  padding: 7px 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  margin-bottom: 7px;
}

.arch2-pipe-node:last-child { margin-bottom: 0; }

.arch2-code {
  border: 1px solid var(--border);
  border-radius: 10px;
  background: color-mix(in srgb, var(--surface) 75%, var(--gray-light) 25%);
  padding: 12px;
  overflow-x: auto;
  font-size: 11px;
  color: var(--text-mono);
  line-height: 1.6;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.arch2-table-wrap {
  overflow-x: auto;
  border: 1px solid var(--border);
  border-radius: 12px;
}

.arch2-table {
  width: 100%;
  border-collapse: collapse;
  min-width: 880px;
}

.arch2-table th {
  text-align: left;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.45px;
  color: var(--text-muted);
  font-weight: 700;
  padding: 11px 12px;
  background: color-mix(in srgb, var(--surface) 70%, var(--gray-light) 30%);
  border-bottom: 1px solid var(--border);
}

.arch2-table td {
  padding: 12px;
  border-bottom: 1px solid var(--border);
  vertical-align: top;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.6;
}

.arch2-table tr:last-child td { border-bottom: none; }
.arch2-table td strong { color: var(--text); }

.arch2-callout {
  margin-top: 14px;
  border: 1px solid var(--border);
  border-left: 3px solid var(--blue);
  border-radius: 10px;
  padding: 11px 12px;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.65;
  background: color-mix(in srgb, var(--surface) 88%, var(--blue-light) 12%);
}

@media (max-width: 1100px) {
  .arch2-tabs { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .arch2-snapshot { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .arch2-grid-3 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .arch2-pipeline { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

@media (max-width: 760px) {
  .arch2-shell { padding: 18px 14px 40px; }
  .arch2-tabs { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .arch2-snapshot { grid-template-columns: 1fr; }
  .arch2-grid-2,
  .arch2-grid-3,
  .arch2-pipeline { grid-template-columns: 1fr; }
  .arch2-panel-head,
  .arch2-panel-body { padding: 14px; }
  .arch2-panel-title { font-size: 20px; }
}
`

function Panel({ eyebrow, title, summary, children }: {
  eyebrow: string
  title: string
  summary: string
  children: ReactNode
}) {
  return (
    <section className="arch2-panel">
      <div className="arch2-panel-head">
        <div className="arch2-eyebrow">{eyebrow}</div>
        <h2 className="arch2-panel-title">{title}</h2>
        <p className="arch2-panel-summary">{summary}</p>
      </div>
      <div className="arch2-panel-body">{children}</div>
    </section>
  )
}

function BlueprintView() {
  return (
    <Panel
      eyebrow="Foundations"
      title="Blueprint: clear boundaries between request path and compute path"
      summary="RideFlow AI separates latency-sensitive APIs from heavier matching logic. This keeps rider interactions fast while allowing dispatch logic to scale independently."
    >
      <div className="arch2-grid-2" style={{ marginBottom: 14 }}>
        <div className="card">
          <div className="card-header"><span className="card-title">Layered Topology</span></div>
          <div className="card-body">
            <div className="arch2-dark-board">
              <div className="arch2-lane">
                <div className="arch2-lane-title">Experience Layer</div>
                <div className="arch2-chip-row">
                  <span className="arch2-chip">Rider Dashboard</span>
                  <span className="arch2-chip">Driver Dashboard</span>
                  <span className="arch2-chip">Admin Dashboard</span>
                </div>
              </div>
              <div className="arch2-lane">
                <div className="arch2-lane-title">API Layer</div>
                <div className="arch2-chip-row">
                  <span className="arch2-chip arch2-chip-blue">FastAPI REST</span>
                  <span className="arch2-chip arch2-chip-blue">WebSocket Gateway</span>
                </div>
              </div>
              <div className="arch2-lane">
                <div className="arch2-lane-title">Orchestration Layer</div>
                <div className="arch2-chip-row">
                  <span className="arch2-chip arch2-chip-yellow">Celery Worker Pool</span>
                  <span className="arch2-chip arch2-chip-yellow">Redis Broker</span>
                  <span className="arch2-chip arch2-chip-yellow">Pub/Sub Channels</span>
                </div>
              </div>
              <div className="arch2-lane">
                <div className="arch2-lane-title">State Layer</div>
                <div className="arch2-chip-row">
                  <span className="arch2-chip arch2-chip-green">PostgreSQL + PostGIS</span>
                  <span className="arch2-chip arch2-chip-green">Redis TTL Cache</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-header"><span className="card-title">Operational Contracts</span></div>
          <div className="card-body arch2-list">
            <div className="arch2-list-item">
              <div className="arch2-list-title">API Contract</div>
              <div className="arch2-list-desc">Request is accepted quickly and queued. Matching never blocks the caller.</div>
            </div>
            <div className="arch2-list-item">
              <div className="arch2-list-title">State Contract</div>
              <div className="arch2-list-desc">Ride and driver transitions are persisted transactionally to avoid divergent state.</div>
            </div>
            <div className="arch2-list-item">
              <div className="arch2-list-title">Realtime Contract</div>
              <div className="arch2-list-desc">Every critical transition emits an event to both ride and driver channels.</div>
            </div>
            <div className="arch2-list-item">
              <div className="arch2-list-title">Recovery Contract</div>
              <div className="arch2-list-desc">Clients reconnect and resume channel subscriptions without restarting workflows.</div>
            </div>
          </div>
        </div>
      </div>

      <div className="arch2-grid-3">
        <div className="card">
          <div className="card-header"><span className="card-title">Why this works for demos and interviews</span></div>
          <div className="card-body">
            <p className="arch2-line"><strong>Visible boundaries:</strong> You can trace each concern (API, queue, worker, store) without hidden magic.</p>
            <p className="arch2-line"><strong>Real production patterns:</strong> Same architecture can swap components without rewriting flow.</p>
          </div>
        </div>

        <div className="card">
          <div className="card-header"><span className="card-title">Where correctness is enforced</span></div>
          <div className="card-body">
            <p className="arch2-line"><strong>Database locks:</strong> prevent duplicate assignments under concurrency.</p>
            <p className="arch2-line"><strong>Finite state model:</strong> keeps ride lifecycle valid and auditable.</p>
          </div>
        </div>

        <div className="card">
          <div className="card-header"><span className="card-title">Where speed is gained</span></div>
          <div className="card-body">
            <p className="arch2-line"><strong>Async queueing:</strong> removes heavy matching from request-response path.</p>
            <p className="arch2-line"><strong>Push updates:</strong> WebSocket delivery avoids wasteful status polling.</p>
          </div>
        </div>
      </div>
    </Panel>
  )
}

function RideFlowView() {
  return (
    <Panel
      eyebrow="Execution"
      title="Ride Request Flow: what happens from tap to assignment"
      summary="The dispatch lifecycle is intentionally linear, observable, and safe under concurrency. Each step has a user-facing purpose and a backend guardrail."
    >
      <div className="arch2-flow">
        {FLOW_STEPS.map((step, idx) => (
          <article key={step.title} className="arch2-flow-item">
            <span className="arch2-flow-index">{idx + 1}</span>
            <h3 className="arch2-flow-title">{step.title}</h3>
            <p className="arch2-line"><strong>Goal:</strong> {step.goal}</p>
            <p className="arch2-line"><strong>System action:</strong> {step.operation}</p>
            <p className="arch2-line" style={{ marginBottom: 0 }}><strong>Guardrail:</strong> {step.guardrail}</p>
          </article>
        ))}
      </div>

      <div className="arch2-callout">
        This flow is optimized for two things at once: low perceived latency for riders and strict consistency for driver assignment. The queue absorbs spikes; the database lock protects correctness.
      </div>
    </Panel>
  )
}

function RealtimeView() {
  return (
    <Panel
      eyebrow="Eventing"
      title="Realtime Data Plane: event publishing, routing, and UI synchronization"
      summary="State changes are treated as events. Producers publish once, websocket gateways distribute many times, and each dashboard updates from the same message source."
    >
      <div className="arch2-pipeline" style={{ marginBottom: 14 }}>
        <div className="arch2-pipe-col">
          <div className="arch2-pipe-title">1. Event Producers</div>
          <div className="arch2-pipe-node">Celery dispatch worker</div>
          <div className="arch2-pipe-node">Ride status endpoints</div>
          <div className="arch2-pipe-node">Driver status handlers</div>
        </div>

        <div className="arch2-pipe-col">
          <div className="arch2-pipe-title">2. Message Bus</div>
          <div className="arch2-pipe-node">dispatch:{'{ride_id}'}</div>
          <div className="arch2-pipe-node">driver:{'{driver_id}'}</div>
          <div className="arch2-pipe-node">admin:metrics</div>
        </div>

        <div className="arch2-pipe-col">
          <div className="arch2-pipe-title">3. Gateway Routing</div>
          <div className="arch2-pipe-node">Async subscriber loop</div>
          <div className="arch2-pipe-node">Connection registry map</div>
          <div className="arch2-pipe-node">Targeted fanout send</div>
        </div>

        <div className="arch2-pipe-col">
          <div className="arch2-pipe-title">4. Client Effects</div>
          <div className="arch2-pipe-node">Rider trip status update</div>
          <div className="arch2-pipe-node">Driver active trip update</div>
          <div className="arch2-pipe-node">Admin metrics refresh</div>
        </div>
      </div>

      <div className="arch2-grid-2">
        <div className="card">
          <div className="card-header"><span className="card-title">Canonical Event Shape</span></div>
          <div className="card-body">
            <pre className="arch2-code">{`{
  "event": "driver_assigned",
  "ride_id": "rf_2026_004219",
  "driver_id": "drv_118",
  "timestamp": "2026-05-28T01:31:52Z",
  "meta": {
    "distance_km": 1.9,
    "eta_min": 5
  }
}`}</pre>
          </div>
        </div>

        <div className="card">
          <div className="card-header"><span className="card-title">Why push beats polling</span></div>
          <div className="card-body">
            <p className="arch2-line"><strong>Load control:</strong> idle users generate near-zero traffic.</p>
            <p className="arch2-line"><strong>Lower latency:</strong> state changes are delivered when they happen, not at next poll interval.</p>
            <p className="arch2-line" style={{ marginBottom: 0 }}><strong>Consistency:</strong> rider, driver, and admin all consume the same source event, reducing drift.</p>
          </div>
        </div>
      </div>
    </Panel>
  )
}

function ResilienceView() {
  return (
    <Panel
      eyebrow="Operations"
      title="Reliability & Scale: failure handling and growth path"
      summary="The design favors graceful degradation. If something goes wrong, each failure mode has a predictable detector, response, and user-visible outcome."
    >
      <div className="arch2-table-wrap" style={{ marginBottom: 14 }}>
        <table className="arch2-table">
          <thead>
            <tr>
              <th>Failure Mode</th>
              <th>Detection</th>
              <th>Automated Response</th>
              <th>User Outcome</th>
            </tr>
          </thead>
          <tbody>
            {FAILURE_MODES.map(item => (
              <tr key={item.mode}>
                <td><strong>{item.mode}</strong></td>
                <td>{item.detection}</td>
                <td>{item.response}</td>
                <td>{item.impact}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="arch2-grid-3">
        <div className="card">
          <div className="card-header"><span className="card-title">Scale Stage 1</span></div>
          <div className="card-body">
            <p className="arch2-line"><strong>Current target:</strong> demo and local multi-user concurrency.</p>
            <p className="arch2-line" style={{ marginBottom: 0 }}><strong>Pattern:</strong> single DB, multiple workers, shared Redis.</p>
          </div>
        </div>

        <div className="card">
          <div className="card-header"><span className="card-title">Scale Stage 2</span></div>
          <div className="card-body">
            <p className="arch2-line"><strong>Next step:</strong> region-aware worker pools + partitioned data.</p>
            <p className="arch2-line" style={{ marginBottom: 0 }}><strong>Pattern:</strong> queue partitioning by geography.</p>
          </div>
        </div>

        <div className="card">
          <div className="card-header"><span className="card-title">Scale Stage 3</span></div>
          <div className="card-body">
            <p className="arch2-line"><strong>High scale:</strong> event streaming backbone and dedicated websocket edge tier.</p>
            <p className="arch2-line" style={{ marginBottom: 0 }}><strong>Pattern:</strong> replayable events + regional failover.</p>
          </div>
        </div>
      </div>
    </Panel>
  )
}

function StackView() {
  return (
    <Panel
      eyebrow="Rationale"
      title="Technology Decisions: why these tools and how they evolve"
      summary="Every choice here is intentional: easy to explain, reliable under concurrency, and upgradeable without redesigning the whole system."
    >
      <div className="arch2-table-wrap">
        <table className="arch2-table">
          <thead>
            <tr>
              <th>Decision Area</th>
              <th>Current Implementation</th>
              <th>Scale Upgrade Path</th>
              <th>Reasoning</th>
            </tr>
          </thead>
          <tbody>
            {TECH_DECISIONS.map(row => (
              <tr key={row.area}>
                <td><strong>{row.area}</strong></td>
                <td>{row.current}</td>
                <td>{row.scalePath}</td>
                <td>{row.rationale}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="arch2-callout">
        The important point is not a specific vendor or library. The architecture uses proven patterns: asynchronous orchestration, spatial indexing, explicit state transitions, and event-driven UI delivery.
      </div>
    </Panel>
  )
}

export default function ArchitecturePage() {
  useEffect(() => { document.title = 'Architecture | RideFlow AI' }, [])
  const [view, setView] = useState<ViewKey>('blueprint')

  return (
    <div className="app-shell">
      <style>{ARCH_STYLES}</style>

      <header className="topbar">
        <span className="topbar-logo">RideFlow AI</span>
        <AppNav />
      </header>

      <PageHeader
        icon={Layers}
        title="Architecture Deep Dive"
        subtitle="A full walkthrough of how RideFlow AI processes requests, enforces consistency, and delivers realtime updates at scale."
        accent="var(--blue)"
        accentBg="var(--blue-light)"
        infoDescription="This page is intentionally structured as an engineering narrative: blueprint first, then execution flow, realtime delivery, reliability strategy, and decision rationale."
        infoTags={['System narrative', 'Concurrency-safe dispatch', 'Realtime event architecture']}
      />

      <main className="arch2-shell">
        <section className="arch2-snapshot">
          {SNAPSHOT.map(item => (
            <article key={item.label} className="arch2-snapshot-card">
              <div className="arch2-snapshot-value">{item.value}</div>
              <div className="arch2-snapshot-label">{item.label}</div>
              <p className="arch2-snapshot-detail">{item.detail}</p>
            </article>
          ))}
        </section>

        <div className="arch2-tabs-wrap">
          <div className="arch2-tabs">
            {VIEW_TABS.map(tab => (
              <button
                key={tab.key}
                className={`arch2-tab ${view === tab.key ? 'active' : ''}`}
                onClick={() => setView(tab.key)}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {view === 'blueprint' && <BlueprintView />}
        {view === 'rideflow' && <RideFlowView />}
        {view === 'realtime' && <RealtimeView />}
        {view === 'resilience' && <ResilienceView />}
        {view === 'stack' && <StackView />}
      </main>
    </div>
  )
}
