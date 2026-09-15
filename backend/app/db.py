"""DB-backed persistence for documents and chat messages.

Pgvector (``chunks`` table) is the only source of truth for retrieval —
FAISS / chroma_store / RagStore have been removed. ``search_chunks`` uses
``ORDER BY embedding <=> :query_vec LIMIT k``.
"""

from __future__ import annotations

import os
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Dict, List, Optional

from sqlalchemy import text
from sqlalchemy.orm import Session

from sqlalchemy.engine import Engine

from app.database import get_engine
from app import db_models


def _get_engine_safe() -> Engine | None:
    """Return engine or None for test fallback; raise in production."""
    try:
        return get_engine()
    except RuntimeError:
        if os.getenv("PYTEST_CURRENT_TEST"):
            return None
        raise


@dataclass
class Document:
    id: str
    owner_id: str
    content: str
    status: str = "ready"  # ready | resyncing | error
    summary: Optional[str] = None


@dataclass
class ChatMessageRow:
    id: str
    document_id: str
    owner_id: str
    role: str  # user | assistant
    content: str
    is_archived: bool = False


# In-memory fallback only for tests when DATABASE_URL is intentionally unset.
# Guarded by PYTEST_CURRENT_TEST so production never silently uses it.
_mem_documents: Dict[str, Document] = {}
_mem_chat_messages: List[ChatMessageRow] = []


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _row_to_document(row: db_models.Document) -> Document:
    return Document(
        id=row.id,
        owner_id=row.owner_id,
        content=row.content,
        status=row.status,
        summary=row.summary,
    )


def _row_to_chat(row: db_models.ChatMessage) -> ChatMessageRow:
    return ChatMessageRow(
        id=row.id,
        document_id=row.document_id,
        owner_id=row.owner_id,
        role=row.role,
        content=row.content,
        is_archived=row.is_archived,
    )


def _ensure_extension_and_tables() -> None:
    """Create extension + tables if they do not exist (idempotent)."""
    engine = _get_engine_safe()
    if engine is None:
        return
    with engine.begin() as conn:
        conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
    import app.db_models  # noqa: F401
    from app.database import Base

    Base.metadata.create_all(engine, checkfirst=True)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def clear_all() -> None:
    """Truncate all tables (documents/chunks/chat_messages).

    Used by tests. Hard TRUNCATE guarantees no bleed from a previous failed
    run, unlike a pure transaction rollback.
    """
    engine = _get_engine_safe()
    if engine is None:
        if os.getenv("PYTEST_CURRENT_TEST"):
            _mem_documents.clear()
            _mem_chat_messages.clear()
        return
    _ensure_extension_and_tables()
    with engine.begin() as conn:
        conn.execute(text("TRUNCATE documents, chunks, chat_messages, images CASCADE"))
    if os.getenv("PYTEST_CURRENT_TEST"):
        _mem_documents.clear()
        _mem_chat_messages.clear()


def create_document(owner_id: str, content: str, status: str = "ready") -> Document:
    doc_id = uuid.uuid4().hex[:12]
    engine = _get_engine_safe()
    if engine is None:
        if os.getenv("PYTEST_CURRENT_TEST"):
            doc = Document(id=doc_id, owner_id=owner_id, content=content, status=status)
            _mem_documents[doc_id] = doc
            return doc
        raise RuntimeError("DATABASE_URL is not set — cannot create document")
    _ensure_extension_and_tables()
    with Session(engine) as session:
        row = db_models.Document(id=doc_id, owner_id=owner_id, content=content, status=status)
        session.add(row)
        session.commit()
        return _row_to_document(row)


def get_document(document_id: str) -> Optional[Document]:
    engine = _get_engine_safe()
    if engine is None:
        if os.getenv("PYTEST_CURRENT_TEST"):
            return _mem_documents.get(document_id)
        return None
    with Session(engine) as session:
        row = session.get(db_models.Document, document_id)
        if row is None:
            return None
        return _row_to_document(row)


def get_owned_document(document_id: str, owner_id: str) -> Optional[Document]:
    """Fetch a document only if owned by ``owner_id`` — filter at query level.

    Uses ``filter_by(id=..., owner_id=...)`` so the DB enforces ownership
    rather than fetching then comparing in Python.
    """
    engine = _get_engine_safe()
    if engine is None:
        if os.getenv("PYTEST_CURRENT_TEST"):
            doc = _mem_documents.get(document_id)
            if doc and doc.owner_id == owner_id:
                return doc
            return None
        return None
    with Session(engine) as session:
        row = (
            session.query(db_models.Document)
            .filter_by(id=document_id, owner_id=owner_id)
            .first()
        )
        if row is None:
            return None
        return _row_to_document(row)


def update_document(document_id: str, *, content: Optional[str] = None, status: Optional[str] = None, summary: Optional[str] = None) -> Optional[Document]:
    """Update one or more fields of a document; returns updated Document or None."""
    engine = _get_engine_safe()
    if engine is None:
        if os.getenv("PYTEST_CURRENT_TEST"):
            doc = _mem_documents.get(document_id)
            if doc is None:
                return None
            if content is not None:
                doc.content = content
            if status is not None:
                doc.status = status
            if summary is not None:
                doc.summary = summary
            return doc
        return None
    with Session(engine) as session:
        row = session.get(db_models.Document, document_id)
        if row is None:
            return None
        if content is not None:
            row.content = content
        if status is not None:
            row.status = status
        if summary is not None:
            row.summary = summary
        session.commit()
        session.refresh(row)
        return _row_to_document(row)


def add_chat_message(document_id: str, owner_id: str, role: str, content: str, is_archived: bool = False) -> ChatMessageRow:
    engine = _get_engine_safe()
    if engine is None:
        if os.getenv("PYTEST_CURRENT_TEST"):
            row = ChatMessageRow(id=str(uuid.uuid4()), document_id=document_id, owner_id=owner_id, role=role, content=content, is_archived=is_archived)
            _mem_chat_messages.append(row)
            return row
        raise RuntimeError("DATABASE_URL not set — cannot store chat message")
    _ensure_extension_and_tables()
    with Session(engine) as session:
        row = db_models.ChatMessage(
            id=str(uuid.uuid4()), document_id=document_id, owner_id=owner_id, role=role, content=content, is_archived=is_archived
        )
        session.add(row)
        session.commit()
        return _row_to_chat(row)


def get_chat_messages(document_id: Optional[str] = None, *, only_active: bool = False) -> List[ChatMessageRow]:
    engine = _get_engine_safe()
    if engine is None:
        if os.getenv("PYTEST_CURRENT_TEST"):
            result = list(_mem_chat_messages)
            if document_id is not None:
                result = [m for m in result if m.document_id == document_id]
            if only_active:
                result = [m for m in result if not m.is_archived]
            return result
        return []
    with Session(engine) as session:
        q = session.query(db_models.ChatMessage)
        if document_id is not None:
            q = q.filter(db_models.ChatMessage.document_id == document_id)
        if only_active:
            q = q.filter(db_models.ChatMessage.is_archived == False)  # noqa: E712
        rows = q.all()
        return [_row_to_chat(r) for r in rows]


def archive_messages(document_id: str) -> int:
    engine = _get_engine_safe()
    if engine is None:
        if os.getenv("PYTEST_CURRENT_TEST"):
            count = 0
            for m in _mem_chat_messages:
                if m.document_id == document_id and not m.is_archived:
                    m.is_archived = True
                    count += 1
            return count
        return 0
    with Session(engine) as session:
        rows = session.query(db_models.ChatMessage).filter(
            db_models.ChatMessage.document_id == document_id,
            db_models.ChatMessage.is_archived == False,  # noqa: E712
        ).all()
        for r in rows:
            r.is_archived = True
        session.commit()
        return len(rows)


# ---------------------------------------------------------------------------
# Chunk helpers — pgvector is the ONLY retrieval truth.
# ---------------------------------------------------------------------------

def delete_chunks(document_id: str) -> int:
    """Delete all chunk rows for a document. Returns deleted count."""
    engine = _get_engine_safe()
    if engine is None:
        return 0
    with Session(engine) as session:
        count = session.query(db_models.Chunk).filter(db_models.Chunk.document_id == document_id).delete()
        session.commit()
        return count


def insert_chunks(document_id: str, chunks: List[str]) -> int:
    """Embed chunks and insert rows into the chunks table.

    Uses the same ``all-MiniLM-L6-v2`` model and normalized embeddings so
    pgvector cosine distance <=> matches previous FAISS IP.
    Returns inserted count. Raises on embedding failure.
    """
    if not chunks:
        return 0
    engine = _get_engine_safe()
    if engine is None:
        raise RuntimeError("DATABASE_URL not set — cannot insert chunks")
    _ensure_extension_and_tables()
    from app.services.rag_service import _get_embedder

    vectors = _get_embedder().encode(
        chunks, batch_size=32, show_progress_bar=False, normalize_embeddings=True
    )
    import numpy as _np

    if isinstance(vectors, _np.ndarray):
        if vectors.ndim == 1:
            vectors = vectors.reshape(1, -1)
    with Session(engine) as session:
        for idx, (content, vec) in enumerate(zip(chunks, vectors)):
            embedding = vec.tolist() if hasattr(vec, "tolist") else list(vec)  # type: ignore
            row = db_models.Chunk(document_id=document_id, chunk_index=idx, content=content, embedding=embedding)
            session.add(row)
        session.commit()
        return len(chunks)


def get_chunks(document_id: str) -> List[dict]:
    """Return chunk rows as dicts for inspection (tests/trace)."""
    engine = _get_engine_safe()
    if engine is None:
        return []
    with Session(engine) as session:
        rows = (
            session.query(db_models.Chunk)
            .filter(db_models.Chunk.document_id == document_id)
            .order_by(db_models.Chunk.chunk_index)
            .all()
        )
        result = []
        for r in rows:
            emb = r.embedding
            if isinstance(emb, str):
                dim = 384
            elif isinstance(emb, (list, tuple)):
                dim = len(emb)
            else:
                try:
                    dim = len(emb)  # type: ignore
                except Exception:
                    dim = -1
            result.append({"id": r.id, "document_id": r.document_id, "chunk_index": r.chunk_index, "content": r.content, "embedding_dim": dim, "embedding": emb})
        return result


def get_chunk_count(document_id: str) -> int:
    """Return count of chunk rows for a document."""
    engine = _get_engine_safe()
    if engine is None:
        return 0
    with Session(engine) as session:
        return session.query(db_models.Chunk).filter(db_models.Chunk.document_id == document_id).count()


def search_chunks(document_id: str, query: str, k: int = 5) -> List[str]:
    """Pgvector retrieval: filtered by document_id, ORDER BY embedding <=> query LIMIT k."""
    engine = _get_engine_safe()
    if engine is None:
        raise RuntimeError("DATABASE_URL not set — cannot search chunks")
    from app.services.rag_service import _get_embedder

    qvec = _get_embedder().encode([query], normalize_embeddings=True, show_progress_bar=False)[0]
    qvec_str = "[" + ",".join(str(float(x)) for x in qvec) + "]"
    with Session(engine) as session:
        sql = text("SELECT content FROM chunks WHERE document_id = :doc_id ORDER BY embedding <=> CAST(:qvec AS vector) LIMIT :k")
        rows = session.execute(sql, {"doc_id": document_id, "qvec": qvec_str, "k": k}).fetchall()
        return [r[0] for r in rows]


def ensure_chunks(document_id: str) -> int:
    """Backfill for Stage 4 warning-only window: if a ready document has
    zero chunks, re-chunk and re-embed from its current content.
    Returns count after ensuring (0 if still empty, >0 if backfilled).
    """
    if get_chunk_count(document_id) > 0:
        return get_chunk_count(document_id)
    doc = get_document(document_id)
    if not doc or not doc.content or not doc.content.strip():
        return 0
    from app.services.rag_service import chunk_markdown

    chunks = chunk_markdown(doc.content)
    if not chunks:
        return 0
    return insert_chunks(document_id, chunks)


# ---------------------------------------------------------------------------
# Image helpers — raw bytes in Postgres (bytea), scoped to a document
# ---------------------------------------------------------------------------

@dataclass
class ImageRow:
    id: str
    document_id: str
    content_type: str
    data: bytes
    created_at: Optional[datetime] = None


def insert_image(document_id: str, content_type: str, data: bytes) -> str:
    """Store an image's raw bytes for a document. Returns the short image id."""
    if not data:
        raise ValueError("cannot store an empty image")
    engine = _get_engine_safe()
    if engine is None:
        raise RuntimeError("DATABASE_URL not set — cannot store images")
    _ensure_extension_and_tables()
    image_id = uuid.uuid4().hex[:12]
    with Session(engine) as session:
        row = db_models.Image(id=image_id, document_id=document_id, content_type=content_type, data=data)
        session.add(row)
        session.commit()
        return image_id


def get_image(image_id: str) -> Optional[ImageRow]:
    """Return one image row (bytes included) or None."""
    engine = _get_engine_safe()
    if engine is None:
        return None
    with Session(engine) as session:
        row = session.get(db_models.Image, image_id)
        if row is None:
            return None
        return ImageRow(
            id=row.id,
            document_id=row.document_id,
            content_type=row.content_type,
            data=row.data,
            created_at=row.created_at,
        )
