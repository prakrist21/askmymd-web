"""POST /chat — answer a question from the prepared document
(LangGraph corrective RAG: retrieve → grade → rewrite/re-retrieve →
generate → verify grounding)."""

import logging

from fastapi import APIRouter

from app.errors import not_prepared
from app.models import ChatRequest, ChatResponse
from app.services import rag_service

logger = logging.getLogger("askmymd.chat")

router = APIRouter()


@router.post("/chat", response_model=ChatResponse)
async def chat(request: ChatRequest) -> ChatResponse:
    store = rag_service.store
    if store.index is None or not store.chunks:
        raise not_prepared()

    logger.info(
        "Chat: %d history msgs for question %r",
        len(request.chat_history),
        request.question[:80],
    )
    answer = rag_service.run_corrective_rag(
        request.question, request.chat_history, store.summary, store
    )
    return ChatResponse(answer=answer)
