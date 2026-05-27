import uuid

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.services.websocket.manager import manager

router = APIRouter(tags=["websocket"])


@router.websocket("/ws/ride/{ride_id}")
async def rider_ws(websocket: WebSocket, ride_id: uuid.UUID):
    """
    Rider WebSocket — scoped to a single ride.

    The client subscribes to dispatch:{ride_id} events:
      - driver_assigned: dispatch engine found a driver
      - ride_cancelled:  no driver available after all retries

    On reconnect the client should call GET /api/v1/rides/{ride_id} first
    to pull current state, then re-open this socket for subsequent deltas.
    """
    ride_id_str = str(ride_id)
    await manager.connect_rider(ride_id_str, websocket)
    try:
        while True:
            # Keep alive — rider only receives, never sends commands over WS
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect_rider(ride_id_str, websocket)


@router.websocket("/ws/driver/{driver_id}")
async def driver_ws(websocket: WebSocket, driver_id: uuid.UUID):
    """
    Driver WebSocket — scoped to a single driver.

    The driver app receives:
      - incoming_request: a ride has been dispatched to this driver
      - dispatch_result:  whether the assignment was confirmed or released

    On reconnect the client calls GET /api/v1/drivers/{driver_id} to
    refresh state, then re-opens this socket.
    """
    driver_id_str = str(driver_id)
    await manager.connect_driver(driver_id_str, websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect_driver(driver_id_str)


@router.websocket("/ws/admin")
async def admin_ws(websocket: WebSocket):
    """
    Admin WebSocket — receives all system-wide events.

    Receives messages published to admin:metrics and ai:alerts channels:
      - dispatch_complete / dispatch_failed: dispatch outcomes
      - driver_location: real-time driver positions for the live map
      - ai_hotspot: demand hotspot detection from the AI layer

    Multiple admin dashboards can connect simultaneously.
    """
    await manager.connect_admin(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect_admin(websocket)
