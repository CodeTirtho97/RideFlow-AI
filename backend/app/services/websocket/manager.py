from collections import defaultdict
from typing import DefaultDict, Set

from fastapi import WebSocket


class ConnectionManager:
    def __init__(self):
        # ride_id (str) -> set of rider WebSocket connections
        self.ride_connections: DefaultDict[str, Set[WebSocket]] = defaultdict(set)
        # driver_id (str) -> single WebSocket connection
        self.driver_connections: dict[str, WebSocket] = {}
        # admin connections (multiple dashboards allowed)
        self.admin_connections: Set[WebSocket] = set()
        self._count: int = 0

    async def connect_rider(self, ride_id: str, ws: WebSocket) -> None:
        await ws.accept()
        self.ride_connections[ride_id].add(ws)
        self._count += 1

    async def connect_driver(self, driver_id: str, ws: WebSocket) -> None:
        await ws.accept()
        # Replace any stale connection for the same driver
        if driver_id in self.driver_connections:
            self._count -= 1
        self.driver_connections[driver_id] = ws
        self._count += 1

    async def connect_admin(self, ws: WebSocket) -> None:
        await ws.accept()
        self.admin_connections.add(ws)
        self._count += 1

    def disconnect_rider(self, ride_id: str, ws: WebSocket) -> None:
        self.ride_connections[ride_id].discard(ws)
        if not self.ride_connections[ride_id]:
            del self.ride_connections[ride_id]
        self._count = max(0, self._count - 1)

    def disconnect_driver(self, driver_id: str) -> None:
        if driver_id in self.driver_connections:
            del self.driver_connections[driver_id]
            self._count = max(0, self._count - 1)

    def disconnect_admin(self, ws: WebSocket) -> None:
        self.admin_connections.discard(ws)
        self._count = max(0, self._count - 1)

    async def send_to_ride(self, ride_id: str, data: dict) -> None:
        dead: Set[WebSocket] = set()
        for ws in self.ride_connections.get(ride_id, set()):
            try:
                await ws.send_json(data)
            except Exception:
                dead.add(ws)
        for ws in dead:
            self.ride_connections[ride_id].discard(ws)
            self._count = max(0, self._count - 1)

    async def send_to_driver(self, driver_id: str, data: dict) -> None:
        ws = self.driver_connections.get(driver_id)
        if not ws:
            return
        try:
            await ws.send_json(data)
        except Exception:
            del self.driver_connections[driver_id]
            self._count = max(0, self._count - 1)

    async def broadcast_admin(self, data: dict) -> None:
        dead: Set[WebSocket] = set()
        for ws in self.admin_connections:
            try:
                await ws.send_json(data)
            except Exception:
                dead.add(ws)
        for ws in dead:
            self.admin_connections.discard(ws)
            self._count = max(0, self._count - 1)

    @property
    def total_connections(self) -> int:
        return self._count


# Module-level singleton shared across all WebSocket endpoint handlers
manager = ConnectionManager()
