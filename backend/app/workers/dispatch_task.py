import asyncio
import json
import math
import time
import uuid

from app.core.celery_app import celery_app


@celery_app.task(name="tasks.dispatch_ride")
def dispatch_ride(ride_id_str: str) -> dict:
    """
    Celery entry point — synchronous wrapper around the async dispatch logic.
    asyncio.run() is safe here because each Celery task runs in its own thread
    with no shared event loop.
    """
    return asyncio.run(_dispatch(ride_id_str))


def _haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = (math.sin(dlat / 2) ** 2
         + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlng / 2) ** 2)
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


async def _dispatch(ride_id_str: str) -> dict:
    """
    Full dispatch flow for one ride:

    1. Extract pickup coordinates from the ride row.
    2. For each radius in [3 km, 5 km]:
       a. Query the 5 nearest available drivers (no lock yet).
       b. For each candidate (nearest-first):
          - Try to lock that driver with SELECT FOR UPDATE SKIP LOCKED.
          - If already claimed by another task, log 'skipped', continue.
          - If we get the lock, update driver status → busy, ride.driver_id,
            log 'accepted', commit, then transition the ride state.
    3. If no driver found after both radii, cancel the ride.

    SELECT FOR UPDATE SKIP LOCKED is the race-condition guard:
    two dispatch tasks querying simultaneously will each claim a different driver
    rather than double-assigning the same one.
    """
    from sqlalchemy import text, update

    from app.core.config import settings
    from app.core.database import AsyncSessionLocal
    from app.core.redis_client import get_redis
    from app.models.driver import Driver
    from app.models.ride import DispatchLog, Ride
    from app.services.dispatch.engine import find_nearest_drivers
    from app.services.dispatch.retry import DISPATCH_RADII
    from app.services.ride.state_machine import transition

    ride_id = uuid.UUID(ride_id_str)
    attempt = 0
    dispatch_start_ms = int(time.time() * 1000)

    # --- Fetch pickup coordinates + surge multiplier ---
    async with AsyncSessionLocal() as db:
        coord_row = (await db.execute(
            text("""
                SELECT ST_Y(pickup_location::geometry) AS lat,
                       ST_X(pickup_location::geometry) AS lng,
                       surge_multiplier
                FROM rides WHERE id = :ride_id
            """).bindparams(ride_id=ride_id)
        )).fetchone()

    if not coord_row:
        return {"error": "ride not found"}

    pickup_lat, pickup_lng = coord_row.lat, coord_row.lng
    surge_multiplier = float(coord_row.surge_multiplier or 1.0)
    redis_client = await get_redis()

    async def _pub_admin(payload: dict) -> None:
        await redis_client.publish("admin:metrics", json.dumps(payload))

    # Notify admin dispatch has started
    await _pub_admin({
        "event": "dispatch_started",
        "stage": "dispatch_started",
        "ride_id": ride_id_str,
        "pickup_lat": round(pickup_lat, 4),
        "pickup_lng": round(pickup_lng, 4),
        "elapsed_ms": 0,
        "message_plain": "Ride request received. Starting driver search near pickup.",
        "message_tech": (
            f"pickup=({round(pickup_lat, 4)}, {round(pickup_lng, 4)})"
            " · dispatch task started"
        ),
    })

    # Brief delay in demo mode so the "Searching" state is visible in the rider UI
    if settings.demo_mode:
        await asyncio.sleep(4)

    # --- Dispatch loop: initial radius → expanded radius ---
    for radius_km in DISPATCH_RADII:
        async with AsyncSessionLocal() as db:
            candidates = await find_nearest_drivers(pickup_lat, pickup_lng, radius_km, db)

        await _pub_admin({
            "event": "dispatch_searching",
            "stage": "searching",
            "ride_id": ride_id_str,
            "radius_km": radius_km,
            "candidates_found": len(candidates),
            "attempt": attempt + 1,
            "elapsed_ms": int(time.time() * 1000) - dispatch_start_ms,
            "message_plain": (
                f"Searching for available drivers within {radius_km:g} km "
                f"({len(candidates)} candidates found)."
            ),
            "message_tech": (
                f"ST_DWithin radius={radius_km:g}km"
                f" · candidates={len(candidates)}"
            ),
        })

        for candidate in candidates:
            attempt += 1
            start_ms = int(time.time() * 1000)

            async with AsyncSessionLocal() as db:
                # Lock without the status filter so we can distinguish two cases:
                #   None  → SKIP LOCKED fired (another task holds the row lock mid-assignment)
                #   row with status != 'available' → that task already committed; driver is busy
                locked = (await db.execute(
                    text("""
                        SELECT id, name, status FROM drivers
                        WHERE id = :driver_id
                        FOR UPDATE SKIP LOCKED
                    """).bindparams(driver_id=candidate.driver_id)
                )).fetchone()

                if not locked:
                    # Row is locked by a concurrent dispatch task — SKIP LOCKED fired
                    db.add(DispatchLog(
                        ride_id=ride_id,
                        driver_id=candidate.driver_id,
                        attempt_number=attempt,
                        outcome="skipped",
                        latency_ms=int(time.time() * 1000) - start_ms,
                    ))
                    await db.commit()
                    await _pub_admin({
                        "event": "driver_skipped",
                        "stage": "retrying_next_driver",
                        "ride_id": ride_id_str,
                        "driver_id": str(candidate.driver_id),
                        "attempt": attempt,
                        "radius_km": radius_km,
                        "elapsed_ms": int(time.time() * 1000) - dispatch_start_ms,
                        "message_plain": (
                            "Nearest driver is mid-assignment by a parallel request. "
                            "Trying the next nearby driver."
                        ),
                        "message_tech": (
                            f"attempt={attempt}"
                            " · SELECT FOR UPDATE SKIP LOCKED -> row locked by concurrent task"
                        ),
                    })
                    continue

                if locked.status != "available":
                    # Row acquired but status already changed — concurrent task committed first
                    db.add(DispatchLog(
                        ride_id=ride_id,
                        driver_id=candidate.driver_id,
                        attempt_number=attempt,
                        outcome="skipped",
                        latency_ms=int(time.time() * 1000) - start_ms,
                    ))
                    await db.commit()
                    await _pub_admin({
                        "event": "driver_skipped",
                        "stage": "retrying_next_driver",
                        "ride_id": ride_id_str,
                        "driver_id": str(candidate.driver_id),
                        "attempt": attempt,
                        "radius_km": radius_km,
                        "elapsed_ms": int(time.time() * 1000) - dispatch_start_ms,
                        "message_plain": (
                            f"Driver was just assigned to another ride (status={locked.status}). "
                            "Trying the next nearby driver."
                        ),
                        "message_tech": (
                            f"attempt={attempt}"
                            f" · lock acquired but status={locked.status} · concurrent task committed first"
                        ),
                    })
                    continue

                driver_name = locked.name
                latency_ms = int(time.time() * 1000) - start_ms

                await db.execute(
                    update(Driver)
                    .where(Driver.id == candidate.driver_id)
                    .values(status="busy", active_ride_id=ride_id)
                )
                await db.execute(
                    update(Ride)
                    .where(Ride.id == ride_id)
                    .values(driver_id=candidate.driver_id)
                )
                db.add(DispatchLog(
                    ride_id=ride_id,
                    driver_id=candidate.driver_id,
                    attempt_number=attempt,
                    outcome="accepted",
                    latency_ms=latency_ms,
                ))
                await db.commit()

            async with AsyncSessionLocal() as db:
                await transition(
                    ride_id, "driver_assigned", db,
                    payload={"driver_id": str(candidate.driver_id), "attempt": attempt},
                )

            rider_event = {
                "event": "driver_assigned",
                "ride_id": ride_id_str,
                "driver_id": str(candidate.driver_id),
                "driver_name": driver_name,
                "attempt": attempt,
                "radius_km": radius_km,
            }
            await redis_client.publish(f"dispatch:{ride_id_str}", json.dumps(rider_event))

            driver_event = {"event": "ride_assigned", "ride_id": ride_id_str}
            await redis_client.publish(f"driver:{str(candidate.driver_id)}", json.dumps(driver_event))

            await _pub_admin({
                "event": "dispatch_complete",
                "stage": "driver_assigned",
                "ride_id": ride_id_str,
                "driver_id": str(candidate.driver_id),
                "driver_name": driver_name,
                "pickup_lat": round(pickup_lat, 4),
                "pickup_lng": round(pickup_lng, 4),
                "attempt": attempt,
                "radius_km": radius_km,
                "latency_ms": latency_ms,
                "total_ms": int(time.time() * 1000) - dispatch_start_ms,
                "elapsed_ms": int(time.time() * 1000) - dispatch_start_ms,
                "message_plain": (
                    f"Driver {driver_name} assigned after {attempt} attempt(s) "
                    f"within {radius_km:g} km."
                ),
                "message_tech": (
                    f"driver_id={str(candidate.driver_id)[:8]}..."
                    f" · lock_ms={latency_ms}"
                    f" · total_ms={int(time.time() * 1000) - dispatch_start_ms}"
                ),
            })

            # In demo mode auto-progress the full ride lifecycle so we can see
            # driver_arriving → on_trip → completed without manual button clicks.
            # Scale factor: 1 real second ≈ 1 minute of trip time for the demo.
            if settings.demo_mode:
                asyncio.create_task(_run_lifecycle(
                    ride_id_str,
                    str(candidate.driver_id),
                    driver_name,
                    pickup_lat,
                    pickup_lng,
                    surge_multiplier,
                ))

            return {
                "status": "assigned",
                "driver_id": str(candidate.driver_id),
                "driver_name": driver_name,
                "attempt": attempt,
                "radius_km": radius_km,
            }

    # --- No driver found after all radii ---
    async with AsyncSessionLocal() as db:
        db.add(DispatchLog(
            ride_id=ride_id,
            driver_id=None,
            attempt_number=attempt + 1,
            outcome="no_driver_found",
            latency_ms=None,
        ))
        await db.commit()

    async with AsyncSessionLocal() as db:
        await transition(
            ride_id, "cancelled", db,
            payload={"reason": "no_driver_available"},
        )

    cancel_event = {
        "event": "ride_cancelled",
        "ride_id": ride_id_str,
        "reason": "no_driver_available",
        "message_plain": "No nearby driver found. Ride cancelled automatically.",
        "message_tech": f"state=cancelled · reason=no_driver_available · radii={DISPATCH_RADII}",
    }
    await redis_client.publish(f"dispatch:{ride_id_str}", json.dumps(cancel_event))

    await _pub_admin({
        "event": "dispatch_failed",
        "stage": "failed_no_driver",
        "ride_id": ride_id_str,
        "reason": "no_driver_available",
        "total_ms": int(time.time() * 1000) - dispatch_start_ms,
        "elapsed_ms": int(time.time() * 1000) - dispatch_start_ms,
        "attempt": attempt + 1,
        "message_plain": (
            "No driver could be assigned after searching 3 km and 5 km radius. "
            "Ride was cancelled."
        ),
        "message_tech": (
            f"radii={DISPATCH_RADII}"
            f" · attempts={attempt + 1}"
            " · outcome=no_driver_found"
        ),
    })

    return {"status": "cancelled", "reason": "no_driver_available"}


async def _run_lifecycle(
    ride_id_str: str,
    driver_id_str: str,
    driver_name: str,
    pickup_lat: float,
    pickup_lng: float,
    surge_multiplier: float,
) -> None:
    """
    Auto-progress a ride through driver_arriving → on_trip → completed in demo mode.

    Timing is scaled so a full lifecycle completes in ~57 seconds of real time.
    Scale factor: 1 real second = 1 minute of trip time for fare calculation.

    Stages:
      +15 s → driver_arriving   (driver en route to pickup)
      +20 s → on_trip           (rider picked up, meter running)
      +22 s → completed         (trip done, fare calculated, driver freed)
    """
    from sqlalchemy import select, text, update

    from app.core.database import AsyncSessionLocal
    from app.core.redis_client import get_redis as _get_redis
    from app.models.driver import Driver
    from app.models.ride import Ride
    from app.services.ride.state_machine import transition

    ride_id = uuid.UUID(ride_id_str)
    driver_id = uuid.UUID(driver_id_str)
    redis_client = await _get_redis()

    async def _pub(payload: dict) -> None:
        await redis_client.publish("admin:metrics", json.dumps(payload))
        await redis_client.publish(f"dispatch:{ride_id_str}", json.dumps(payload))

    # ── Stage 1: driver_arriving (+15 s) ───────────────────────────────────
    await asyncio.sleep(15)
    try:
        async with AsyncSessionLocal() as db:
            await transition(ride_id, "driver_arriving", db,
                             payload={"driver_name": driver_name, "auto": True})
        await _pub({
            "event": "status_update",
            "status": "driver_arriving",
            "ride_id": ride_id_str,
            "driver_id": driver_id_str,
            "driver_name": driver_name,
            "message_plain": f"{driver_name} is on the way to pickup.",
            "message_tech": "state=driver_arriving · ETA ~2 min (scaled)",
        })
    except Exception:
        return  # ride was cancelled — stop lifecycle

    # ── Stage 2: on_trip (+20 s after arriving) ────────────────────────────
    await asyncio.sleep(20)
    trip_start_ts = time.time()
    try:
        async with AsyncSessionLocal() as db:
            await transition(ride_id, "on_trip", db,
                             payload={
                                 "driver_name": driver_name,
                                 "trip_started_at": trip_start_ts,
                                 "auto": True,
                             })
        await _pub({
            "event": "status_update",
            "status": "on_trip",
            "ride_id": ride_id_str,
            "driver_id": driver_id_str,
            "driver_name": driver_name,
            "message_plain": f"Rider picked up by {driver_name}. Trip in progress.",
            "message_tech": "state=on_trip · fare meter running · scale 1s=1min",
        })
    except Exception:
        return

    # ── Stage 3: completed (+22 s into trip) ───────────────────────────────
    await asyncio.sleep(22)
    trip_end_ts = time.time()
    # Each real second = 1 minute of trip time for demo fare calculation
    duration_seconds = int(trip_end_ts - trip_start_ts)
    duration_display_min = duration_seconds  # 1s real = 1min display

    try:
        async with AsyncSessionLocal() as db:
            coord_row = (await db.execute(
                text("""
                    SELECT ST_Y(destination::geometry) AS dest_lat,
                           ST_X(destination::geometry) AS dest_lng
                    FROM rides WHERE id = :ride_id
                """).bindparams(ride_id=ride_id)
            )).fetchone()

        dest_lat = coord_row.dest_lat if coord_row else pickup_lat + 0.05
        dest_lng = coord_row.dest_lng if coord_row else pickup_lng + 0.05

        distance_km = round(_haversine_km(pickup_lat, pickup_lng, dest_lat, dest_lng), 2)

        # Realistic Bengaluru fare (Uber Go / Ola Mini equivalent)
        # ₹50 booking fee + ₹14/km + ₹1.5/min; minimum ₹80; surge on full fare
        base_fare = 50.0
        distance_charge = round(14.0 * distance_km, 2)
        time_charge = round(1.5 * duration_display_min, 2)
        raw_fare = base_fare + distance_charge + time_charge
        total_fare = round(max(80.0, raw_fare * surge_multiplier), 2)

        async with AsyncSessionLocal() as db:
            await db.execute(
                update(Ride).where(Ride.id == ride_id).values(fare_estimate=total_fare)
            )
            await db.commit()

        async with AsyncSessionLocal() as db:
            await transition(ride_id, "completed", db, payload={
                "fare": total_fare,
                "distance_km": distance_km,
                "duration_seconds": duration_seconds,
                "duration_display_min": duration_display_min,
                "auto": True,
            })

        async with AsyncSessionLocal() as db:
            await db.execute(
                update(Driver)
                .where(Driver.id == driver_id)
                .values(status="available", active_ride_id=None)
            )
            await db.commit()

        await _pub({
            "event": "ride_completed",
            "status": "completed",
            "ride_id": ride_id_str,
            "driver_id": driver_id_str,
            "driver_name": driver_name,
            "fare": total_fare,
            "base_fare": base_fare,
            "distance_charge": distance_charge,
            "time_charge": time_charge,
            "distance_km": distance_km,
            "duration_seconds": duration_seconds,
            "duration_display_min": duration_display_min,
            "surge_multiplier": surge_multiplier,
            "pickup_lat": round(pickup_lat, 4),
            "pickup_lng": round(pickup_lng, 4),
            "dest_lat": round(dest_lat, 4),
            "dest_lng": round(dest_lng, 4),
            "message_plain": (
                f"Trip complete! {driver_name} · {distance_km} km · "
                f"{duration_display_min} min · ₹{total_fare}"
                + (f" ({surge_multiplier}x surge)" if surge_multiplier > 1.0 else "")
            ),
            "message_tech": (
                f"state=completed · fare=₹{total_fare} "
                f"(base ₹{base_fare} + dist ₹{distance_charge} + time ₹{time_charge})"
                f" · surge={surge_multiplier}x · {distance_km}km · {duration_display_min}min"
                f" · driver reset=available"
            ),
        })

    except Exception:
        pass
