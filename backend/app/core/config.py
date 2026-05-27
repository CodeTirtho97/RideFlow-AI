from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str
    redis_url: str
    celery_broker_url: str
    demo_mode: bool = True
    cors_origins: str = "http://localhost:3000,http://127.0.0.1:3000"

    @property
    def cors_origins_list(self) -> list[str]:
        defaults = ["http://localhost:3000", "http://127.0.0.1:3000"]
        configured = [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]
        merged: list[str] = []
        for origin in [*defaults, *configured]:
            if origin not in merged:
                merged.append(origin)
        return merged

    class Config:
        env_file = ".env"


settings = Settings()
