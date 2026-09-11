"""POST /prepare — chunk, embed into FAISS, and summarize the document."""

import logging

from fastapi import APIRouter

from app.errors import empty_document, file_too_large
from app.models import PrepareRequest, PrepareResponse
from app.services import rag_service
from app.services.llm_service import generate_summary

logger = logging.getLogger("askmymd.prepare")

router = APIRouter()

MAX_WORDS = 3000


def count_words(text: str) -> int:
    """Word count via whitespace split — matches what a user would count."""
    return len(text.split())


@router.post("/prepare", response_model=PrepareResponse)
async def prepare(request: PrepareRequest) -> PrepareResponse:
    content = request.markdown_content

    if count_words(content) == 0:
        raise empty_document()
    if count_words(content) > MAX_WORDS:
        raise file_too_large()

    chunks = rag_service.chunk_markdown(content)
    logger.info("Prepared document: %d words -> %d chunks", count_words(content), len(chunks))

    summary = generate_summary(content)
    rag_service.store.build(chunks, summary)
    logger.info("Summary (%d chars): %s...", len(summary), summary[:120])

    return PrepareResponse(ready=True)
