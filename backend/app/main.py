"""AskmyMD FastAPI entrypoint."""

import logging
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.errors import (
    AppError,
    app_error_handler,
    http_error_handler,
    unhandled_error_handler,
    validation_error_handler,
)
from app.routers import chat, documents, health, prepare

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("askmymd.startup")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Mirror tests/conftest.py: ensure pgvector extension + all tables exist
    # so a fresh `createdb askmymd` works without manual psql steps.
    try:
        from app.database import get_engine
        from app.db import _ensure_extension_and_tables

        _ensure_extension_and_tables()
        engine = get_engine()
        # str(engine.url) masks the password (***), so it is safe to log.
        logger.info(
            "DB startup: extension + tables ensured (askmymd) - engine URL: %s",
            engine.url if engine is not None else "NONE (DATABASE_URL not set)",
        )
    except Exception as e:
        logger.warning("DB startup ensure failed: %s", e)
    yield


app = FastAPI(title="AskmyMD API", lifespan=lifespan)

# Allow the Vite dev server origin (frontend) to call the backend.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(prepare.router)
app.include_router(chat.router)
app.include_router(documents.router)

# Domain errors, malformed bodies, and anything unexpected all share the
# { error, code } shape.
app.add_exception_handler(AppError, app_error_handler)
app.add_exception_handler(RequestValidationError, validation_error_handler)
app.add_exception_handler(StarletteHTTPException, http_error_handler)
app.add_exception_handler(Exception, unhandled_error_handler)


@app.get("/")
async def root() -> dict:
    return {"app": "AskmyMD API"}
