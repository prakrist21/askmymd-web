"""Stage 3: force all tests to use askmymd_test and start empty.

- Sets DATABASE_URL to askmymd_test (different DB from dev askmymd) before any
  app.database engine is created.
- Ensures vector extension + tables exist.
- TRUNCATEs documents/chunks/chat_messages BEFORE and AFTER each test so
  leftover rows from a failed/interrupted run can never bleed into the next.
- Also clears in-memory FAISS stores (document_stores + legacy global store)
  and chroma_store so retrieval isolation tests remain deterministic.
"""

from __future__ import annotations

import os

# Force test DB before any app import that caches the engine.
os.environ["DATABASE_URL"] = "postgresql://postgres:1234@localhost:5432/askmymd_test"

import pytest
from sqlalchemy import text

from app.database import get_engine, Base
import app.db_models  # ensure tables registered
from app.services import rag_service


@pytest.fixture(autouse=True)
def db_isolation():
    engine = get_engine()
    assert engine is not None, "DATABASE_URL must be set to askmymd_test"
    assert engine.url.database == "askmymd_test", f"tests must run on askmymd_test, got {engine.url.database}"

    # Ensure extension + tables exist (idempotent)
    with engine.begin() as conn:
        conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
    Base.metadata.create_all(engine, checkfirst=True)

    # Hard truncate BEFORE test — kills leftovers from a crashed prior run
    with engine.begin() as conn:
        conn.execute(text("TRUNCATE documents, chunks, chat_messages CASCADE"))
    # Stage 5: FAISS per-doc stores removed; only global v1 store remains
    rag_service.store.index = None
    rag_service.store.chunks = []
    rag_service.store.summary = ""

    yield

    # Truncate AFTER test — normal isolation
    with engine.begin() as conn:
        conn.execute(text("TRUNCATE documents, chunks, chat_messages CASCADE"))
    rag_service.store.index = None
    rag_service.store.chunks = []
    rag_service.store.summary = ""
