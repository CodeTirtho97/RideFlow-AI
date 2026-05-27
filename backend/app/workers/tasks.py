from app.core.celery_app import celery_app


@celery_app.task(name="tasks.health_check")
def health_check() -> dict:
    return {"status": "celery_ok"}
