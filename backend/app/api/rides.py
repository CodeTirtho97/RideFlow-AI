import asyncio
import json
import math
import time
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from geoalchemy2 import WKTElement
from pydantic import BaseModel, Field
from redis.asyncio import Redis
from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_db
from app.core.redis_client import get_redis
from app.models.driver import Driver
from app.models.ride import Ride, RideEvent
from app.services.dispatch.surge import compute_surge_multiplier
from app.services.ride.state_machine import transition

router = APIRouter(prefix="/api/v1/rides", tags=["rides"])


def _haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = (math.sin(dlat / 2) ** 2
         + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlng / 2) ** 2)
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


class RideCreateRequest(BaseModel):
    rider_id: uuid.UUID
    pickup_lat: float = Field(..., ge=-90, le=90)
    pickup_lng: float = Field(..., ge=-180, le=180)
    destination_lat: float = Field(..., ge=-90, le=90)
    destination_lng: float = Field(..., ge=-180, le=180)


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_ride(body: RideCreateRequest, db: AsyncSession = Depends(get_db)):
    surge = await compute_surge_multiplier(body.pickup_lat, body.pickup_lng, db)

    ride = Ride(
        rider_id=body.rider_id,
        pickup_location=WKTElement(
            f"POINT({body.pickup_lng} {body.pickup_lat})", srid=4326
        ),
        destination=WKTElement(
            f"POINT({body.destination_lng} {body.destination_lat})", srid=4326
        ),
        surge_multiplier=surge,
    )
    db.add(ride)
    await db.commit()

    ride = await transition(ride.id, "searching_driver", db)

    redis_client = await get_redis()
    ride_event = {
        "event": "ride_created",
        "stage": "ride_created",
        "ride_id": str(ride.id),
        "rider_id": str(body.rider_id),
        "pickup_lat": round(body.pickup_lat, 4),
        "pickup_lng": round(body.pickup_lng, 4),
        "dest_lat": round(body.destination_lat, 4),
        "dest_lng": round(body.destination_lng, 4),
        "surge_multiplier": surge,
        "message_plain": "Ride request created. Dispatch engine searching for nearest driver.",
        "message_tech": f"status=requested → searching_driver · surge={surge}x",
    }
    await redis_client.publish("admin:metrics", json.dumps(ride_event))

    if settings.demo_mode:
        from app.workers.dispatch_task import _dispatch as _dispatch_async
        asyncio.create_task(_dispatch_async(str(ride.id)))
    else:
        from app.workers.dispatch_task import dispatch_ride
        dispatch_ride.delay(str(ride.id))

    return {
        "id": str(ride.id),
        "status": ride.status,
        "surge_multiplier": ride.surge_multiplier,
    }


@router.get("/{ride_id}")
async def get_ride(ride_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Ride).where(Ride.id == ride_id))
    ride = result.scalar_one_or_none()
    if not ride:
        raise HTTPException(status_code=404, detail="Ride not found")

    coord_row = (await db.execute(
        text("""
            SELECT
                ST_Y(pickup_location::geometry) AS pickup_lat,
                ST_X(pickup_location::geometry) AS pickup_lng,
                ST_Y(destination::geometry)     AS dest_lat,
                ST_X(destination::geometry)     AS dest_lng
            FROM rides WHERE id = :ride_id
        """).bindparams(ride_id=ride_id)
    )).fetchone()

    # Resolve driver name if a driver is assigned
    driver_name = None
    if ride.driver_id:
        d_row = (await db.execute(
            select(Driver.name).where(Driver.id == ride.driver_id)
        )).scalar_one_or_none()
        driver_name = d_row

    return {
        "id": str(ride.id),
        "rider_id": str(ride.rider_id),
        "driver_id": str(ride.driver_id) if ride.driver_id else None,
        "driver_name": driver_name,
        "status": ride.status,
        "surge_multiplier": ride.surge_multiplier,
        "fare_estimate": ride.fare_estimate,
        "created_at": ride.created_at.isoformat(),
        "updated_at": ride.updated_at.isoformat() if ride.updated_at else None,
        "pickup_lat": coord_row.pickup_lat if coord_row else None,
        "pickup_lng": coord_row.pickup_lng if coord_row else None,
        "dest_lat": coord_row.dest_lat if coord_row else None,
        "dest_lng": coord_row.dest_lng if coord_row else None,
    }


@router.patch("/{ride_id}/cancel")
async def cancel_ride(
    ride_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    result = await db.execute(select(Ride).where(Ride.id == ride_id))
    ride_row = result.scalar_one_or_none()
    if not ride_row:
        raise HTTPException(status_code=404, detail="Ride not found")
    driver_id = ride_row.driver_id  # capture before transition clears it
    try:
        ride = await transition(ride_id, "cancelled", db)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

    # Free the driver if one was assigned — prevents them being stuck as busy
    if driver_id:
        await db.execute(
            update(Driver).where(Driver.id == driver_id).values(status="available", active_ride_id=None)
        )
        await db.commit()

    ride_id_str = str(ride_id)
    cancel_event = {
        "event": "ride_cancelled",
        "ride_id": ride_id_str,
        "reason": "rider_cancelled",
        "message_plain": "Ride was cancelled by rider request.",
        "message_tech": "state=cancelled · reason=rider_cancelled",
    }
    await redis.publish(f"dispatch:{ride_id_str}", json.dumps(cancel_event))
    await redis.publish("admin:metrics", json.dumps(cancel_event))

    return {"id": str(ride.id), "status": ride.status}


@router.patch("/{ride_id}/arrive")
async def driver_arriving(
    ride_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    """Driver is on the way to pickup — transitions ride to driver_arriving."""
    result = await db.execute(select(Ride).where(Ride.id == ride_id))
    ride_row = result.scalar_one_or_none()
    if not ride_row:
        raise HTTPException(status_code=404, detail="Ride not found")

    driver_name = None
    if ride_row.driver_id:
        driver_name = (await db.execute(
            select(Driver.name).where(Driver.id == ride_row.driver_id)
        )).scalar_one_or_none()

    try:
        ride = await transition(ride_id, "driver_arriving", db,
                                payload={"driver_name": driver_name})
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

    ride_id_str = str(ride_id)
    event = {
        "event": "status_update",
        "status": "driver_arriving",
        "ride_id": ride_id_str,
        "driver_id": str(ride_row.driver_id) if ride_row.driver_id else None,
        "driver_name": driver_name,
        "message_plain": f"{driver_name or 'Driver'} is on the way to pickup.",
        "message_tech": "state=driver_arriving",
    }
    await redis.publish(f"dispatch:{ride_id_str}", json.dumps(event))
    await redis.publish("admin:metrics", json.dumps(event))
    return {"id": str(ride.id), "status": ride.status}


@router.patch("/{ride_id}/start")
async def start_trip(
    ride_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    """Driver picked up rider — transitions ride to on_trip. Records trip start time in event."""
    result = await db.execute(select(Ride).where(Ride.id == ride_id))
    ride_row = result.scalar_one_or_none()
    if not ride_row:
        raise HTTPException(status_code=404, detail="Ride not found")

    driver_name = None
    if ride_row.driver_id:
        driver_name = (await db.execute(
            select(Driver.name).where(Driver.id == ride_row.driver_id)
        )).scalar_one_or_none()

    trip_started_at = time.time()
    try:
        ride = await transition(ride_id, "on_trip", db,
                                payload={
                                    "driver_name": driver_name,
                                    "trip_started_at": trip_started_at,
                                })
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

    ride_id_str = str(ride_id)
    event = {
        "event": "status_update",
        "status": "on_trip",
        "ride_id": ride_id_str,
        "driver_id": str(ride_row.driver_id) if ride_row.driver_id else None,
        "driver_name": driver_name,
        "message_plain": f"Rider picked up by {driver_name or 'driver'}. Trip in progress.",
        "message_tech": "state=on_trip · fare meter running",
    }
    await redis.publish(f"dispatch:{ride_id_str}", json.dumps(event))
    await redis.publish("admin:metrics", json.dumps(event))
    return {"id": str(ride.id), "status": ride.status}


@router.patch("/{ride_id}/complete")
async def complete_trip(
    ride_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    """Trip ended — computes fare, transitions to completed, frees the driver, returns receipt."""
    result = await db.execute(select(Ride).where(Ride.id == ride_id))
    ride_row = result.scalar_one_or_none()
    if not ride_row:
        raise HTTPException(status_code=404, detail="Ride not found")

    driver_id = ride_row.driver_id

    driver_name = None
    if driver_id:
        driver_name = (await db.execute(
            select(Driver.name).where(Driver.id == driver_id)
        )).scalar_one_or_none()

    # Fetch coordinates for distance calculation
    coord_row = (await db.execute(
        text("""
            SELECT
                ST_Y(pickup_location::geometry) AS pickup_lat,
                ST_X(pickup_location::geometry) AS pickup_lng,
                ST_Y(destination::geometry)     AS dest_lat,
                ST_X(destination::geometry)     AS dest_lng
            FROM rides WHERE id = :ride_id
        """).bindparams(ride_id=ride_id)
    )).fetchone()

    pickup_lat = coord_row.pickup_lat if coord_row else 0.0
    pickup_lng = coord_row.pickup_lng if coord_row else 0.0
    dest_lat = coord_row.dest_lat if coord_row else 0.0
    dest_lng = coord_row.dest_lng if coord_row else 0.0
    distance_km = round(_haversine_km(pickup_lat, pickup_lng, dest_lat, dest_lng), 2)

    # Find trip start time from the on_trip event payload
    on_trip_event = (await db.execute(
        select(RideEvent)
        .where(RideEvent.ride_id == ride_id, RideEvent.event_type == "status_changed:on_trip")
        .order_by(RideEvent.created_at.desc())
        .limit(1)
    )).scalar_one_or_none()

    now_ts = time.time()
    if on_trip_event and on_trip_event.payload and "trip_started_at" in on_trip_event.payload:
        trip_started_at = float(on_trip_event.payload["trip_started_at"])
        duration_seconds = int(now_ts - trip_started_at)
    elif on_trip_event:
        # Fall back to event timestamp
        duration_seconds = int(now_ts - on_trip_event.created_at.timestamp())
    else:
        duration_seconds = 0

    # Display minutes: 1 real second = 1 minute in scaled demo time
    duration_display_min = duration_seconds

    surge = float(ride_row.surge_multiplier or 1.0)
    base_fare = 50.0
    distance_charge = round(12.0 * distance_km, 2)
    time_charge = round(2.0 * duration_display_min, 2)
    total_fare = round((base_fare + distance_charge + time_charge) * surge, 2)

    await db.execute(
        update(Ride).where(Ride.id == ride_id).values(fare_estimate=total_fare)
    )
    await db.commit()

    try:
        ride = await transition(ride_id, "completed", db, payload={
            "fare": total_fare,
            "distance_km": distance_km,
            "duration_seconds": duration_seconds,
            "duration_display_min": duration_display_min,
        })
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

    if driver_id:
        await db.execute(
            update(Driver)
            .where(Driver.id == driver_id)
            .values(status="available", active_ride_id=None)
        )
        await db.commit()

    ride_id_str = str(ride_id)
    receipt = {
        "driver_id": str(driver_id) if driver_id else None,
        "driver_name": driver_name,
        "pickup_lat": round(pickup_lat, 4),
        "pickup_lng": round(pickup_lng, 4),
        "dest_lat": round(dest_lat, 4),
        "dest_lng": round(dest_lng, 4),
        "distance_km": distance_km,
        "duration_seconds": duration_seconds,
        "duration_display_min": duration_display_min,
        "base_fare": base_fare,
        "distance_charge": distance_charge,
        "time_charge": time_charge,
        "surge_multiplier": surge,
        "fare_estimate": total_fare,
    }

    event = {
        "event": "ride_completed",
        "status": "completed",
        "ride_id": ride_id_str,
        "driver_id": str(driver_id) if driver_id else None,
        "driver_name": driver_name,
        "fare": total_fare,
        "base_fare": base_fare,
        "distance_charge": distance_charge,
        "time_charge": time_charge,
        "distance_km": distance_km,
        "duration_seconds": duration_seconds,
        "duration_display_min": duration_display_min,
        "surge_multiplier": surge,
        "pickup_lat": round(pickup_lat, 4),
        "pickup_lng": round(pickup_lng, 4),
        "dest_lat": round(dest_lat, 4),
        "dest_lng": round(dest_lng, 4),
        "message_plain": (
            f"Trip complete! {driver_name or 'Driver'} · {distance_km} km · "
            f"{duration_display_min} min · ₹{total_fare}"
            + (f" ({surge}x surge)" if surge > 1.0 else "")
        ),
        "message_tech": (
            f"state=completed · fare=₹{total_fare} "
            f"(base ₹{base_fare} + dist ₹{distance_charge} + time ₹{time_charge})"
            f" · surge={surge}x · {distance_km}km · {duration_display_min}min"
            f" · driver reset=available"
        ),
    }
    await redis.publish(f"dispatch:{ride_id_str}", json.dumps(event))
    await redis.publish("admin:metrics", json.dumps(event))

    return {
        "id": str(ride.id),
        "status": ride.status,
        "receipt": receipt,
    }
