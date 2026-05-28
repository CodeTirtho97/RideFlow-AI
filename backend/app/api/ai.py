import asyncio
import json
import logging

from fastapi import APIRouter, Depends, HTTPException
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db, AsyncSessionLocal
from app.core.redis_client import get_redis
from app.services.ai.demand_prediction import detect_demand_hotspots

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/demo/ai", tags=["AI Demo"])

_ai_task: asyncio.Task | None = None
AI_INTERVAL_SECONDS = 8


async def _ai_loop() -> None:
    """Background loop: re-runs DBSCAN every AI_INTERVAL_SECONDS and publishes hotspot updates.
    Stops automatically when no unmatched rides remain — last results stay visible until reset."""
    from app.core.redis_client import get_redis as _get_redis
    redis = await _get_redis()
    while True:
        try:
            async with AsyncSessionLocal() as db:
                hotspots = await detect_demand_hotspots(db=db, eps_km=1.5, min_samples=3)

            if hotspots:
                # Publish entire cycle as one batch so frontend replaces atomically
                batch = {
                    "event": "ai_cycle_update",
                    "hotspots": [h.to_dict() for h in hotspots],
                }
                await redis.publish("ai:alerts", json.dumps(batch))
            else:
                # No unmatched rides left — stop the loop, keep last results on screen
                logger.info("AI loop: no unmatched rides remaining, stopping loop.")
                break

            await asyncio.sleep(AI_INTERVAL_SECONDS)

        except asyncio.CancelledError:
            break
        except Exception:
            logger.exception("AI loop error")
            await asyncio.sleep(AI_INTERVAL_SECONDS)


def stop_ai_loop() -> None:
    global _ai_task
    if _ai_task and not _ai_task.done():
        _ai_task.cancel()
        _ai_task = None


@router.post("/run")
async def run_ai_prediction(
    db: AsyncSession = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    """
    Start continuous DBSCAN hotspot detection loop.
    Re-runs every 8s and publishes live updates to ai:alerts Redis channel.
    """
    global _ai_task

    if _ai_task and not _ai_task.done():
        return {"status": "already_running", "message": "AI prediction loop is already active."}

    # Run once immediately so the frontend gets instant feedback
    try:
        hotspots = await detect_demand_hotspots(db=db, eps_km=1.5, min_samples=3)
        if hotspots:
            batch = {"event": "ai_cycle_update", "hotspots": [h.to_dict() for h in hotspots]}
            await redis.publish("ai:alerts", json.dumps(batch))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"AI prediction failed: {str(e)}")

    # Start continuous background loop
    _ai_task = asyncio.create_task(_ai_loop())

    return {
        "status": "started",
        "hotspots_found": len(hotspots),
        "hotspots": [h.to_dict() for h in hotspots],
        "message": (
            f"AI loop started — detected {len(hotspots)} hotspot(s). Updates every {AI_INTERVAL_SECONDS}s."
            if hotspots
            else f"AI loop started — no hotspots yet. Checking every {AI_INTERVAL_SECONDS}s."
        ),
    }


@router.post("/stop")
async def stop_ai_prediction():
    """Stop the continuous AI prediction loop."""
    stop_ai_loop()
    return {"status": "stopped", "message": "AI prediction loop stopped."}
