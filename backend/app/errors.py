"""Consistent error shape across the API: { "error": str, "code": str }."""

import logging

from fastapi import Request
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException

logger = logging.getLogger("askmymd.errors")


class AppError(Exception):
    """Domain error carrying an HTTP status, machine-readable code, and message."""

    def __init__(self, status_code: int, code: str, message: str) -> None:
        self.status_code = status_code
        self.code = code
        self.message = message
        super().__init__(message)


def file_too_large() -> AppError:
    return AppError(400, "FILE_TOO_LARGE", "Document exceeds 3000 word limit")


def empty_document() -> AppError:
    return AppError(400, "EMPTY_DOCUMENT", "Document is empty — nothing to process")


def not_prepared() -> AppError:
    return AppError(400, "NOT_PREPARED", "No document has been prepared yet")


def llm_unavailable(context: str) -> AppError:
    return AppError(503, "LLM_UNAVAILABLE", f"Could not {context}, LLM unavailable")


def unauthorized() -> AppError:
    return AppError(401, "UNAUTHORIZED", "Authentication required")


def document_not_found() -> AppError:
    return AppError(404, "DOCUMENT_NOT_FOUND", "Document not found")


def document_resyncing() -> AppError:
    return AppError(409, "DOCUMENT_RESYNCING", "document is resyncing")


def document_error() -> AppError:
    return AppError(409, "DOCUMENT_ERROR", "document is in error state, please resync")

def resync_failed(msg: str = "Resync failed") -> AppError:
    return AppError(500, "RESYNC_FAILED", msg)


def image_too_large() -> AppError:
    return AppError(413, "IMAGE_TOO_LARGE", "Image exceeds the 5 MB limit")


def invalid_image_type() -> AppError:
    return AppError(400, "INVALID_IMAGE_TYPE", "Only PNG, JPEG, GIF or WebP images are allowed")


def image_not_found() -> AppError:
    return AppError(404, "IMAGE_NOT_FOUND", "Image not found")


async def app_error_handler(_: Request, exc: AppError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": exc.message, "code": exc.code},
    )


async def validation_error_handler(_: Request, exc: RequestValidationError) -> JSONResponse:
    """Malformed request bodies (e.g. missing markdown_content) -> same error shape."""
    return JSONResponse(
        status_code=422,
        content={"error": "Invalid request body", "code": "INVALID_REQUEST"},
    )


async def http_error_handler(_: Request, exc: StarletteHTTPException) -> JSONResponse:
    """Framework-level HTTP errors (404 unknown route, 405 bad method, ...)
    also use the standard { error, code } shape."""
    messages = {
        404: "Endpoint not found",
        405: "Method not allowed for this endpoint",
    }
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "error": messages.get(exc.status_code, str(exc.detail)),
            "code": "HTTP_ERROR",
        },
    )


async def unhandled_error_handler(_: Request, exc: Exception) -> JSONResponse:
    """Last-resort handler so even unexpected crashes answer with the
    standard { error, code } shape instead of a bare 500."""
    logger.exception("Unhandled error: %s", exc)
    return JSONResponse(
        status_code=500,
        content={"error": "Internal server error", "code": "INTERNAL_ERROR"},
    )
