import uuid
from typing import Any
from sqlalchemy import String, ForeignKey, TIMESTAMP, Integer, Float, func
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import Mapped, mapped_column
from geoalchemy2 import Geography
from app.core.database import Base


class Ride(Base):
    __tablename__ = "rides"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    rider_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    driver_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("drivers.id"), nullable=True
    )
    pickup_location: Any = mapped_column(Geography(geometry_type="POINT", srid=4326), nullable=False)
    destination: Any = mapped_column(Geography(geometry_type="POINT", srid=4326), nullable=False)
    # State machine: requested → searching_driver → driver_assigned → driver_arriving → on_trip → completed | cancelled
    status: Mapped[str] = mapped_column(String, nullable=False, default="requested")
    fare_estimate: Mapped[float | None] = mapped_column(Float, nullable=True)
    surge_multiplier: Mapped[float] = mapped_column(Float, default=1.0)
    created_at: Mapped[Any] = mapped_column(TIMESTAMP(timezone=True), server_default=func.now())
    updated_at: Mapped[Any] = mapped_column(TIMESTAMP(timezone=True), server_default=func.now(), onupdate=func.now())


class RideEvent(Base):
    """Append-only log of every state transition. Never updated, only inserted."""

    __tablename__ = "ride_events"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    ride_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("rides.id"), nullable=False)
    event_type: Mapped[str] = mapped_column(String, nullable=False)
    payload: Any = mapped_column(JSONB, nullable=True)
    created_at: Mapped[Any] = mapped_column(TIMESTAMP(timezone=True), server_default=func.now())


class DispatchLog(Base):
    """One row per dispatch attempt — captures retries, timeouts, and outcomes."""

    __tablename__ = "dispatch_logs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    ride_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("rides.id"), nullable=False)
    driver_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("drivers.id"), nullable=True)
    attempt_number: Mapped[int] = mapped_column(Integer, nullable=False)
    # accepted | rejected | timeout
    outcome: Mapped[str] = mapped_column(String, nullable=False)
    latency_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[Any] = mapped_column(TIMESTAMP(timezone=True), server_default=func.now())


class DemandPrediction(Base):
    __tablename__ = "demand_predictions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    geohash: Mapped[str] = mapped_column(String, nullable=False)
    predicted_demand: Mapped[int | None] = mapped_column(Integer, nullable=True)
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    prediction_window_start: Mapped[Any] = mapped_column(TIMESTAMP(timezone=True), nullable=True)
    prediction_window_end: Mapped[Any] = mapped_column(TIMESTAMP(timezone=True), nullable=True)
    created_at: Mapped[Any] = mapped_column(TIMESTAMP(timezone=True), server_default=func.now())
