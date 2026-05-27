import uuid

from geoalchemy2 import WKTElement
from redis.asyncio import Redis
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.driver import Driver

LOCATION_TTL_SECONDS = 30
_KEY = "driver:location:{driver_id}"


async def set_driver_location(
    driver_id: uuid.UUID, lat: float, lng: float, redis: Redis, db: AsyncSession
) -> None:
    key = _KEY.format(driver_id=driver_id)
    await redis.hset(key, mapping={"lat": str(lat), "lng": str(lng)})
    await redis.expire(key, LOCATION_TTL_SECONDS)
    # Mirror to Postgres so PostGIS dispatch queries stay current.
    # WKT uses (longitude latitude) order per the WGS84 convention.
    point = WKTElement(f"POINT({lng} {lat})", srid=4326)
    await db.execute(update(Driver).where(Driver.id == driver_id).values(location=point))
    await db.commit()


async def get_driver_location(driver_id: uuid.UUID, redis: Redis) -> dict | None:
    key = _KEY.format(driver_id=driver_id)
    data = await redis.hgetall(key)
    if not data:
        return None
    return {"lat": float(data["lat"]), "lng": float(data["lng"])}


async def is_location_fresh(driver_id: uuid.UUID, redis: Redis) -> bool:
    """True if the driver sent a location heartbeat within the last TTL window."""
    return await redis.exists(_KEY.format(driver_id=driver_id)) == 1
