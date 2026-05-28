from sklearn.cluster import DBSCAN
import numpy as np
from typing import List
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession


class DemandHotspot:
    def __init__(
        self,
        center_lat: float,
        center_lng: float,
        demand: int,
        drivers_nearby: int,
        confidence: float,
        radius_km: float = 1.5,
        nearest_drivers: list | None = None,
    ):
        self.center_lat = center_lat
        self.center_lng = center_lng
        self.demand = demand
        self.drivers_nearby = drivers_nearby
        self.shortage = max(0, demand - drivers_nearby)
        self.confidence = confidence
        self.radius_km = radius_km
        self.nearest_drivers = nearest_drivers or []
        self.zone_name = self._zone_name()
        self.zone_status = self._zone_status()
        self.unmatched_pct = round((self.shortage / max(1, self.demand)) * 100, 1)
        self.fare_increase_pct = self._fare_increase_pct()
        self.surge_multiplier = round(1.0 + (self.fare_increase_pct / 100), 2)
        self.deploy_recommendation = max(0, int(self.shortage * 1.1))
        self.eta_minutes = max(2, int(3 + self.shortage * 0.2)) if self.shortage > 0 else 0

    def _zone_name(self) -> str:
        return f"Zone ({self.center_lat:.2f}°N, {self.center_lng:.2f}°E)"

    def _zone_status(self) -> str:
        if self.demand == 0:
            return "Balanced"
        pct = (self.shortage / self.demand) * 100
        if pct >= 60:
            return "Critical"
        if pct >= 30:
            return "High"
        if pct >= 10:
            return "Moderate"
        return "Balanced"

    def _fare_increase_pct(self) -> float:
        if self.demand == 0:
            return 0.0
        ratio = self.shortage / max(1, self.demand)
        # Surge formula: shortage drives up to ~150% increase at full shortage
        return round(ratio * 150, 1)

    def to_dict(self):
        return {
            "center_lat": round(self.center_lat, 4),
            "center_lng": round(self.center_lng, 4),
            "zone_name": self.zone_name,
            "zone_status": self.zone_status,
            "demand": self.demand,
            "drivers_nearby": self.drivers_nearby,
            "shortage": self.shortage,
            "unmatched_pct": self.unmatched_pct,
            "confidence": round(self.confidence, 2),
            "radius_km": self.radius_km,
            "fare_increase_pct": self.fare_increase_pct,
            "surge_multiplier": self.surge_multiplier,
            "deploy_recommendation": self.deploy_recommendation,
            "eta_minutes": self.eta_minutes,
            "nearest_drivers": self.nearest_drivers,
        }


async def detect_demand_hotspots(
    db: AsyncSession,
    eps_km: float = 1.5,
    min_samples: int = 3,
) -> List[DemandHotspot]:
    # Only cluster UNMATCHED rides — assigned/on-trip riders already have drivers
    result = await db.execute(
        text("""
            SELECT
                ST_Y(pickup_location::geometry) AS lat,
                ST_X(pickup_location::geometry) AS lng
            FROM rides
            WHERE status = ANY(:statuses)
              AND pickup_location IS NOT NULL
        """),
        {"statuses": ["requested", "searching_driver"]}
    )
    rows = result.fetchall()

    if len(rows) < min_samples:
        return []

    coordinates = np.array([[row.lat, row.lng] for row in rows])

    if len(coordinates) < min_samples:
        return []

    eps_degrees = eps_km / 111.0
    clustering = DBSCAN(eps=eps_degrees, min_samples=min_samples).fit(coordinates)
    labels = clustering.labels_

    unique_labels = set(labels)
    hotspots: List[DemandHotspot] = []


    for label in unique_labels:
        if label == -1:
            continue

        cluster_mask = labels == label
        cluster_coords = coordinates[cluster_mask]
        center_lat = float(cluster_coords[:, 0].mean())
        center_lng = float(cluster_coords[:, 1].mean())
        demand = int(np.sum(cluster_mask))

        # Count available drivers actually within the hotspot radius
        zone_driver_result = await db.execute(
            text("""
                SELECT COUNT(*) AS cnt
                FROM drivers
                WHERE status = 'available'
                  AND location IS NOT NULL
                  AND ST_DWithin(
                    location::geography,
                    ST_SetSRID(ST_MakePoint(:lng, :lat), 4326)::geography,
                    :radius_m
                  )
            """),
            {"lat": center_lat, "lng": center_lng, "radius_m": eps_km * 1000}
        )
        drivers_in_zone = int(zone_driver_result.scalar() or 0)

        distances = np.linalg.norm(
            cluster_coords - np.array([center_lat, center_lng]), axis=1
        )
        max_distance_km = float(distances.max()) * 111.0
        confidence = max(0.0, 1.0 - (max_distance_km / (eps_km * 3)))

        # Query 3 nearest available drivers; fall back to any driver if none available
        nearest_result = await db.execute(
            text("""
                SELECT
                    id::text AS id,
                    name,
                    status,
                    ROUND(
                        (ST_Distance(
                            location::geography,
                            ST_SetSRID(ST_MakePoint(:lng, :lat), 4326)::geography
                        ) / 1000.0)::numeric, 1
                    ) AS distance_km
                FROM drivers
                WHERE status = 'available'
                  AND location IS NOT NULL
                ORDER BY location::geography <-> ST_SetSRID(ST_MakePoint(:lng, :lat), 4326)::geography
                LIMIT 3
            """),
            {"lat": center_lat, "lng": center_lng}
        )
        nearest_drivers = nearest_result.fetchall()

        # Fall back to any nearby driver if no available drivers exist
        if not nearest_drivers:
            nearest_result = await db.execute(
                text("""
                    SELECT
                        id::text AS id,
                        name,
                        status,
                        ROUND(
                            (ST_Distance(
                                location::geography,
                                ST_SetSRID(ST_MakePoint(:lng, :lat), 4326)::geography
                            ) / 1000.0)::numeric, 1
                        ) AS distance_km
                    FROM drivers
                    WHERE location IS NOT NULL
                    ORDER BY location::geography <-> ST_SetSRID(ST_MakePoint(:lng, :lat), 4326)::geography
                    LIMIT 3
                """),
                {"lat": center_lat, "lng": center_lng}
            )
            nearest_drivers = nearest_result.fetchall()

        nearest_drivers = [
            {"id": r.id, "name": r.name, "distance_km": float(r.distance_km), "status": r.status}
            for r in nearest_drivers
        ]

        hotspot = DemandHotspot(
            center_lat=center_lat,
            center_lng=center_lng,
            demand=demand,
            drivers_nearby=drivers_in_zone,
            confidence=confidence,
            radius_km=eps_km,
            nearest_drivers=nearest_drivers,
        )
        hotspots.append(hotspot)

    hotspots.sort(key=lambda h: h.shortage, reverse=True)
    return hotspots
