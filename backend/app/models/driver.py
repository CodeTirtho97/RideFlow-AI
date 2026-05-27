import uuid
from typing import Any
from sqlalchemy import String, ForeignKey, TIMESTAMP, func
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.dialects.postgresql import UUID
from geoalchemy2 import Geography
from app.core.database import Base


class Driver(Base):
    __tablename__ = "drivers"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String, nullable=False)
    phone: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    # available | busy | offline
    status: Mapped[str] = mapped_column(String, nullable=False, default="offline")
    # use_alter=True breaks the circular FK with rides at DDL level
    active_ride_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("rides.id", use_alter=True, name="fk_driver_active_ride"),
        nullable=True,
    )
    # Geography column — stored in Redis for live updates, persisted here for dispatch queries
    location: Any = mapped_column(Geography(geometry_type="POINT", srid=4326), nullable=True)
    created_at: Mapped[Any] = mapped_column(TIMESTAMP(timezone=True), server_default=func.now())
