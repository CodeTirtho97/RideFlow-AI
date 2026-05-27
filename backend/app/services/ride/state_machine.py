from __future__ import annotations

import uuid

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.ride import Ride
from app.services.ride.events import append_event

# Every valid state transition. Anything not listed here is illegal.
VALID_TRANSITIONS: dict[str, set[str]] = {
    "requested":        {"searching_driver", "cancelled"},
    "searching_driver": {"driver_assigned",  "cancelled"},
    "driver_assigned":  {"driver_arriving",  "cancelled"},
    "driver_arriving":  {"on_trip",          "cancelled"},
    "on_trip":          {"completed"},
    "completed":        set(),
    "cancelled":        set(),
}


async def transition(
    ride_id: uuid.UUID,
    new_status: str,
    db: AsyncSession,
    payload: dict | None = None,
) -> Ride:
    """
    Atomically move a ride to `new_status` and append an event log entry.
    Raises ValueError if the transition is not in VALID_TRANSITIONS.
    Uses SELECT FOR UPDATE so concurrent workers don't race on the same ride.
    """
    result = await db.execute(
        select(Ride).where(Ride.id == ride_id).with_for_update()
    )
    ride = result.scalar_one()

    allowed = VALID_TRANSITIONS.get(ride.status, set())
    if new_status not in allowed:
        raise ValueError(
            f"Invalid transition: '{ride.status}' -> '{new_status}'"
        )

    await db.execute(update(Ride).where(Ride.id == ride_id).values(status=new_status))
    await append_event(
        ride_id=ride_id,
        event_type=f"status_changed:{new_status}",
        payload=payload,
        db=db,
    )
    await db.commit()

    result = await db.execute(select(Ride).where(Ride.id == ride_id))
    return result.scalar_one()
