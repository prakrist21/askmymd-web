"""SQLAlchemy 2.0 declarative models for the Postgres + pgvector layer.

Tables:
- documents — Document metadata + cached Groq summary
- chunks — per-document chunk text + 384-dim embeddings (pgvector)
- chat_messages — archived chat history (unchanged schema, kept for resync)

This module is schema-only in Stage 2. No router or in-memory dict code
is changed here. ``Base`` is imported from ``app.database`` so all models
share the same metadata — a single ``Base.metadata.create_all()`` creates
all three tables.

Prerequisite (once per database):
    CREATE EXTENSION IF NOT EXISTS vector;
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class Document(Base):
    """Persisted document — replaces the in-memory ``db.documents`` dict."""

    __tablename__ = "documents"

    # 12-char hex (uuid4().hex[:12]) for continuity with existing code/tests.
    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: uuid.uuid4().hex[:12])
    owner_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    # Nullable so a row can exist before its first summary is generated.
    summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String, nullable=False, default="ready")  # ready | resyncing | error
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class Chunk(Base):
    """Per-document chunk + embedding — replaces ``db.chroma_store`` + per-doc FAISS.

    Every row belongs to exactly one document. Deleting the document cascades
    to its chunks so no orphan rows survive a delete.
    """

    __tablename__ = "chunks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    document_id: Mapped[str] = mapped_column(
        String, ForeignKey("documents.id", ondelete="CASCADE"), nullable=False, index=True
    )
    chunk_index: Mapped[int] = mapped_column(Integer, nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    # 384 dims matches all-MiniLM-L6-v2 output (verified in Stage 1).
    embedding: Mapped[Vector] = mapped_column(Vector(384), nullable=False)

    __table_args__ = (
        Index("ix_chunks_document_id_chunk_index", "document_id", "chunk_index"),
    )


class ChatMessage(Base):
    """Archived chat messages — unchanged from ``db.ChatMessageRow`` shape.

    Kept exactly as it exists in ``db.py`` because ``archive_messages()``
    still depends on it during resync. Do not revive writes from
    ``ask_document()`` here.
    """

    __tablename__ = "chat_messages"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    document_id: Mapped[str] = mapped_column(
        String, ForeignKey("documents.id", ondelete="CASCADE"), nullable=False, index=True
    )
    owner_id: Mapped[str] = mapped_column(String, nullable=False)
    role: Mapped[str] = mapped_column(String, nullable=False)  # user | assistant
    content: Mapped[str] = mapped_column(Text, nullable=False)
    is_archived: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
