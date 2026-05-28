"""
Demo simulation endpoints — only mounted when DEMO_MODE=true.

Provides step-by-step simulation control for the recruiter demo:
  POST /api/demo/seed       — register N drivers at Bengaluru GPS coordinates
  POST /api/demo/move       — start random-walk location heartbeat loop
  POST /api/demo/requests   — create N ride requests simultaneously
  POST /api/demo/ai/run     — trigger AI prediction (Phase 5 stub)
  POST /api/demo/reset      — clear all data from DB and Redis
"""
import asyncio
import json
import math
import random
import uuid

from fastapi import APIRouter, Depends
from geoalchemy2 import WKTElement
from pydantic import BaseModel
from redis.asyncio import Redis
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.redis_client import get_redis
from app.models.driver import Driver
from app.models.ride import Ride
from app.services.dispatch.surge import compute_surge_multiplier
from app.services.ride.state_machine import transition

router = APIRouter(prefix="/api/demo", tags=["demo"])

# ── Realistic demo data ────────────────────────────────────────────────────

# 45 unique Indian driver names with realistic phone numbers
DEMO_DRIVER_POOL = [
    ("Rajesh Kumar",      "+91-9876541001"),
    ("Priya Sharma",      "+91-9876541002"),
    ("Amit Singh",        "+91-9876541003"),
    ("Neha Patel",        "+91-9876541004"),
    ("Suresh Nair",       "+91-9876541005"),
    ("Kavitha Reddy",     "+91-9876541006"),
    ("Mohammed Irfan",    "+91-9876541007"),
    ("Sunita Verma",      "+91-9876541008"),
    ("Vikram Rao",        "+91-9876541009"),
    ("Ananya Iyer",       "+91-9876541010"),
    ("Ravi Shankar",      "+91-9876541011"),
    ("Deepa Menon",       "+91-9876541012"),
    ("Arjun Mehta",       "+91-9876541013"),
    ("Pooja Gupta",       "+91-9876541014"),
    ("Sanjay Mishra",     "+91-9876541015"),
    ("Meera Joshi",       "+91-9876541016"),
    ("Kiran Bhat",        "+91-9876541017"),
    ("Rohit Desai",       "+91-9876541018"),
    ("Lakshmi Pillai",    "+91-9876541019"),
    ("Nikhil Tiwari",     "+91-9876541020"),
    ("Priyanka Das",      "+91-9876541021"),
    ("Ajay Khanna",       "+91-9876541022"),
    ("Smita Kulkarni",    "+91-9876541023"),
    ("Varun Saxena",      "+91-9876541024"),
    ("Anita Sinha",       "+91-9876541025"),
    ("Manish Agarwal",    "+91-9876541026"),
    ("Rekha Choudhury",   "+91-9876541027"),
    ("Gaurav Jain",       "+91-9876541028"),
    ("Shobha Rao",        "+91-9876541029"),
    ("Dinesh Malhotra",   "+91-9876541030"),
    ("Hemant Dubey",      "+91-9876541031"),
    ("Asha Kapoor",       "+91-9876541032"),
    ("Santosh Pandey",    "+91-9876541033"),
    ("Divya Nair",        "+91-9876541034"),
    ("Sunil Garg",        "+91-9876541035"),
    ("Preeti Sharma",     "+91-9876541036"),
    ("Rahul Bajaj",       "+91-9876541037"),
    ("Geeta Pillai",      "+91-9876541038"),
    ("Ashok Tiwari",      "+91-9876541039"),
    ("Nisha Chandra",     "+91-9876541040"),
    ("Praveen Reddy",     "+91-9876541041"),
    ("Bhavna Joshi",      "+91-9876541042"),
    ("Vijay Rajan",       "+91-9876541043"),
    ("Swati Deshmukh",    "+91-9876541044"),
    ("Arun Kumar",        "+91-9876541045"),
]

# 10 distinct rider UUIDs so seeded rides look like different passengers
DEMO_RIDER_POOL = [
    uuid.UUID(f"00000000-0000-0000-0000-{i:012d}") for i in range(1, 11)
]

# Named rider labels for display in events
DEMO_RIDER_NAMES = [
    "Aryan Kapoor", "Sonia Mehta", "Kabir Sharma", "Ishaan Reddy",
    "Mia Verma", "Rohan Nair", "Zara Gupta", "Dev Patel",
    "Avni Singh", "Harsh Joshi",
]

PRESETS: dict[str, dict] = {
    "light": {
        "label": "Light Traffic",
        "description": "10 drivers spread across 10 km radius. 8 simultaneous requests.",
        "what_it_shows": "Happy path: clean dispatch, sub-second assignment, no retries needed.",
        "supply_demand": "1.25x (supply > demand)",
        "center_lat": 12.9716,
        "center_lng": 77.5946,
        "radius_km": 10.0,
        "driver_count": 10,
        "request_count": 8,
    },
    "moderate": {
        "label": "Moderate Traffic",
        "description": "35 drivers in 7 km radius. 35 simultaneous requests.",
        "what_it_shows": "Dispatch retries, radius expansion from 3 km to 5 km, queue latency under balanced load.",
        "supply_demand": "1.0x (balanced)",
        "center_lat": 12.9716,
        "center_lng": 77.5946,
        "radius_km": 7.0,
        "driver_count": 35,
        "request_count": 35,
    },
    "dense": {
        "label": "Dense — Peak Hour",
        "description": "70 drivers in 5 km radius (Whitefield, Bengaluru). 100 simultaneous requests.",
        "what_it_shows": "Queue saturation, surge pricing, SELECT FOR UPDATE race prevention, multiple AI hotspot clusters.",
        "supply_demand": "0.7x (demand exceeds supply)",
        "center_lat": 12.9698,
        "center_lng": 77.7500,
        "radius_km": 5.0,
        "driver_count": 70,
        "request_count": 100,
    },
}

_movement_task: asyncio.Task | None = None


# ── Helpers ───────────────────────────────────────────────────────────────

def _random_coord(center_lat: float, center_lng: float, radius_km: float) -> tuple[float, float]:
    """Uniform random point inside a circle of radius_km."""
    r = (radius_km / 111.0) * math.sqrt(random.random())
    angle = random.uniform(0, 2 * math.pi)
    lat = center_lat + r * math.cos(angle)
    lng = center_lng + r * math.sin(angle) / math.cos(math.radians(center_lat))
    return round(lat, 6), round(lng, 6)


# ── Endpoints ─────────────────────────────────────────────────────────────

class PresetRequest(BaseModel):
    preset: str = "light"


@router.get("/presets")
async def list_presets() -> dict:
    """Return available simulation presets with descriptions."""
    return {
        key: {k: v for k, v in val.items() if k not in ("center_lat", "center_lng")}
        for key, val in PRESETS.items()
    }


@router.post("/seed")
async def seed_drivers(
    body: PresetRequest,
    db: AsyncSession = Depends(get_db),
    redis: Redis = Depends(get_redis),
) -> dict:
    """
    Register N drivers at GPS coordinates for the chosen preset.
    Uses realistic Indian names and formatted phone numbers.
    Sets each driver to 'available' and writes location to Redis and PostGIS.
    """
    cfg = PRESETS.get(body.preset)
    if not cfg:
        return {"error": f"Unknown preset '{body.preset}'. Valid: light, moderate, dense"}

    existing = await redis.scard("demo:driver_ids")
    if existing > 0:
        return {"error": "Drivers already seeded. Run /reset first to start fresh."}

    driver_count = cfg["driver_count"]
    # Shuffle and pick names; cycle if needed for dense (45 drivers)
    pool = DEMO_DRIVER_POOL[:]
    random.shuffle(pool)
    while len(pool) < driver_count:
        pool.extend(DEMO_DRIVER_POOL)

    driver_ids: list[str] = []
    driver_summaries: list[dict] = []
    # Unique 3-digit tag per seed run so phones never collide with stale DB rows
    run_tag = random.randint(100, 999)

    for i in range(driver_count):
        lat, lng = _random_coord(cfg["center_lat"], cfg["center_lng"], cfg["radius_km"])
        name, phone = pool[i]
        unique_phone = f"{phone}-{run_tag}-{i}"

        driver = Driver(
            name=name,
            phone=unique_phone,
            status="available",
        )
        db.add(driver)
        await db.flush()

        loc_key = f"driver:location:{driver.id}"
        await redis.hset(loc_key, mapping={"lat": str(lat), "lng": str(lng)})
        await redis.expire(loc_key, 600)

        driver.location = WKTElement(f"POINT({lng} {lat})", srid=4326)
        driver_ids.append(str(driver.id))
        driver_summaries.append({
            "id": str(driver.id),
            "name": name,
            "phone": unique_phone,
            "lat": lat,
            "lng": lng,
            "status": "available",
        })

    await db.commit()

    await redis.sadd("demo:driver_ids", *driver_ids)
    await redis.expire("demo:driver_ids", 3600)

    return {
        "seeded": len(driver_ids),
        "preset": body.preset,
        "label": cfg["label"],
        "zone": f"{cfg['radius_km']} km radius around ({cfg['center_lat']}, {cfg['center_lng']})",
        "drivers": driver_summaries,
        "message": (
            f"{len(driver_ids)} drivers registered and set to AVAILABLE. "
            f"Locations written to Redis (TTL=600s) and PostGIS (for ST_DWithin dispatch queries)."
        ),
    }


@router.post("/move")
async def start_movement(redis: Redis = Depends(get_redis)) -> dict:
    """
    Start a background loop that moves each demo driver by a small random amount
    every 4 seconds — simulating real driver heartbeats.
    """
    global _movement_task

    if _movement_task and not _movement_task.done():
        return {"message": "Movement simulation is already running."}

    count = await redis.scard("demo:driver_ids")
    if count == 0:
        return {"error": "No demo drivers found. Run /seed first."}

    _movement_task = asyncio.create_task(_movement_loop())

    return {
        "message": f"Location heartbeat started for {count} drivers. Updating every 4 seconds.",
        "detail": (
            "Each update writes to Redis and publishes to the admin:metrics channel. "
            "The admin dashboard map will show drivers moving in real time."
        ),
    }


async def _movement_loop() -> None:
    """Long-running async task: moves demo drivers every 4 seconds."""
    from app.core.redis_client import get_redis as _get_redis
    redis = await _get_redis()
    while True:
        try:
            driver_ids = await redis.smembers("demo:driver_ids")
            if not driver_ids:
                break
            for driver_id in driver_ids:
                loc = await redis.hgetall(f"driver:location:{driver_id}")
                if not loc:
                    continue
                lat = float(loc["lat"]) + random.uniform(-0.0008, 0.0008)
                lng = float(loc["lng"]) + random.uniform(-0.0008, 0.0008)
                await redis.hset(
                    f"driver:location:{driver_id}",
                    mapping={"lat": str(round(lat, 6)), "lng": str(round(lng, 6))},
                )
                await redis.expire(f"driver:location:{driver_id}", 600)
                await redis.publish(
                    "admin:metrics",
                    json.dumps({
                        "event": "driver_location",
                        "driver_id": driver_id,
                        "lat": lat,
                        "lng": lng,
                    }),
                )
            await asyncio.sleep(2)
        except asyncio.CancelledError:
            break
        except Exception:
            await asyncio.sleep(2)


@router.post("/requests")
async def create_ride_requests(
    body: PresetRequest,
    db: AsyncSession = Depends(get_db),
    redis: Redis = Depends(get_redis),
) -> dict:
    """
    Create N ride requests simultaneously in the preset zone.
    Each ride uses a distinct rider ID and realistic pickup/destination coordinates.
    """
    from app.workers.dispatch_task import _dispatch as _dispatch_async

    cfg = PRESETS.get(body.preset)
    if not cfg:
        return {"error": f"Unknown preset '{body.preset}'. Valid: light, moderate, dense"}

    ride_ids: list[str] = []
    ride_summaries: list[dict] = []

    for i in range(cfg["request_count"]):
        rider_id = DEMO_RIDER_POOL[i % len(DEMO_RIDER_POOL)]
        rider_name = DEMO_RIDER_NAMES[i % len(DEMO_RIDER_NAMES)]

        pickup_lat, pickup_lng = _random_coord(cfg["center_lat"], cfg["center_lng"], cfg["radius_km"])
        dest_lat, dest_lng = _random_coord(
            cfg["center_lat"], cfg["center_lng"], cfg["radius_km"] * 1.5
        )
        surge = await compute_surge_multiplier(pickup_lat, pickup_lng, db)
        ride = Ride(
            rider_id=rider_id,
            pickup_location=WKTElement(f"POINT({pickup_lng} {pickup_lat})", srid=4326),
            destination=WKTElement(f"POINT({dest_lng} {dest_lat})", srid=4326),
            surge_multiplier=surge,
        )
        db.add(ride)
        await db.flush()
        ride_ids.append(str(ride.id))
        ride_summaries.append({
            "id": str(ride.id),
            "rider_id": str(rider_id),
            "rider_name": rider_name,
            "pickup_lat": pickup_lat,
            "pickup_lng": pickup_lng,
            "dest_lat": dest_lat,
            "dest_lng": dest_lng,
            "surge_multiplier": surge,
        })

    await db.commit()

    for ride_id_str in ride_ids:
        rid = uuid.UUID(ride_id_str)
        await transition(rid, "searching_driver", db)

    for i, ride_id_str in enumerate(ride_ids):
        rider_name = ride_summaries[i]["rider_name"]
        surge = ride_summaries[i]["surge_multiplier"]
        event = {
            "event": "ride_searching",
            "stage": "queued_for_dispatch",
            "ride_id": ride_id_str,
            "rider_name": rider_name,
            "surge_multiplier": surge,
            "message_plain": f"Ride for {rider_name} entered queue. Dispatch worker starting nearest-driver search.",
            "message_tech": f"status=searching_driver · surge={surge}x · task=_dispatch scheduled",
        }
        await redis.publish("admin:metrics", json.dumps(event))

    for ride_id_str in ride_ids:
        asyncio.create_task(_dispatch_async(ride_id_str))

    return {
        "created": len(ride_ids),
        "preset": body.preset,
        "rides": ride_summaries,
        "message": (
            f"{len(ride_ids)} ride requests created for {len(set(r['rider_name'] for r in ride_summaries))} unique riders. "
            f"Dispatch running in parallel — each task queries PostGIS ST_DWithin "
            f"for nearest available driver. Watch Admin dashboard for assignments."
        ),
    }


@router.post("/reset")
async def reset_demo(
    db: AsyncSession = Depends(get_db),
    redis: Redis = Depends(get_redis),
) -> dict:
    """Clear all rides, drivers, and predictions. Returns system to clean state."""
    global _movement_task

    if _movement_task and not _movement_task.done():
        _movement_task.cancel()
        _movement_task = None

    from app.api.ai import stop_ai_loop
    stop_ai_loop()

    await db.execute(text("UPDATE drivers SET active_ride_id = NULL"))
    await db.execute(text("UPDATE rides SET driver_id = NULL"))

    await db.execute(text("DELETE FROM ride_events"))
    await db.execute(text("DELETE FROM dispatch_logs"))
    await db.execute(text("DELETE FROM demand_predictions"))
    await db.execute(text("DELETE FROM rides"))
    await db.execute(text("DELETE FROM drivers"))
    await db.commit()

    driver_keys = await redis.keys("driver:location:*")
    if driver_keys:
        await redis.delete(*driver_keys)
    await redis.delete("demo:driver_ids")

    return {
        "status": "reset",
        "message": "All rides, drivers, and simulation state cleared. Ready to seed again.",
    }
