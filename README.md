# RideFlow AI

**Real-Time Ride Dispatch System with Operational AI**

A production-style distributed backend system built to implement the concepts
tested in the "Design Uber/Lyft" system design interview — not as a clone,
but as a working, deployable backend with a live demo.

[![Build Status](https://github.com/tirthoraj/rideflow-ai/actions/workflows/deploy.yml/badge.svg)](https://github.com/tirthoraj/rideflow-ai/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Python](https://img.shields.io/badge/Python-3.11+-blue)](https://python.org)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.110+-green)](https://fastapi.tiangolo.com)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-15+_PostGIS-blue)](https://postgis.net)

---

## Live Demo

**[rideflow-ai.vercel.app](https://rideflow-ai.vercel.app)**

The demo page (`/demo`) shows all three role views simultaneously — rider,
driver, and admin — with manual simulation controls. Select a scale preset,
seed drivers, create ride requests, and watch the dispatch engine and AI
layer respond in real time.

Each dashboard is also independently accessible:

| Role | URL | Access |
|------|-----|--------|
| Rider | `/rider` | Public (demo mode) |
| Driver | `/driver` | Public (demo mode) |
| Admin / Operations | `/admin` | Role-restricted (RBAC) |
| Architecture | `/architecture` | Public |

---

## What This Project Is

RideFlow AI is a backend engineering project, not a product. The goal is to
build and deploy every component that appears in the "Design Uber" system
design interview question and understand *why* each design decision was made.

Every technology choice is documented with the alternative that was considered,
the reason it was rejected, and a real-world company that uses the same pattern
in production. See the [Architecture page](#architecture-page) or `/architecture`
on the live site.

**This is not:**
- An Uber clone with full user management
- A chatbot or LLM wrapper
- A tutorial project

**This is:**
- A working implementation of geospatial driver dispatch
- A 7-state ride lifecycle managed by a proper state machine
- A real-time WebSocket system backed by Redis Pub/Sub fan-out
- An AI layer that detects demand hotspots and recommends driver repositioning
- A system you can explain, defend, and scale in an interview

---

## System Overview

```
Three user roles. Three separate applications. One backend.

RIDER APP          DRIVER APP         ADMIN DASHBOARD
(public-facing)    (driver-facing)    (internal ops — RBAC protected)
      |                  |                     |
      +------------------+---------------------+
                         |
                  API GATEWAY (FastAPI)
                         |
          +--------------+------------------+
          |                                 |
   DISPATCH SERVICE              WEBSOCKET SERVICE
   (Celery workers)              (Redis Pub/Sub fan-out)
          |                                 |
          +------------------+--------------+
                             |
                        DATA LAYER
                             |
             +---------------+---------------+
             |                               |
   PostgreSQL + PostGIS                   Redis
   - rides, drivers (metadata)            - driver locations (ephemeral)
   - ride state + event log               - driver status (TTL-based)
   - dispatch logs                        - pub/sub channels
   - AI demand predictions                - session cache
             |
         AI SERVICE
         (DBSCAN clustering + LLM summaries)
```

---

## Why Three Separate Roles

In real ride-hailing platforms (Uber, Ola, Lyft), three separate applications
exist for three separate user types:

**Rider App** — what passengers use. A rider sees only their own ride and
their assigned driver's location after assignment. They must never see other
drivers' real-time positions (privacy violation) or system metrics.

**Driver App** — a separate application with a separate registration flow
(background verification, vehicle documents). A driver sees one incoming
request at a time — the one dispatched to them — and their own active ride.
They must never see other drivers' locations or the system's full ride list.

**Internal Operations Dashboard** — used by the operations and engineering
teams. Not publicly accessible. In production this sits behind a VPN or
IP allowlist. It shows full system visibility: all active drivers, all rides,
dispatch metrics, WebSocket connection health, and AI demand predictions.
This is what allows the operations team to respond to supply shortages.

This separation is implemented via **Role-Based Access Control (RBAC)**:
- Each user authenticates and receives a JWT with a `role` claim
- API endpoints validate the role before serving data
- WebSocket channels are scoped per ride — a rider's connection subscribes
  only to `dispatch:{their_ride_id}`, never a system-wide channel

---

## Key System Design Concepts Implemented

| Concept | Implementation | Why |
|---------|---------------|-----|
| Geospatial driver lookup | PostGIS + GiST spatial index, ST_DWithin query | Bounded box scan instead of full table scan |
| Driver location storage | Redis HASH with TTL | High-frequency writes (200/sec) don't need ACID |
| Real-time fan-out | WebSocket + Redis Pub/Sub | Stateless WS servers — any instance serves any client |
| Ride lifecycle | 7-state machine with enforced transitions | Prevents invalid states, full audit trail |
| Async dispatch | Celery tasks + Redis broker | Multi-step retry workflow cannot block the API handler |
| Demand prediction | DBSCAN clustering on ride density | No pre-specified cluster count, handles irregular shapes |
| Operational summaries | Gemini Flash (LLM) | Translates structured data to readable ops insight only |

---

## Tech Stack

### Backend
| Component | Technology |
|-----------|-----------|
| API framework | FastAPI + AsyncIO |
| Task queue | Celery + Redis broker |
| Primary database | PostgreSQL 15 + PostGIS extension |
| Cache / location store | Redis |
| ORM + migrations | SQLAlchemy + Alembic |
| ML / clustering | scikit-learn (DBSCAN) |
| LLM summaries | Google Gemini Flash API (free tier) |

### Frontend
| Component | Technology |
|-----------|-----------|
| Framework | React 18 + TypeScript |
| Styling | Tailwind CSS |
| Build tool | Vite |
| Maps | Leaflet.js + OpenStreetMap (no API key required) |
| Real-time | Native WebSocket API |

### Infrastructure
| Component | Technology |
|-----------|-----------|
| Containerization | Docker + Docker Compose |
| Reverse proxy | Nginx |
| CI/CD | GitHub Actions |
| Backend deployment | AWS EC2 (t3.micro, free tier) |
| Frontend deployment | Vercel (free tier) |
| SSL | Let's Encrypt (free) |

**Total infrastructure cost: $0** during development and for the first
12 months of deployment on AWS free tier.

---

## Getting Started

### Prerequisites

- Docker Desktop (version 24+)
- Docker Compose (included with Docker Desktop)
- Git

That is all. No local Python or Node.js installation required — everything
runs in containers.

### Clone and Run

```bash
git clone https://github.com/tirthoraj/rideflow-ai.git
cd rideflow-ai

# Copy environment config
cp .env.example .env

# Start all services
docker-compose up --build
```

Services started by `docker-compose up`:

| Service | Port | Description |
|---------|------|-------------|
| Frontend | 3000 | React app |
| API | 8000 | FastAPI backend |
| WebSocket | 8001 | WebSocket service |
| Celery worker | — | Dispatch task worker |
| AI service | 8002 | Prediction service |
| PostgreSQL | 5432 | Primary database |
| Redis | 6379 | Cache + broker + pub/sub |
| Nginx | 80 | Reverse proxy |

Open `http://localhost:3000` to access the application.

### Running the Demo Locally

Navigate to `http://localhost:3000/demo`.

1. Select a scale preset (Light / Moderate / Dense Area)
2. Click **Seed Drivers** — registers drivers at Bengaluru GPS coordinates
3. Click **Simulate Driver Movement** — starts location heartbeats
4. Click **Create Ride Requests** — triggers the dispatch engine
5. Click **Run AI Prediction** — runs DBSCAN and generates hotspot analysis
6. Click **Reset All** to start over

No terminal commands required after `docker-compose up`.

### Environment Variables

Copy `.env.example` to `.env` and fill in:

```env
# Database
POSTGRES_USER=rideflow
POSTGRES_PASSWORD=your_password
POSTGRES_DB=rideflow_db

# Redis
REDIS_URL=redis://redis:6379/0

# Auth
JWT_SECRET=your_jwt_secret_key
JWT_ALGORITHM=HS256

# AI (get free API key at aistudio.google.com)
GEMINI_API_KEY=your_gemini_api_key

# Demo mode (enables /api/demo/* endpoints and simulation controls)
DEMO_MODE=true
```

---

## Project Structure

```
rideflow-ai/
|
+-- backend/
|   +-- app/
|   |   +-- api/                    # FastAPI route handlers
|   |   |   +-- rides.py
|   |   |   +-- drivers.py
|   |   |   +-- dispatch.py
|   |   |   +-- websocket.py
|   |   |   +-- admin.py
|   |   |   +-- demo.py             # Demo simulation endpoints (DEMO_MODE only)
|   |   |
|   |   +-- services/
|   |   |   +-- dispatch/           # Geospatial dispatch engine
|   |   |   |   +-- engine.py       # PostGIS query + driver selection
|   |   |   |   +-- retry.py        # Retry policy + radius expansion
|   |   |   +-- ride/
|   |   |   |   +-- state_machine.py  # 7-state ride lifecycle
|   |   |   |   +-- events.py         # Append-only event log
|   |   |   +-- driver/
|   |   |   |   +-- location.py     # Redis HASH location writes
|   |   |   |   +-- status.py       # TTL-based availability
|   |   |   +-- websocket/
|   |   |       +-- manager.py      # Connection registry
|   |   |       +-- pubsub.py       # Redis Pub/Sub subscriber
|   |   |
|   |   +-- workers/
|   |   |   +-- dispatch_task.py    # Celery dispatch task
|   |   |   +-- ai_task.py          # Celery Beat prediction task
|   |   |
|   |   +-- ai/
|   |   |   +-- clustering.py       # DBSCAN on ride density
|   |   |   +-- repositioning.py    # Driver reposition recommendations
|   |   |   +-- summary.py          # Gemini Flash LLM summary
|   |   |
|   |   +-- models/                 # SQLAlchemy ORM models
|   |   |   +-- ride.py
|   |   |   +-- driver.py
|   |   |   +-- ride_event.py
|   |   |   +-- dispatch_log.py
|   |   |   +-- demand_prediction.py
|   |   |
|   |   +-- core/
|   |       +-- config.py           # Settings from env vars
|   |       +-- database.py         # Async PostgreSQL connection
|   |       +-- redis.py            # Redis connection pool
|   |       +-- security.py         # JWT + RBAC
|   |
|   +-- alembic/                    # Database migrations
|   +-- tests/                      # Pytest test suite
|   +-- Dockerfile
|
+-- frontend/
|   +-- src/
|   |   +-- pages/
|   |   |   +-- Demo.tsx            # All-in-one demo view
|   |   |   +-- RiderDashboard.tsx
|   |   |   +-- DriverDashboard.tsx
|   |   |   +-- AdminDashboard.tsx
|   |   |   +-- Architecture.tsx    # About the project page
|   |   |   +-- Landing.tsx
|   |   +-- hooks/
|   |   |   +-- useWebSocket.ts     # WebSocket connection + reconnect
|   |   |   +-- useRideState.ts     # Ride state subscription
|   |   +-- components/
|   |   |   +-- Map.tsx             # Leaflet map wrapper
|   |   |   +-- DispatchLog.tsx     # Live event feed
|   |   |   +-- AIPanel.tsx         # Prediction + recommendation display
|   |   |   +-- SimulationControls.tsx  # Demo preset buttons
|   |   +-- api/
|   |       +-- client.ts           # Axios API client
|   +-- Dockerfile
|
+-- infrastructure/
|   +-- docker-compose.yml
|   +-- docker-compose.prod.yml
|   +-- nginx/
|   |   +-- nginx.conf
|   +-- scripts/
|       +-- init_db.sql             # PostGIS extension setup
|
+-- deployment/
|   +-- github-actions/
|       +-- deploy.yml
|
+-- .env.example
+-- README.md
```

---

## API Reference

Interactive API documentation is available at `http://localhost:8000/docs`
(Swagger UI, auto-generated by FastAPI).

Core endpoints:

```
POST   /api/v1/rides                Create ride request
GET    /api/v1/rides/{id}           Get ride details and current state
PATCH  /api/v1/rides/{id}/cancel    Cancel a ride

POST   /api/v1/drivers              Register driver
PATCH  /api/v1/drivers/{id}/location   Update driver GPS location
PATCH  /api/v1/drivers/{id}/status     Toggle driver availability

GET    /api/v1/admin/metrics        System-wide operational metrics
GET    /api/v1/admin/predictions    Latest AI demand predictions

WS     /ws/ride/{ride_id}           Rider WebSocket connection
WS     /ws/driver/{driver_id}       Driver WebSocket connection
WS     /ws/admin                    Admin WebSocket connection

POST   /api/demo/seed               Seed demo drivers (DEMO_MODE only)
POST   /api/demo/move               Start location simulation
POST   /api/demo/requests           Create bulk ride requests
POST   /api/demo/ai/run             Trigger AI prediction immediately
POST   /api/demo/reset              Clear all demo data
```

---

## Architecture Page

The `/architecture` page (also at `/architecture` on the live site) documents
every system design decision in detail:

- Geospatial driver dispatch: PostGIS + GiST index vs naive distance sort
- Driver location: Redis TTL vs PostgreSQL row updates
- Real-time fan-out: WebSocket + Redis Pub/Sub vs HTTP polling vs Kafka
- Ride lifecycle: enforced state machine vs free-form status fields
- Async dispatch: Celery workers vs inline API handlers
- AI prediction: DBSCAN clustering vs k-means vs neural networks
- Scalability: what breaks at 10x, 100x, 1000x and the fix for each

Each section includes a real-world company that uses the same pattern and
what that pattern gave them in production.

---

## Simulation Scale Presets

The demo supports three scale presets to demonstrate different system behaviours:

| Preset | Drivers | Requests | Area | Supply/Demand | What it shows |
|--------|---------|----------|------|---------------|---------------|
| Light Traffic | 8 | 5 | 6 km radius | 1.6 | Happy path: clean dispatch, sub-second assignment |
| Moderate Traffic | 25 | 20 | 4 km radius | 1.25 | Retries: driver rejection, radius expansion |
| Dense Area Peak | 45 | 50 | 2 sq km | 0.9 | Saturation: queue depth, surge pricing, AI fires |

The Dense preset simulates a tech park (Whitefield, Bengaluru) at 6:30 PM —
50 simultaneous ride requests in a 2 square kilometre zone, just below
driver supply capacity. Enough rides get assigned to show the system working,
enough queue to show stress, enough shortage for the AI prediction to activate.

---

## Development Roadmap

### Phase 1 — Foundation
> Local development environment. All services running. Single-command startup.

- [x] FastAPI project initialized with async architecture and API versioning
- [x] PostgreSQL container configured with PostGIS extension enabled
- [x] Redis container configured
- [x] Celery configured with Redis as broker
- [x] Alembic migrations: baseline schema with all tables
- [x] React + TypeScript + Tailwind frontend initialized with Vite
- [x] docker-compose.yml with all services networked and health-checked
- [x] Environment variable configuration (.env.example)
- [x] All services connect and communicate — verified via health endpoints

---

### Phase 2 — Core System Design Layer
> Dispatch engine, geospatial lookup, and ride state machine.

- [x] Driver registration and profile API
- [x] Driver location update endpoint (writes to Redis HASH with TTL)
- [x] Driver status management (available / busy / offline)
- [x] Driver auto-offline on TTL expiry
- [x] Ride creation API
- [x] Ride state machine: 7 states with enforced valid transitions
- [x] Ride event log: append-only ride_events table
- [x] Ride cancellation with state validation
- [x] Ride completion flow
- [x] PostGIS GiST spatial index on driver location column
- [x] Nearest driver query: ST_DWithin with distance sort, limit 5
- [x] SELECT FOR UPDATE: prevent race condition on driver assignment
- [x] Celery dispatch task: find driver, assign, wait, retry on timeout
- [x] Retry policy: next driver in sorted list on rejection
- [x] Radius expansion on all candidates exhausted: 3 km -> 5 km
- [x] Dispatch attempt log: records each attempt, outcome, latency
- [x] Surge pricing: demand/supply ratio per geohash zone

---

### Phase 3 — Real-Time Layer
> WebSocket connections, Redis Pub/Sub fan-out, live updates.

- [x] WebSocket endpoint in FastAPI for rider connections
- [x] WebSocket endpoint for driver connections
- [x] WebSocket endpoint for admin connections
- [x] Connection registry: track active connections per ride/driver
- [x] Redis Pub/Sub subscriber per WebSocket service instance
- [x] Publish ride state change events to `dispatch:{ride_id}` channel
- [x] Publish driver location updates to `driver:{driver_id}` channel
- [x] Publish dispatch events to `admin:metrics` channel
- [x] Publish AI alerts to `ai:alerts` channel
- [x] Rider WebSocket: receives ride status updates + assigned driver location
- [x] Driver WebSocket: receives incoming requests + dispatch outcome
- [x] Admin WebSocket: receives system metrics + AI alerts
- [x] Reconnection handling: client pulls current state from REST on reconnect
- [x] WebSocket connection count tracked and exposed to admin metrics

---

### Phase 4 — Minimal Frontend (Integration Validation)
> Build just enough UI to verify Phases 2 and 3 work together end-to-end.
> The dispatch engine and WebSocket layer have only been tested via API calls.
> This phase puts a real client on the other side to confirm the full chain:
> state machine transition → Celery event → Redis Pub/Sub → WebSocket → UI update.
> Do not proceed to Phase 5 until this validation passes.

**Rider Dashboard (`/rider`)**
- [ ] Leaflet map with OpenStreetMap tiles (no API key)
- [ ] Pickup and drop location inputs (pre-filled with Bengaluru coordinates)
- [ ] Request Ride button — calls POST /api/v1/rides
- [ ] Ride status stepper: shows current state, highlights active step
- [ ] Status updates received via WebSocket without page refresh
- [ ] Driver pin appears on map after DRIVER_ASSIGNED state
- [ ] Driver pin moves on each location update (DRIVER_ARRIVING state)

**Driver Dashboard (`/driver`)**
- [ ] Leaflet map with driver's own location pin
- [ ] Online / Offline toggle — PATCH /api/v1/drivers/{id}/status
- [ ] Incoming request card: pickup, drop, estimated fare, distance, countdown timer
- [ ] Accept button — triggers DRIVER_ASSIGNED transition
- [ ] Reject button — triggers dispatch retry to next nearest driver
- [ ] Active ride section shown after accepting: ride ID, current state, Complete Ride button

**WebSocket Integration**
- [ ] `useWebSocket` hook: connects, parses events, updates local React state
- [ ] Auto-reconnect on disconnect with exponential backoff
- [ ] On reconnect: fetches current ride/driver state from REST API before resubscribing
- [ ] Connection status indicator visible on each dashboard (connected / reconnecting)

**Validation Checkpoint — Definition of Done**
- [ ] Open Rider and Driver dashboards side by side in two browser tabs
- [ ] Book a ride on Rider — Driver sees incoming request card without refreshing
- [ ] Driver accepts — Rider status updates to DRIVER_ASSIGNED without refreshing
- [ ] Driver pin appears on Rider map and moves toward pickup location
- [ ] Driver rejects a second ride — Rider sees retry, then new driver assigned
- [ ] Driver goes offline — Redis TTL expires, driver marked offline automatically

---

### Phase 5 — AI Layer
> DBSCAN demand prediction, driver repositioning, LLM operational summaries.
> Sits on top of the verified Phase 2+3+4 foundation.

- [ ] Celery Beat task: aggregate ride request density by geohash (every 5 min)
- [ ] DBSCAN clustering on ride density + time-of-day features
- [ ] Hotspot cluster detection: zones where demand > supply * threshold
- [ ] Driver shortage quantification per hotspot zone
- [ ] Prediction confidence score based on cluster density
- [ ] Store prediction results in demand_predictions table
- [ ] Driver repositioning: match idle drivers near each hotspot
- [ ] Repositioning recommendation: ranked by distance to hotspot center
- [ ] Push recommendations to `ai:alerts` Redis channel
- [ ] Gemini Flash API integration: generate 2-sentence operational summary
- [ ] LLM call triggered on hotspot detection only (not every prediction run)
- [ ] Demand zone overlay on admin map when hotspot confirmed
- [ ] GET /api/v1/admin/predictions endpoint returns latest hotspot data

---

### Phase 6 — Admin Dashboard and Observability
> Full operational visibility, AI panel, and demo simulator controls.
> Completes the frontend. Makes the system demo-ready.

- [ ] Admin dashboard: live map with all driver and ride pins
- [ ] Driver pin colour: green (available), red (on a ride)
- [ ] Ride pins: blue (pickup), orange (drop)
- [ ] Demand zone shading overlay when DBSCAN hotspot confirmed
- [ ] Ride state distribution panel (count per state)
- [ ] Live dispatch metrics: avg latency, success rate, retry count, failed rides
- [ ] WebSocket connection count display
- [ ] Live dispatch event log: real-time feed of all dispatch events
- [ ] AI Intelligence panel: hotspot zone, shortage count, confidence, recommendation
- [ ] LLM summary displayed in AI panel
- [ ] Demo simulator controls (visible when DEMO_MODE=true)
- [ ] Scale preset selector: Light / Moderate / Dense
- [ ] Step 1: Seed Drivers button — POST /api/demo/seed
- [ ] Step 2: Simulate Driver Movement button — POST /api/demo/move
- [ ] Step 3: Create Ride Requests button — POST /api/demo/requests
- [ ] Step 4: Run AI Prediction button — POST /api/demo/ai/run
- [ ] Reset All button — POST /api/demo/reset
- [ ] Each button labelled with a one-line description of what it does
- [ ] Rider dashboard: "Open in new tab" link added
- [ ] Driver dashboard: "Open in new tab" link added
- [ ] Landing page (`/`): project description, tech stack, links to demo and architecture
- [ ] Architecture page (`/architecture`): all 8 system design sections with company references
- [ ] Demo page (`/demo`): all three panels side by side with simulation controls

---

### Phase 7 — Docker, CI/CD, and Deployment
> Containerized deployment. Automated pipeline. Live public URL.

- [ ] Dockerfile for backend (multi-stage build)
- [ ] Dockerfile for frontend (multi-stage build with Nginx static serving)
- [ ] Dockerfile for Celery worker
- [ ] docker-compose.prod.yml for production configuration
- [ ] Nginx reverse proxy: routes /api to backend, /ws to websocket, / to frontend
- [ ] GitHub Actions: run pytest on push to main
- [ ] GitHub Actions: build Docker images
- [ ] GitHub Actions: SSH deploy to EC2 on test pass
- [ ] AWS EC2 t3.micro: install Docker, clone repo, run docker-compose.prod.yml
- [ ] Let's Encrypt SSL certificate via Certbot
- [ ] Frontend deployed to Vercel (connects to EC2 backend API)
- [ ] Environment variables managed via EC2 .env (not committed to repo)
- [ ] Health check endpoint monitored by GitHub Actions post-deploy

---

## Command Reference

### Docker — Daily Workflow

```bash
# First time setup — builds images and starts all services
docker-compose up --build

# Day-to-day start — use existing images, no rebuild
docker-compose start

# Stop all containers without removing them (data preserved)
docker-compose stop

# Start after a stop
docker-compose start

# Rebuild only when Dockerfile or requirements.txt / package.json changes
docker-compose up --build

# Remove containers but keep volume data (PostgreSQL + Redis data survives)
docker-compose down

# Remove containers AND all volume data — database is wiped
# Only use this to start completely fresh
docker-compose down -v

# Check which containers are running and their status
docker-compose ps
```

---

### Docker — Logs

```bash
# Stream logs from all services
docker-compose logs -f

# Logs from a specific service only
docker-compose logs -f api
docker-compose logs -f worker
docker-compose logs -f postgres
docker-compose logs -f redis

# Last 50 lines from a service (useful after a crash)
docker-compose logs --tail=50 api
```

---

### Docker — Running Commands Inside Containers

```bash
# Open an interactive shell inside the API container
docker-compose exec api bash

# Open a Python REPL inside the API container
docker-compose exec api python

# Open psql (PostgreSQL CLI) inside the database container
docker-compose exec postgres psql -U rideflow -d rideflow_db

# Open Redis CLI
docker-compose exec redis redis-cli
```

---

### Database — Alembic Migrations

```bash
# Apply all pending migrations (run after pulling new changes)
docker-compose exec api alembic upgrade head

# Create a new migration after changing a SQLAlchemy model
docker-compose exec api alembic revision --autogenerate -m "describe your change"

# Check current migration version applied to the database
docker-compose exec api alembic current

# View full migration history
docker-compose exec api alembic history

# Roll back the last migration
docker-compose exec api alembic downgrade -1

# Roll back all migrations (drops all tables)
docker-compose exec api alembic downgrade base
```

---

### Database — PostgreSQL Inspection

```bash
# Connect to the database
docker-compose exec postgres psql -U rideflow -d rideflow_db

# Inside psql — useful queries:

# List all tables
\dt

# Check rides and their current state
SELECT id, status, created_at FROM rides ORDER BY created_at DESC LIMIT 10;

# Check available drivers and their last known location
SELECT id, status, ST_AsText(location) AS location FROM drivers WHERE status = 'available';

# Check dispatch log for a specific ride
SELECT * FROM dispatch_logs WHERE ride_id = '<ride_id>' ORDER BY created_at;

# Check ride event history (state machine audit trail)
SELECT event_type, payload, created_at FROM ride_events WHERE ride_id = '<ride_id>';

# Count rides by status
SELECT status, COUNT(*) FROM rides GROUP BY status;

# Exit psql
\q
```

---

### Redis — Inspection

```bash
# Connect to Redis CLI
docker-compose exec redis redis-cli

# Inside redis-cli — useful commands:

# Check a driver's current location
HGETALL driver:location:<driver_id>

# Check a driver's status and its remaining TTL (seconds until auto-offline)
GET driver:status:<driver_id>
TTL driver:status:<driver_id>

# List all driver location keys currently in Redis
KEYS driver:location:*

# Check Redis memory usage
INFO memory

# Count total keys in Redis
DBSIZE

# Monitor all Redis commands in real time (useful for debugging pub/sub)
MONITOR

# Exit redis-cli
EXIT
```

---

### Celery — Worker Management

```bash
# Check active Celery workers and their status
docker-compose exec worker celery -A app.workers inspect active

# Check tasks currently queued
docker-compose exec worker celery -A app.workers inspect reserved

# Check Celery Beat scheduled tasks
docker-compose exec worker celery -A app.workers inspect scheduled

# Purge all pending tasks from the queue (use with caution)
docker-compose exec worker celery -A app.workers purge

# View Celery worker logs in real time
docker-compose logs -f worker
```

---

### Running Tests

```bash
# Run full test suite
docker-compose exec api pytest

# Run with coverage report
docker-compose exec api pytest --cov=app --cov-report=term-missing

# Run a specific test file
docker-compose exec api pytest tests/test_dispatch.py -v

# Run a specific test by name
docker-compose exec api pytest tests/test_dispatch.py::test_nearest_driver_found -v

# Run only tests marked as fast (skip slow integration tests)
docker-compose exec api pytest -m "not slow"
```

---

### Rebuilding a Single Service

```bash
# Rebuild and restart only the API container (without touching DB or Redis)
docker-compose up --build api

# Rebuild only the frontend
docker-compose up --build frontend

# Rebuild only the Celery worker
docker-compose up --build worker

# Restart a single service without rebuilding
docker-compose restart api
```

---

### Production vs Local

```bash
# Run with local config (default)
docker-compose up

# Run with production config
docker-compose -f docker-compose.yml -f docker-compose.prod.yml up -d

# Run in detached mode (background, no log output to terminal)
docker-compose up -d

# Stop detached services
docker-compose down
```

---

## Authentication and Role-Based Access Control

RideFlow AI uses JWT-based authentication with role claims.

Three roles exist in the system:

| Role | Access | Description |
|------|--------|-------------|
| `RIDER` | Rider dashboard, own ride data | Standard passenger account |
| `DRIVER` | Driver dashboard, own requests and active ride | Verified driver account |
| `ADMIN` | Full system visibility, all admin endpoints | Internal operations team |

JWT token structure:
```json
{
  "sub": "user-id",
  "role": "RIDER",
  "exp": 1716000000
}
```

In the demo deployment, the `/demo` page operates without authentication
to allow public access. The `/admin` endpoint is protected by role check
in all non-demo environments.

---

## Design Decisions and Rationale

Every major decision in this project has a documented reason. The short
version:

**PostgreSQL + PostGIS, not MongoDB** — Rides are transactional. Driver
assignment must be atomic. PostGIS handles geospatial queries natively.
No second database needed.

**Redis for driver location, not PostgreSQL** — 200 writes/second across
all drivers, no durability requirement, TTL-based offline detection. Redis
is the right tool.

**Redis Pub/Sub, not Kafka** — WebSocket fan-out is fire-and-forget. No
replay, no consumer groups, no ordered streams required. Kafka adds
operational complexity with no benefit here.

**DBSCAN, not k-means** — Demand hotspots have irregular shapes and
unknown count. DBSCAN discovers both from data, no k needed.

**Gemini Flash for summaries only, not decisions** — LLM in the decision
path means LLM errors affect dispatch correctness. LLM for readable output
only means the dispatch engine is never dependent on it.

Full rationale with alternatives considered and real-world company references
is on the `/architecture` page.

---

## License

MIT License. See [LICENSE](LICENSE).
