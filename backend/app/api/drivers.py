import json
import math
import random
import time
import uuid

from fastapi import APIRouter, Body, Depends, HTTPException, status
from geoalchemy2 import WKTElement
from pydantic import BaseModel, Field
from redis.asyncio import Redis
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.redis_client import get_redis
from app.models.driver import Driver
from app.services.driver import location as location_svc
from app.services.driver import status as status_svc

router = APIRouter(prefix="/api/v1/drivers", tags=["drivers"])

_SEED_NAMES = [
    "Karan Mehta", "Divya Sharma", "Arjun Nair", "Priya Reddy",
    "Suresh Kumar", "Kavya Pillai", "Vikram Rao", "Sneha Joshi",
    "Rahul Verma", "Aarti Singh",
]

_SEED_LOCATIONS = [
    (12.9758, 77.6045), (12.9352, 77.6245), (12.9784, 77.6408),
    (12.9116, 77.6389), (12.9698, 77.7500), (12.9591, 77.6974),
    (12.8450, 77.6601), (13.0354, 77.5970), (12.9258, 77.5936),
    (12.9166, 77.6101),
]


class SeedRequest(BaseModel):
    near_lat: float | None = None
    near_lng: float | None = None


class DriverRegisterRequest(BaseModel):
    name: str = Field(..., min_length=1)
    phone: str = Field(..., min_length=5)


class LocationUpdateRequest(BaseModel):
    lat: float = Field(..., ge=-90, le=90)
    lng: float = Field(..., ge=-180, le=180)


class StatusUpdateRequest(BaseModel):
    status: str = Field(..., pattern="^(available|offline)$")


@router.get("")
async def list_available_drivers(db: AsyncSession = Depends(get_db)):
    """Return all available drivers with their last-known GPS coordinates."""
    rows = (await db.execute(
        text("""
            SELECT id, name,
                   ST_Y(location::geometry) AS lat,
                   ST_X(location::geometry) AS lng
            FROM drivers
            WHERE status = 'available'
              AND location IS NOT NULL
            ORDER BY name
        """)
    )).fetchall()
    return [{"id": str(r.id), "name": r.name, "lat": r.lat, "lng": r.lng} for r in rows]


def _random_nearby(center_lat: float, center_lng: float, radius_km: float = 1.8) -> tuple[float, float]:
    """Uniform random point inside radius_km of the given coordinates."""
    r = (radius_km / 111.0) * math.sqrt(random.random())
    angle = random.uniform(0, 2 * math.pi)
    lat = center_lat + r * math.cos(angle)
    lng = center_lng + r * math.sin(angle) / math.cos(math.radians(center_lat))
    return round(lat, 6), round(lng, 6)


@router.post("/seed", status_code=status.HTTP_201_CREATED)
async def seed_quick_drivers(
    body: SeedRequest = Body(default=SeedRequest()),
    db: AsyncSession = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    """Create 10 demo drivers for the rider demo.

    If near_lat/near_lng are provided, the first 3 drivers are placed within
    ~1.8 km of those coordinates to guarantee dispatch succeeds within 3 km.
    The remaining 7 are scattered across Bengaluru landmarks as usual.
    """
    run_tag = str(int(time.time()))
    locs = list(_SEED_LOCATIONS)
    random.shuffle(locs)
    created = []

    for i, (name, (base_lat, base_lng)) in enumerate(zip(_SEED_NAMES, locs)):
        # First 3 drivers placed near rider's pickup so dispatch always finds one
        if i < 3 and body.near_lat is not None and body.near_lng is not None:
            lat, lng = _random_nearby(body.near_lat, body.near_lng)
        else:
            lat = round(base_lat + (random.random() - 0.5) * 0.004, 6)
            lng = round(base_lng + (random.random() - 0.5) * 0.004, 6)

        phone = f"+91-qs-{run_tag}-{i}"

        driver = Driver(name=name, phone=phone, status="available")
        db.add(driver)
        await db.flush()

        driver.location = WKTElement(f"POINT({lng} {lat})", srid=4326)
        loc_key = f"driver:location:{driver.id}"
        await redis.hset(loc_key, mapping={"lat": str(lat), "lng": str(lng)})
        await redis.expire(loc_key, 600)

        created.append({"id": str(driver.id), "name": name, "lat": lat, "lng": lng})

    await db.commit()
    return {"seeded": len(created), "drivers": created}


@router.post("", status_code=status.HTTP_201_CREATED)
async def register_driver(
    body: DriverRegisterRequest, db: AsyncSession = Depends(get_db)
):
    driver = Driver(name=body.name, phone=body.phone)
    db.add(driver)
    await db.commit()
    return {
        "id": str(driver.id),
        "name": driver.name,
        "phone": driver.phone,
        "status": driver.status,
    }


@router.get("/{driver_id}")
async def get_driver(
    driver_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    result = await db.execute(select(Driver).where(Driver.id == driver_id))
    driver = result.scalar_one_or_none()
    if not driver:
        raise HTTPException(status_code=404, detail="Driver not found")
    location_fresh = await location_svc.is_location_fresh(driver_id, redis)
    return {
        "id": str(driver.id),
        "name": driver.name,
        "status": driver.status,
        "active_ride_id": str(driver.active_ride_id) if driver.active_ride_id else None,
        "location_fresh": location_fresh,
    }


@router.patch("/{driver_id}/location")
async def update_location(
    driver_id: uuid.UUID,
    body: LocationUpdateRequest,
    db: AsyncSession = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    result = await db.execute(select(Driver).where(Driver.id == driver_id))
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Driver not found")
    await location_svc.set_driver_location(driver_id, body.lat, body.lng, redis, db)

    driver_id_str = str(driver_id)
    location_event = {"event": "location_update", "driver_id": driver_id_str, "lat": body.lat, "lng": body.lng}
    await redis.publish(f"driver:{driver_id_str}", json.dumps(location_event))
    await redis.publish("admin:metrics", json.dumps({"event": "driver_location", "driver_id": driver_id_str, "lat": body.lat, "lng": body.lng}))

    return {"ok": True}


@router.patch("/{driver_id}/status")
async def update_status(
    driver_id: uuid.UUID,
    body: StatusUpdateRequest,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Driver).where(Driver.id == driver_id))
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Driver not found")
    try:
        driver = await status_svc.set_driver_status(driver_id, body.status, db)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return {"id": str(driver.id), "name": driver.name, "status": driver.status}
