import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.health import router as health_router
from app.api.drivers import router as drivers_router
from app.api.rides import router as rides_router
from app.api.websocket import router as ws_router
from app.api.metrics import router as metrics_router
from app.core.config import settings
from app.core.redis_client import close_redis
from app.services.websocket.pubsub import start_pubsub_listener


@asynccontextmanager
async def lifespan(app: FastAPI):
    pubsub_task = asyncio.create_task(start_pubsub_listener())
    yield
    pubsub_task.cancel()
    try:
        await pubsub_task
    except asyncio.CancelledError:
        pass
    await close_redis()


app = FastAPI(title="RideFlow AI", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health_router, prefix="/api")
app.include_router(drivers_router)
app.include_router(rides_router)
app.include_router(ws_router)
app.include_router(metrics_router)

if getattr(settings, "demo_mode", False):
    from app.api.demo import router as demo_router
    from app.api.ai import router as ai_router
    app.include_router(demo_router)
    app.include_router(ai_router)
