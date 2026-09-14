"""Document-scoped routes: resync, ask, images — Stage 5 pgvector only.

Stage 5: retrieval is ``SELECT ... FROM chunks WHERE document_id=:id
ORDER BY embedding <=> :query_vec LIMIT k`` (k=5, k=7 for rewrite).
FAISS (document_stores / chroma_store) has been removed — pgvector is the
only source of truth. ``create_document`` and ``resync`` now treat chunk
persistence failures as fatal (status error), not warning-only. ``ask`` also
backfills any document that was left with zero chunks during Stage 4's
warning window via ``ensure_chunks``.
"""

import logging

from fastapi import APIRouter, Depends, File, Path, Response, UploadFile

from app.auth import CurrentUser, get_current_user
from app.db import (
    archive_messages,
    create_document as db_create_document,
    Document,
    ensure_chunks,
    get_chunk_count,
    get_document,
    get_image,
    insert_chunks,
    delete_chunks,
    insert_image,
    update_document,
)
from app.errors import (
    document_error,
    document_not_found,
    document_resyncing,
    image_not_found,
    image_too_large,
    invalid_image_type,
    resync_failed,
)
from app.models import ChatRequest, ChatResponse
from app.services import rag_service

logger = logging.getLogger("askmymd.documents")

router = APIRouter(prefix="/documents", tags=["documents"])

# Upload cap. 5 MB is a sensible balance: it comfortably covers photos and
# screenshots after browser-side compression (the toolbar already downscales
# anything over ~2.5 MB), while keeping Postgres rows, WAL traffic, and
# request bodies bounded. It also matches the kind of cap GitHub, Slack, and
# Notion use for inline image uploads.
MAX_IMAGE_BYTES = 5 * 1024 * 1024

# Exact content types accepted. Sniffed from the bytes themselves — never
# trusted from the client's Content-Type header, which is trivially spoofed.
# Format: (magic bytes prefix, canonical content type, extension hint)
_IMAGE_SIGNATURES = (
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"GIF87a", "image/gif"),
    (b"GIF89a", "image/gif"),
    (b"RIFF", "image/webp"),  # RIFF....WEBP — verified separately
)


def _get_document_or_404(document_id: str, user: CurrentUser) -> Document:
    doc = get_document(document_id)
    if not doc or doc.owner_id != user.id:
        raise document_not_found()
    return doc


def _sniff_image_type(data: bytes) -> str:
    """Return the canonical image content type based on magic bytes, or raise.

    WebP is RIFF-based and needs its own check: bytes 0-3 are 'RIFF' and
    bytes 8-11 are 'WEBP'.
    """
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    for magic, content_type in _IMAGE_SIGNATURES:
        if data.startswith(magic) and magic != b"RIFF":
            return content_type
    raise invalid_image_type()


@router.post("")
async def create_document(
    body: dict,
    user: CurrentUser = Depends(get_current_user),
):
    """Create a document for the authenticated user. Helper for tests and UI.

    Request body: { "content": str, "title": Optional[str] }
    Stage 5: chunks are embedded and inserted into pgvector. Failures are
    now loud — the document is marked error instead of warning-only.
    """
    content = body.get("content", "")
    doc = db_create_document(owner_id=user.id, content=content, status="ready")
    doc_id = doc.id

    # Stage 6: generate and cache summary once on create (skip Groq on cold start)
    if content and content.strip():
        try:
            from app.services.llm_service import generate_summary

            try:
                summary = generate_summary(content)
                update_document(doc_id, summary=summary)
                doc.summary = summary
                logger.info("Cached summary for doc %s (%d chars)", doc_id, len(summary))
            except Exception as e:
                logger.warning("Summary generation failed for doc %s: %s (leaving summary null)", doc_id, e)
        except Exception:
            pass

    if content and content.strip():
        try:
            chunks = rag_service.chunk_markdown(content)
            if chunks:
                # Stage 5: only pgvector, no FAISS. Failure is fatal.
                try:
                    insert_chunks(doc_id, chunks)
                    logger.info("Persisted %d chunks to DB for doc %s (pgvector)", len(chunks), doc_id)
                except Exception as e:
                    logger.warning("DB chunk persist failed for doc %s: %s (failing request)", doc_id, e)
                    update_document(doc_id, status="error")
                    doc.status = "error"
                    # Surface as 500 so caller knows persistence failed
                    from app.errors import resync_failed

                    raise resync_failed(str(e))
        except Exception as e:
            # resync_failed already raised above will propagate; this catches chunking failures
            if isinstance(e, Exception) and "RESYNC" in str(type(e)):
                raise
            logger.warning("create_document chunking failed %s: %s", doc_id, e)
            update_document(doc_id, status="error")
            doc.status = "error"
            # Still return 200 with error status for empty-content path? Keep previous behaviour
            # but chunk persist failures already raised.

    return {"document_id": doc_id, "status": doc.status}


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

    # Stage 5 backfill: if document was left with zero chunks from Stage 4 warning window,
    # re-embed now so retrieval has something to search.
    try:
        if get_chunk_count(document_id) == 0:
            logger.info("Backfill: document %s has 0 chunks, re-embedding", document_id)
            ensured = ensure_chunks(document_id)
            logger.info("Backfill ensured %d chunks for doc %s", ensured, document_id)
            if ensured == 0:
                from app.errors import not_prepared

                raise not_prepared()
    except Exception as e:
        # If backfill itself fails, treat as not prepared / error
        logger.warning("Backfill failed for doc %s: %s", document_id, e)
        from app.errors import not_prepared

        # If doc has no chunks after backfill attempt, ask cannot proceed
        if get_chunk_count(document_id) == 0:
            raise not_prepared()

    question = body.question
    chat_history = body.chat_history
    summary = doc.summary or ""
    # Stage 5: retrieval via pgvector filtered by document_id (k=5, k=7 in rewrite)
    answer = rag_service.run_corrective_rag(question, chat_history, summary, document_id=document_id)
    return ChatResponse(answer=answer)


@router.post("/{document_id}/resync")
async def resync_document(
    document_id: str = Path(...),
    user: CurrentUser = Depends(get_current_user),
):
    doc = _get_document_or_404(document_id, user)

    update_document(document_id, status="resyncing")
    doc.status = "resyncing"
    logger.info("Resync started for doc %s by user %s", document_id, user.id)

    archived_count = archive_messages(document_id)
    logger.info("Archived %d messages for doc %s", archived_count, document_id)

    # Stage 5: delete only from DB (pgvector). FAISS removed.
    try:
        db_deleted = delete_chunks(document_id)
        logger.info("Deleted %d rows (DB) for doc %s", db_deleted, document_id)
    except Exception as e:
        logger.warning("DB chunk delete failed for doc %s: %s", document_id, e)
        db_deleted = 0

    try:
        chunks = rag_service.chunk_markdown(doc.content)
        logger.info("Resync chunking produced %d chunks for doc %s", len(chunks), document_id)

        if not chunks:
            raise ValueError("chunking produced no chunks from current content")

        summary = ""
        try:
            from app.services.llm_service import generate_summary

            summary = generate_summary(doc.content)
            # Cache summary for cold rebuilds (Stage 6 will formalize, but store now)
            update_document(document_id, summary=summary)
        except Exception as e:
            logger.warning("Resync summary generation failed for %s: %s (using empty summary)", document_id, e)
            summary = doc.summary or ""

        # Stage 5: persist to pgvector only, no FAISS. Failure is fatal.
        insert_chunks(document_id, chunks)
        logger.info("Persisted %d resynced chunks to DB for doc %s", len(chunks), document_id)

        update_document(document_id, status="ready")
        doc.status = "ready"
        return {"document_id": document_id, "status": "ready", "chunks": len(chunks), "archived": archived_count}

    except Exception as exc:
        logger.exception("Resync failed for doc %s: %s", document_id, exc)
        update_document(document_id, status="error")
        doc.status = "error"
        # Purge any partially inserted chunks (delete again to leave clean)
        try:
            delete_chunks(document_id)
        except Exception:
            pass
        from app.errors import resync_failed

        raise resync_failed(str(exc))


# ---------------------------------------------------------------------------
# Images — upload (multipart) and serve raw bytes
# ---------------------------------------------------------------------------


@router.post("/{document_id}/images")
async def upload_image(
    document_id: str = Path(...),
    file: UploadFile = File(...),
    user: CurrentUser = Depends(get_current_user),
):
    """Upload an image for a document; returns {"image_id": "<short id>"}.

    The id is what the frontend embeds in markdown as
    ![alt](/documents/{document_id}/images/{image_id}). Validation is by
    content (magic bytes), not the client-declared Content-Type.
    """
    _get_document_or_404(document_id, user)

    data = await file.read()
    if len(data) > MAX_IMAGE_BYTES:
        raise image_too_large()
    if not data:
        raise invalid_image_type()

    sniffed = _sniff_image_type(data)
    try:
        image_id = insert_image(document_id, sniffed, data)
    except Exception as e:
        logger.warning("Image persist failed for doc %s: %s", document_id, e)
        raise resync_failed(str(e))
    logger.info("Stored image %s (%d bytes, %s) for doc %s", image_id, len(data), sniffed, document_id)
    return {"image_id": image_id}


@router.get("/{document_id}/images/{image_id}")
async def get_image_endpoint(
    document_id: str = Path(...),
    image_id: str = Path(...),
):
    """Serve the raw image bytes with the correct Content-Type header.

    Deliberately unauthenticated: it must work as a plain <img src>, and the
    12-hex id is the capability token (same trust model as a shareable file
    URL). 404 covers both 'document gone (cascade)' and 'bad id'.
    """
    row = get_image(image_id)
    if row is None or row.document_id != document_id:
        raise image_not_found()
    return Response(content=row.data, media_type=row.content_type)
