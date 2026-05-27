import uuid

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.driver import Driver

VALID_STATUSES = {"available", "busy", "offline"}
_LOCATION_KEY = "driver:location:{driver_id}"


async def set_driver_status(driver_id: uuid.UUID, status: str, db: AsyncSession) -> Driver:
    if status not in VALID_STATUSES:
        raise ValueError(f"Invalid driver status: {status!r}")
    await db.execute(update(Driver).where(Driver.id == driver_id).values(status=status))
    await db.commit()
    result = await db.execute(select(Driver).where(Driver.id == driver_id))
    return result.scalar_one()


async def sync_offline_if_stale(driver_id: uuid.UUID, db: AsyncSession) -> bool:
    """
    If the driver's Redis location key has expired (TTL = 0), mark them offline
    in Postgres. Returns True if the driver was offlined by this call.

    Called by the dispatch engine before querying available drivers so stale
    'available' rows don't pollute the candidate list.
    """
    from app.core.redis_client import get_redis

    redis = await get_redis()
    key_exists = await redis.exists(_LOCATION_KEY.format(driver_id=driver_id))
    if key_exists:
        return False

    result = await db.execute(select(Driver).where(Driver.id == driver_id))
    driver = result.scalar_one_or_none()
    if driver and driver.status == "available":
        await db.execute(
            update(Driver).where(Driver.id == driver_id).values(status="offline")
        )
        await db.commit()
        return True
    return False
