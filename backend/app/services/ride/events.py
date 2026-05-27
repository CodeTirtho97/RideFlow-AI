import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.ride import RideEvent


async def append_event(
    ride_id: uuid.UUID,
    event_type: str,
    payload: dict | None,
    db: AsyncSession,
) -> None:
    """
    Insert an immutable record of a ride lifecycle event.
    Uses flush() not commit() — the caller owns the transaction boundary.
    """
    db.add(RideEvent(ride_id=ride_id, event_type=event_type, payload=payload))
    await db.flush()
