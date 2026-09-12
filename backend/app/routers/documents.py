"""Document-scoped routes: resync, ask, history.

This module implements the spec:

- POST /documents/{document_id}/resync  (auth, 404 if not owned)
  sets status resyncing -> deletes vectors -> re-chunks/embeds -> ready
  archives ChatMessage rows, blocks ask with 409 while resyncing,
  on failure sets status error and keeps ask blocked.

- POST /documents/{document_id}/ask  (auth, 409 if resyncing/error)
- GET  /documents/{document_id}/history  (auth, returns only non-archived)
- POST /documents  (helper to create a document, used by tests/frontend)

Vector store is simulated as:
- `db.chroma_store[doc_id] = list[chunks]`  (Chroma collection equivalent)
- `rag_stores[doc_id] = RagStore`  (FAISS equivalent for retrieval)

Archiving is done via `is_archived` boolean on ChatMessageRow.
"""
import logging
from typing import Optional

from fastapi import APIRouter, Depends, Path

from app.auth import get_current_user, CurrentUser
from app.db import documents, chroma_store, chat_messages, archive_messages, get_messages_for_document, Document
from app.errors import document_not_found, document_resyncing, document_error
from app.models import ChatRequest, ChatResponse
from app.services import rag_service

logger = logging.getLogger("askmymd.documents")

router = APIRouter(prefix="/documents", tags=["documents"])

# Per-document FAISS stores (mirrors Chroma). Kept here to avoid polluting rag_service global store.
document_stores: dict[str, rag_service.RagStore] = {}


def _get_document_or_404(document_id: str, user: CurrentUser) -> Document:
    doc = documents.get(document_id)
    if not doc or doc.owner_id != user.id:
        raise document_not_found()
    return doc


@router.post("")
async def create_document(
    body: dict,
    user: CurrentUser = Depends(get_current_user),
):
    """Create a document for the authenticated user. Helper for tests and UI.
    
    Request body: { "content": str, "title": Optional[str] }
    """
    content = body.get("content", "")
    # Allow empty content creation — resync will handle validation later.
    doc_id = __import__("uuid").uuid4().hex[:12]
    # Use db.create-like inline to keep owner scoping
    from app.db import Document as DocModel
    doc = DocModel(id=doc_id, owner_id=user.id, content=content, status="ready")
    documents[doc_id] = doc

    # Initial embedding so ask works without explicit resync
    if content and content.strip():
        try:
            chunks = rag_service.chunk_markdown(content)
            if chunks:
                store = rag_service.RagStore()
                # For tests without real embedding model, use fallback: skip embedding if no model
                try:
                    store.build(chunks, summary="")  # summary empty initially
                except Exception as e:
                    # Embedding unavailable in test (no model) — still populate chroma_store with chunks
                    logger.warning("Initial embed failed for doc %s: %s (populating chroma_store only)", doc_id, e)
                chroma_store[doc_id] = list(chunks)
                if store.index is not None:
                    document_stores[doc_id] = store
                else:
                    # still store chunks as fallback collection
                    document_stores[doc_id] = store  # may be empty index but chunks present
                    if not hasattr(store, 'chunks') or not store.chunks:
                        store.chunks = list(chunks)
            else:
                chroma_store[doc_id] = []
        except Exception as e:
            logger.warning("create_document chunking failed %s: %s", doc_id, e)
            chroma_store[doc_id] = []
            doc.status = "error"

    return {"document_id": doc_id, "status": doc.status}


@router.get("/{document_id}/history")
async def get_history(
    document_id: str = Path(...),
    user: CurrentUser = Depends(get_current_user),
):
    doc = _get_document_or_404(document_id, user)
    rows = get_messages_for_document(document_id, include_archived=False)
    return {
        "document_id": document_id,
        "messages": [{"role": m.role, "content": m.content} for m in rows],
    }


@router.post("/{document_id}/ask", response_model=ChatResponse)
async def ask_document(
    body: ChatRequest,
    document_id: str = Path(...),
    user: CurrentUser = Depends(get_current_user),
):
    doc = _get_document_or_404(document_id, user)

    if doc.status == "resyncing":
        raise document_resyncing()
    if doc.status == "error":
        raise document_error()

    store = document_stores.get(document_id)
    # Fallback to legacy global store if per-doc store missing but legacy exists
    if store is None or store.index is None:
        # Try chroma_store presence as indicator; if chunks exist but no FAISS index, fabricate answer via simple path
        # For real asks we need FAISS; if missing, treat as not prepared
        if document_id not in chroma_store or not chroma_store[document_id]:
            # Could be legacy single-doc flow: check global store
            if rag_service.store.index is None or not rag_service.store.chunks:
                from app.errors import not_prepared
                raise not_prepared()

    # Use per-document store if available else global
    active_store = store if (store and store.index is not None) else rag_service.store
    # Persist incoming chat turn? The spec doesn't require persisting via ask, but history should reflect asks.
    # We store messages for future history calls.
    from app.db import add_chat_message
    # Store user message
    add_chat_message(document_id, user.id, "user", body.question)

    question = body.question
    chat_history = body.chat_history
    summary = active_store.summary if active_store else ""
    try:
        answer = rag_service.run_corrective_rag(question, chat_history, summary, active_store)
    except Exception as exc:
        # If LLM unavailable etc, propagate as AppError; don't archive.
        # Remove the just-added user message? Keep for debugging.
        raise exc

    add_chat_message(document_id, user.id, "assistant", answer)
    return ChatResponse(answer=answer)


@router.post("/{document_id}/resync")
async def resync_document(
    document_id: str = Path(...),
    user: CurrentUser = Depends(get_current_user),
):
    doc = _get_document_or_404(document_id, user)

    # Set to resyncing immediately to block ask
    doc.status = "resyncing"
    logger.info("Resync started for doc %s by user %s", document_id, user.id)

    # Archive existing chat history (instead of hard delete)
    archived_count = archive_messages(document_id)
    logger.info("Archived %d messages for doc %s", archived_count, document_id)

    # Delete all existing vectors for that document_id from the Chroma collection
    # Simulate: chroma_store[doc_id] cleared and per-doc RagStore cleared
    old_vector_count = len(chroma_store.get(document_id, []))
    chroma_store.pop(document_id, None)
    old_store = document_stores.pop(document_id, None)
    # Also clear per-doc rag store's index if present
    if old_store and old_store.index is not None:
        old_store.index = None
        old_store.chunks = []
    logger.info("Deleted %d vectors for doc %s", old_vector_count, document_id)

    # Re-run chunking and embedding on the document's current content
    try:
        chunks = rag_service.chunk_markdown(doc.content)
        logger.info("Resync chunking produced %d chunks for doc %s", len(chunks), document_id)

        if not chunks:
            raise ValueError("chunking produced no chunks from current content")

        # Re-build vector store (Chroma + FAISS)
        # Generate a fresh summary? The original /prepare generates summary via LLM.
        # For resync we should also regenerate summary if possible.
        summary = ""
        try:
            from app.services.llm_service import generate_summary
            summary = generate_summary(doc.content)
        except Exception as e:
            logger.warning("Resync summary generation failed for %s: %s (using empty summary)", document_id, e)
            summary = old_store.summary if old_store else ""

        new_store = rag_service.RagStore()
        # Build FAISS — may fail if embedding model unavailable
        new_store.build(chunks, summary)
        document_stores[document_id] = new_store
        chroma_store[document_id] = list(chunks)
        logger.info("Resync embedding done for doc %s: %d vectors", document_id, len(chunks))

        doc.status = "ready"
        return {"document_id": document_id, "status": "ready", "chunks": len(chunks), "archived": archived_count}

    except Exception as exc:
        logger.exception("Resync failed for doc %s: %s", document_id, exc)
        # Ensure ask remains blocked — set to error, not stuck in resyncing forever
        doc.status = "error"
        # Purge any partially built store
        document_stores.pop(document_id, None)
        # chroma_store already cleared above; leave empty to indicate no vectors
        # Surface error to caller
        from app.errors import resync_failed
        raise resync_failed(str(exc))
