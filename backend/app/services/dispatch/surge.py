from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

_ZONE_RADIUS_M = 2000       # 2 km zone around pickup
_DEMAND_WINDOW_MIN = 10     # count ride requests from the last 10 minutes

# Demand/supply ratio → surge multiplier (mirrors real-world tiered surge)
_SURGE_TIERS = [
    (4.0, 2.5),   # extreme scarcity  — demand ≥ 4× supply
    (3.0, 2.0),   # very high demand  — demand ≥ 3× supply
    (2.0, 1.8),   # high demand       — demand ≥ 2× supply
    (1.5, 1.5),   # moderate demand   — demand ≥ 1.5× supply
    (1.0, 1.2),   # slight demand     — demand ≥ 1× supply
]
_SURGE_NO_SUPPLY = 2.5   # no available drivers anywhere nearby


async def compute_surge_multiplier(lat: float, lng: float, db: AsyncSession) -> float:
    """
    Compute surge multiplier for a pickup location based on local demand/supply ratio.

    Demand  = active ride requests in last 10 min within 2 km.
    Supply  = available drivers within 2 km.

    Tiered multipliers (demand/supply ratio → multiplier):
      ≥ 4.0 → 2.5x  |  ≥ 3.0 → 2.0x  |  ≥ 2.0 → 1.8x
      ≥ 1.5 → 1.5x  |  ≥ 1.0 → 1.2x  |  else → 1.0x
    No supply at all → 2.5x.
    """
    point = f"SRID=4326;POINT({lng} {lat})"

    demand: int = await db.scalar(text("""
        SELECT COUNT(*)
        FROM rides
        WHERE status IN ('requested', 'searching_driver')
          AND created_at > NOW() - INTERVAL '1 minute' * :window
          AND ST_DWithin(pickup_location, ST_GeogFromText(:point), :radius)
    """).bindparams(window=_DEMAND_WINDOW_MIN, point=point, radius=_ZONE_RADIUS_M)) or 0

    supply: int = await db.scalar(text("""
        SELECT COUNT(*)
        FROM drivers
        WHERE status = 'available'
          AND ST_DWithin(location, ST_GeogFromText(:point), :radius)
    """).bindparams(point=point, radius=_ZONE_RADIUS_M)) or 0

    if supply == 0:
        return _SURGE_NO_SUPPLY

    ratio = demand / supply
    for threshold, multiplier in _SURGE_TIERS:
        if ratio >= threshold:
            return multiplier
    return 1.0
