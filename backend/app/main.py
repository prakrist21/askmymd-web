"""AskmyMD FastAPI entrypoint."""

import logging

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

app = FastAPI(title="AskmyMD API")

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
