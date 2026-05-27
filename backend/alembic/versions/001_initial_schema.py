"""initial schema

Revision ID: 001_initial_schema
Revises:
Create Date: 2026-05-19

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
import sqlalchemy.dialects.postgresql as pg
from geoalchemy2 import Geography

revision: str = "001_initial_schema"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS postgis")

    # drivers — no active_ride_id FK yet (rides doesn't exist)
    op.create_table(
        "drivers",
        sa.Column("id", pg.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("phone", sa.String(), nullable=False),
        sa.Column("status", sa.String(), nullable=False, server_default="offline"),
        sa.Column("location", Geography(geometry_type="POINT", srid=4326), nullable=True),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("phone", name="uq_driver_phone"),
    )
    # GiST index — what makes ST_DWithin fast instead of a full table scan
    op.create_index("idx_driver_location", "drivers", ["location"], postgresql_using="gist")

    # rides — driver_id FK to drivers is safe now
    op.create_table(
        "rides",
        sa.Column("id", pg.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("rider_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("driver_id", pg.UUID(as_uuid=True), nullable=True),
        sa.Column("pickup_location", Geography(geometry_type="POINT", srid=4326), nullable=False),
        sa.Column("destination", Geography(geometry_type="POINT", srid=4326), nullable=False),
        sa.Column("status", sa.String(), nullable=False, server_default="requested"),
        sa.Column("fare_estimate", sa.Float(), nullable=True),
        sa.Column("surge_multiplier", sa.Float(), nullable=False, server_default="1.0"),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), server_default=sa.func.now()),
        sa.ForeignKeyConstraint(["driver_id"], ["drivers.id"], name="fk_ride_driver"),
    )

    # Now that rides exists, add the circular FK on drivers via ALTER TABLE
    op.add_column("drivers", sa.Column("active_ride_id", pg.UUID(as_uuid=True), nullable=True))
    op.create_foreign_key("fk_driver_active_ride", "drivers", "rides", ["active_ride_id"], ["id"])

    op.create_table(
        "ride_events",
        sa.Column("id", pg.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("ride_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("event_type", sa.String(), nullable=False),
        sa.Column("payload", pg.JSONB(), nullable=True),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), server_default=sa.func.now()),
        sa.ForeignKeyConstraint(["ride_id"], ["rides.id"], name="fk_event_ride"),
    )

    op.create_table(
        "dispatch_logs",
        sa.Column("id", pg.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("ride_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("driver_id", pg.UUID(as_uuid=True), nullable=True),
        sa.Column("attempt_number", sa.Integer(), nullable=False),
        sa.Column("outcome", sa.String(), nullable=False),
        sa.Column("latency_ms", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), server_default=sa.func.now()),
        sa.ForeignKeyConstraint(["ride_id"], ["rides.id"], name="fk_dispatch_ride"),
        sa.ForeignKeyConstraint(["driver_id"], ["drivers.id"], name="fk_dispatch_driver"),
    )

    op.create_table(
        "demand_predictions",
        sa.Column("id", pg.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("geohash", sa.String(), nullable=False),
        sa.Column("predicted_demand", sa.Integer(), nullable=True),
        sa.Column("confidence", sa.Float(), nullable=True),
        sa.Column("prediction_window_start", sa.TIMESTAMP(timezone=True), nullable=True),
        sa.Column("prediction_window_end", sa.TIMESTAMP(timezone=True), nullable=True),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), server_default=sa.func.now()),
    )


def downgrade() -> None:
    op.drop_table("demand_predictions")
    op.drop_table("dispatch_logs")
    op.drop_table("ride_events")
    op.drop_constraint("fk_driver_active_ride", "drivers", type_="foreignkey")
    op.drop_column("drivers", "active_ride_id")
    op.drop_table("rides")
    op.drop_index("idx_driver_location", table_name="drivers")
    op.drop_table("drivers")
    op.execute("DROP EXTENSION IF EXISTS postgis")
