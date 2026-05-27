from celery import Celery
from app.core.config import settings

celery_app = Celery(
    "rideflow",
    broker=settings.celery_broker_url,
    backend=settings.celery_broker_url,
    include=["app.workers.tasks", "app.workers.dispatch_task"],
)

celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="UTC",
    enable_utc=True,
    task_track_started=True,
    # One task at a time per worker slot — prevents dispatch tasks from
    # starving the queue by pre-fetching multiple long-running jobs
    worker_prefetch_multiplier=1,
)
