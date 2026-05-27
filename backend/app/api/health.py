from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text
import redis.asyncio as redis

from app.core.database import get_db
from app.core.redis_client import get_redis

router = APIRouter()


@router.get("/health")
async def health(db: AsyncSession = Depends(get_db), r: redis.Redis = Depends(get_redis)):
    db_ok = False
    redis_ok = False

    try:
        await db.execute(text("SELECT 1"))
        db_ok = True
    except Exception:
        pass

    try:
        await r.ping()
        redis_ok = True
    except Exception:
        pass

    return {
        "status": "ok" if (db_ok and redis_ok) else "degraded",
        "postgres": "ok" if db_ok else "error",
        "redis": "ok" if redis_ok else "error",
    }
