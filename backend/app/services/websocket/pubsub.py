import asyncio
import json
import logging

import redis.asyncio as aioredis

from app.core.config import settings
from app.services.websocket.manager import manager

logger = logging.getLogger(__name__)


async def start_pubsub_listener() -> None:
    """
    Runs as a background asyncio task for the lifetime of the FastAPI process.

    Uses a dedicated Redis connection — a connection in pub/sub mode cannot
    issue regular commands, so it must be separate from the shared client pool.

    Channel routing:
      dispatch:{ride_id}   → rider WebSocket(s) watching that ride
      driver:{driver_id}   → driver WebSocket for that driver
      admin:metrics        → all admin dashboard connections
      ai:alerts            → all admin dashboard connections
    """
    client = aioredis.from_url(settings.redis_url, decode_responses=True)
    pubsub = client.pubsub()

    # psubscribe handles wildcard patterns; subscribe handles exact channels
    await pubsub.psubscribe("dispatch:*", "driver:*")
    await pubsub.subscribe("admin:metrics", "ai:alerts")

    try:
        async for message in pubsub.listen():
            # Subscription confirmations have type 'subscribe'/'psubscribe' — skip them
            if message["type"] not in ("message", "pmessage"):
                continue
            try:
                channel: str = message["channel"]
                data: dict = json.loads(message["data"])
                await _route(channel, data)
            except Exception:
                logger.exception("pubsub routing error on channel %s", message.get("channel"))
    except asyncio.CancelledError:
        pass
    finally:
        await pubsub.aclose()
        await client.aclose()


async def _route(channel: str, data: dict) -> None:
    if channel.startswith("dispatch:"):
        ride_id = channel.split(":", 1)[1]
        await manager.send_to_ride(ride_id, data)

    elif channel.startswith("driver:"):
        driver_id = channel.split(":", 1)[1]
        await manager.send_to_driver(driver_id, data)

    elif channel in ("admin:metrics", "ai:alerts"):
        await manager.broadcast_admin(data)
