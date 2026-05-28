# RideFlow AI

**Real-Time Ride Dispatch System with Operational AI**

A production-style distributed backend built to implement every concept
tested in the "Design Uber/Lyft" system design interview — not as a clone,
but as a working, deployable system with a live interactive demo.

<div align="center">

![Python](https://img.shields.io/badge/Python-3.11+-3776AB?logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-009688?logo=fastapi&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?logo=postgresql&logoColor=white)
![Redis](https://img.shields.io/badge/Redis-DC382D?logo=redis&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-2496ED?logo=docker&logoColor=white)
![scikit-learn](https://img.shields.io/badge/scikit--learn-F7931E?logo=scikit-learn&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-yellow.svg)

</div>

<img width="1190" height="750" alt="image" src="https://github.com/user-attachments/assets/65085364-73d2-43d8-aaba-38473afe87ce" />

---

## What This Project Is

RideFlow AI is a backend engineering project, not a product. The goal is to build and demonstrate every component that appears in the "Design Uber" system design interview — and explain *why* each decision was made.

**This is not:**
- An Uber clone with user management or authentication
- A chatbot or LLM wrapper
- A tutorial project with simplified patterns

**This is:**
- A working geospatial dispatch engine with SELECT FOR UPDATE SKIP LOCKED
- A 7-state ride lifecycle enforced by a proper finite state machine
- A real-time WebSocket system backed by Redis Pub/Sub fan-out
- An AI layer (DBSCAN clustering) that detects demand hotspots live and recommends driver repositioning
- A system you can run, explain, and defend in an interview

---

## Live Demo

**[rideflow-ai.vercel.app](https://rideflow-ai.vercel.app)**

| Page | URL | Purpose |
|------|-----|---------|
| Playground | `/playground` | 4-step simulation with live AI analysis |
| Rider | `/rider` | Book a ride, watch dispatch in real time |
| Driver | `/driver` | Receive requests, complete trips |
| Admin | `/admin` | Fleet ops view with AI Operations panel |
| Architecture | `/architecture` | Full system design walkthrough |

---

## System Overview

```
RIDER APP          DRIVER APP         ADMIN DASHBOARD        PLAYGROUND
(book rides)       (receive rides)    (ops + AI alerts)      (simulation)
      |                  |                     |                    |
      +------------------+---------------------+--------------------+
                                    |
                         API GATEWAY (FastAPI)
                                    |
              +---------------------+---------------------+
              |                     |                     |
      DISPATCH SERVICE       WEBSOCKET SERVICE       AI SERVICE
      (Celery workers)       (Redis Pub/Sub)         (DBSCAN loop)
              |                     |                     |
              +---------------------+---------------------+
                                    |
                               DATA LAYER
                    +--------------+------------------+
                    |                                 |
          PostgreSQL + PostGIS                     Redis
          - rides, drivers                         - driver locations (TTL)
          - ride state + event log                 - pub/sub channels
          - dispatch logs                          - demo driver ID set
          - demand_predictions
```

---

## Key System Design Concepts

| Concept | Implementation | Interview Question |
|---------|---------------|-------------------|
| Geospatial driver lookup | PostGIS `ST_DWithin` + GiST spatial index | "How do you find the nearest driver?" |
| Race condition prevention | `SELECT FOR UPDATE SKIP LOCKED` | "How do you prevent double-assignment?" |
| Real-time fan-out | WebSocket + Redis Pub/Sub | "How do updates reach clients without polling?" |
| Ride lifecycle | 7-state FSM with enforced transitions | "How do you manage ride state?" |
| Async dispatch | Celery workers + Redis broker | "How do you keep the API fast under load?" |
| Driver liveness | Redis HASH with 30s TTL | "How does a driver go offline automatically?" |
| Demand AI | DBSCAN clustering on pickup coordinates | "How do you predict demand before it peaks?" |
| Driver reposition | PostGIS `ST_Distance` nearest-driver query | "How does the system suggest driver repositioning?" |

---

## Tech Stack

### Backend
| Component | Technology |
|-----------|-----------|
| API framework | FastAPI + AsyncIO |
| Task queue | Celery + Redis broker |
| Primary database | PostgreSQL 16 + PostGIS |
| Cache / location store | Redis |
| ORM + migrations | SQLAlchemy (async) + Alembic |
| AI / clustering | scikit-learn (DBSCAN) + NumPy |

### Frontend
| Component | Technology |
|-----------|-----------|
| Framework | React 18 + TypeScript |
| Build tool | Vite |
| Maps | Leaflet.js + react-leaflet (OpenStreetMap, no API key) |
| Real-time | Native WebSocket API |
| Styling | Custom CSS with CSS variables (light/dark themes) |

### Infrastructure
| Component | Technology |
|-----------|-----------|
| Containerization | Docker + Docker Compose |
| Frontend deployment | Vercel |

---

## Getting Started

### Prerequisites

- Docker Desktop (version 24+)
- Docker Compose (included with Docker Desktop)
- Node.js 20+ (only if you want to run frontend locally)

No local Python installation required.

### Run Locally

```bash
git clone https://github.com/tirthoraj/rideflow-ai.git
cd rideflow-ai

docker-compose up --build
```

Backend is available at `http://localhost:8000` (Swagger: `http://localhost:8000/docs`).

Frontend options:
- Use the deployed app: `https://rideflow-ai.vercel.app`
- Or run locally:

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:3000` for local frontend.

Services started:

| Service | Port | Description |
|---------|------|-------------|
| Backend | 8000 | FastAPI (API + WebSocket) |
| Celery worker | — | Dispatch task worker |
| PostgreSQL | 5432 | Primary database |
| Redis | 6379 | Cache + broker + pub/sub |

### Environment Variables

```env
# Backend
DATABASE_URL=postgresql+asyncpg://rideflow:rideflow_dev@localhost:5432/rideflow
REDIS_URL=redis://localhost:6379/0
CELERY_BROKER_URL=redis://localhost:6379/1
DEMO_MODE=true

# Optional (for deployed frontend access)
CORS_ORIGINS=https://rideflow-ai.vercel.app
```

---

## Running the Playground Demo

Navigate to `http://localhost:3000/playground`.

1. **Select a preset** — Light, Moderate, or Dense traffic scenario
2. **Step 1: Seed Drivers** — places drivers at real Bengaluru GPS coordinates
3. **Step 2: Start Movement** — begins random-walk location heartbeats every 2s
4. **Step 3: Fire Requests** — fires all ride requests simultaneously, triggering parallel Celery dispatch
5. **Step 4: Start AI Loop** — runs DBSCAN every 8s on unmatched rides, publishes hotspot alerts via Redis → WebSocket

Open `/admin` in another tab to see the AI Operations panel update in real time.

### Simulation Presets

| Preset | Drivers | Requests | Radius | What it shows |
|--------|---------|----------|--------|---------------|
| Light Traffic | 10 | 8 | 10 km | Happy path — clean dispatch, everyone matched |
| Moderate Traffic | 35 | 35 | 7 km | Balanced — retries, radius expansion 3→5 km |
| Dense — Peak Hour | 70 | 100 | 5 km | Saturation — surge pricing, cancellations, 2–4 AI hotspot clusters |

The Dense preset simulates Whitefield, Bengaluru at peak hour — 100 ride requests in a 5 km zone with 70 drivers. DBSCAN detects 2–4 demand clusters and recommends which idle drivers to reposition.

### Demo Scale Reference

| Factor | Value |
|--------|-------|
| Time compression | 1 real second ≈ 1 minute travel time |
| Location update interval | Every 2 seconds |
| Driver movement step | ±0.0008° (~88m per update) |
| Search radius | 3 km → 5 km on expansion |
| AI loop interval | Every 8 seconds |
| DBSCAN epsilon | 1.5 km cluster radius |
| DBSCAN min_samples | 3 requests to form a cluster |

---

## Project Structure

```
rideflow-ai/
├── backend/
│   ├── app/
│   │   ├── api/
│   │   │   ├── rides.py           # Ride CRUD + state transitions
│   │   │   ├── drivers.py         # Driver registration + location
│   │   │   ├── metrics.py         # System-wide metrics endpoint
│   │   │   ├── websocket.py       # WebSocket endpoints (/ws/admin, /ws/ride, /ws/driver)
│   │   │   ├── demo.py            # Demo simulation endpoints (DEMO_MODE only)
│   │   │   └── ai.py              # AI prediction loop endpoint (DEMO_MODE only)
│   │   ├── services/
│   │   │   ├── ai/
│   │   │   │   └── demand_prediction.py   # DBSCAN clustering + hotspot detection
│   │   │   ├── dispatch/
│   │   │   │   ├── surge.py               # Surge multiplier calculation
│   │   │   │   └── retry.py               # Retry policy + radius expansion
│   │   │   ├── ride/
│   │   │   │   └── state_machine.py       # 7-state FSM with enforced transitions
│   │   │   ├── driver/
│   │   │   │   ├── location.py            # Redis HASH location writes
│   │   │   │   └── status.py              # TTL-based availability
│   │   │   └── websocket/
│   │   │       ├── manager.py             # WebSocket connection registry
│   │   │       └── pubsub.py              # Redis Pub/Sub subscriber + router
│   │   ├── workers/
│   │   │   └── dispatch_task.py           # Celery dispatch task (find, lock, assign)
│   │   ├── models/
│   │   │   ├── ride.py                    # Ride, RideEvent, DispatchLog, DemandPrediction
│   │   │   └── driver.py                  # Driver model
│   │   └── core/
│   │       ├── config.py                  # Settings from env vars
│   │       ├── database.py                # Async PostgreSQL + session factory
│   │       └── redis_client.py            # Redis connection pool
│   ├── alembic/                           # Database migrations
│   ├── requirements.txt
├── infrastructure/
│   └── Dockerfile.backend
│
├── frontend/
│   └── src/
│       ├── pages/
│       │   ├── LandingPage.tsx
│       │   ├── DemoPage.tsx               # Playground — 4-step simulation
│       │   ├── RiderDashboard.tsx
│       │   ├── DriverDashboard.tsx
│       │   ├── AdminDashboard.tsx         # Fleet ops + AI Operations panel
│       │   └── ArchitecturePage.tsx
│       ├── components/
│       │   ├── DispatchMap.tsx            # Leaflet map (drivers, trips, hotspot circles)
│       │   ├── EventLog.tsx               # Live dispatch event feed
│       │   ├── AppNav.tsx
│       │   └── Toast.tsx
│       ├── hooks/
│       │   ├── useWebSocket.ts            # WS connection + reconnect + message routing
│       │   └── useTheme.ts                # Light/dark mode toggle
│       └── api/
│           └── client.ts                  # Axios API client + typed interfaces
│
└── docker-compose.yml
```

---

## API Reference

Interactive docs at `http://localhost:8000/docs` (Swagger UI, auto-generated by FastAPI).

```
# Rides
POST   /api/v1/rides                   Create ride request
GET    /api/v1/rides/{id}              Get ride + current state
PATCH  /api/v1/rides/{id}/cancel       Cancel a ride
PATCH  /api/v1/rides/{id}/arrive       Driver arriving
PATCH  /api/v1/rides/{id}/start        Trip started
PATCH  /api/v1/rides/{id}/complete     Trip completed

# Drivers
POST   /api/v1/drivers                 Register driver
PATCH  /api/v1/drivers/{id}/location   Update GPS location
PATCH  /api/v1/drivers/{id}/status     Toggle availability

# Metrics
GET    /api/v1/metrics                 System-wide counts by status

# WebSocket
WS     /ws/ride/{ride_id}              Rider real-time updates
WS     /ws/driver/{driver_id}          Driver real-time updates
WS     /ws/admin                       Admin + AI alerts stream

# Demo (DEMO_MODE=true only)
POST   /api/demo/seed                  Seed drivers at Bengaluru coordinates
POST   /api/demo/move                  Start location movement loop
POST   /api/demo/requests              Fire bulk ride requests
POST   /api/demo/ai/run                Start DBSCAN hotspot detection loop
POST   /api/demo/ai/stop               Stop AI loop
POST   /api/demo/reset                 Clear all demo data
GET    /api/demo/presets               Available simulation presets
```

---

## AI Layer — DBSCAN Demand Detection

The AI service runs as a background loop triggered from the Playground demo (Step 4).

**How it works:**
1. Queries all unmatched rides (`requested` + `searching_driver` status) from PostgreSQL
2. Extracts pickup coordinates `(lat, lng)`
3. Runs DBSCAN with `eps=1.5km`, `min_samples=3` to find geographic clusters
4. For each cluster: calculates demand, idle driver count (`ST_DWithin`), shortage, confidence
5. Queries 3 nearest idle drivers per hotspot using `ST_Distance`
6. Computes surge multiplier, deploy recommendation, and ETA to resolve
7. Publishes all hotspots as one batch to `ai:alerts` Redis channel
8. WebSocket fans out to Admin Dashboard and Playground simultaneously
9. Repeats every 8 seconds; stops when no unmatched rides remain

**What surfaces in the UI:**
- Red gradient circles on the Playground map (one per hotspot cluster)
- Orange blinking rings on the 3 nearest idle driver markers (reposition targets)
- AI Hotspot Analysis card: zone status, shortage, fare impact, deploy count, nearest drivers
- Admin AI Operations card: fleet-level summary + per-zone recommendations

---

## Docker Commands

```bash
# Build and start all services
docker-compose up --build

# Start without rebuilding
docker-compose up

# Run in background
docker-compose up -d

# View logs
docker-compose logs -f backend
docker-compose logs -f celery-worker

# Stop
docker-compose down

# Full wipe (removes volumes / database)
docker-compose down -v

# Rebuild single service
docker-compose up --build backend
```

---

## Database Commands

```bash
# Connect to PostgreSQL
docker-compose exec postgres psql -U rideflow -d rideflow

# Useful queries
SELECT status, COUNT(*) FROM rides GROUP BY status;
SELECT id, name, status, ST_AsText(location::geometry) FROM drivers;
SELECT * FROM dispatch_logs ORDER BY created_at DESC LIMIT 10;
SELECT event_type, created_at FROM ride_events WHERE ride_id = '<id>';

# Run migrations
docker-compose exec backend alembic upgrade head
```

---

## License

MIT License. See [LICENSE](LICENSE).
