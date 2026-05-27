import uuid
from dataclasses import dataclass

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession


@dataclass
class DriverCandidate:
    driver_id: uuid.UUID
    distance_m: float


async def find_nearest_drivers(
    lat: float,
    lng: float,
    radius_km: float,
    db: AsyncSession,
    limit: int = 5,
) -> list[DriverCandidate]:
    """
    Return up to `limit` available drivers within `radius_km`, sorted by distance.

    No row lock here — locking is done per-candidate in the dispatch task via
    a separate `SELECT ... FOR UPDATE SKIP LOCKED` so each driver can be claimed
    independently without blocking the entire candidate list.
    """
    point = f"SRID=4326;POINT({lng} {lat})"

    rows = (await db.execute(
        text("""
            SELECT id, ST_Distance(location, ST_GeogFromText(:point)) AS distance_m
            FROM drivers
            WHERE status = 'available'
              AND ST_DWithin(location, ST_GeogFromText(:point), :radius_m)
            ORDER BY distance_m ASC
            LIMIT :limit
        """).bindparams(point=point, radius_m=int(radius_km * 1000), limit=limit)
    )).fetchall()

    return [DriverCandidate(driver_id=row[0], distance_m=row[1]) for row in rows]
