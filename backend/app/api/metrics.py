from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func

from app.core.database import get_db
from app.models.driver import Driver
from app.models.ride import Ride

router = APIRouter(prefix="/api/v1", tags=["metrics"])


@router.get("/metrics")
async def get_metrics(db: AsyncSession = Depends(get_db)):
    driver_res = await db.execute(
        select(Driver.status, func.count(Driver.id).label("n")).group_by(Driver.status)
    )
    ride_res = await db.execute(
        select(Ride.status, func.count(Ride.id).label("n")).group_by(Ride.status)
    )

    d = {row[0]: row[1] for row in driver_res.all()}
    r = {row[0]: row[1] for row in ride_res.all()}

    active_rides = sum(r.get(s, 0) for s in (
        "requested", "searching_driver", "driver_assigned", "driver_arriving", "on_trip"
    ))

    return {
        "drivers": {
            "available": d.get("available", 0),
            "busy":      d.get("busy", 0),
            "offline":   d.get("offline", 0),
            "total":     sum(d.values()),
        },
        "rides": {
            "active":    active_rides,
            "completed": r.get("completed", 0),
            "cancelled": r.get("cancelled", 0),
            "total":     sum(r.values()),
        },
        "by_status": r,
    }
