"""Stage 4: chunk + embed dual-write proves.

- Creating a document inserts the correct number of chunk rows with non-null
  384-dim embeddings (real model, not mocked).
- Resync deletes old chunk rows before inserting new ones (no stale leftovers).
"""

from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.database import get_engine
from app.db import get_document, update_document, get_chunks, get_chunk_count
from app.main import app
from app.services import rag_service

client = TestClient(app)
USER = "chunk-user"


def auth_headers(uid: str = USER):
    return {"Authorization": f"Bearer {uid}"}


def test_create_inserts_chunk_rows_with_384d_embeddings():
    """POST /documents with real content should create 1+ chunks rows,
    each with a non-null 384-dim embedding (pgvector only, no FAISS)."""
    content = "# Cats\nCats are cute. Dogs are also cute but this doc is about cats. " * 5
    with patch("app.services.llm_service.generate_summary", return_value="irrelevant"):
        resp = client.post("/documents", headers=auth_headers(), json={"content": content})
    assert resp.status_code == 200, resp.text
    doc_id = resp.json()["document_id"]

    engine = get_engine()
    assert engine.url.database == "askmymd_test"
    chunks = get_chunks(doc_id)
    assert len(chunks) >= 1, f"expected at least 1 chunk row, got {chunks}"
    for c in chunks:
        assert c["embedding"] is not None, f"chunk {c['chunk_index']} has null embedding"
        assert c["embedding_dim"] == 384, f"chunk {c['chunk_index']} dim {c['embedding_dim']} != 384"
        assert isinstance(c["content"], str) and len(c["content"]) > 0
        emb = c["embedding"]
        if isinstance(emb, list):
            assert len(emb) == 384
            assert any(abs(x) > 1e-6 for x in emb), "embedding all zeros"
    expected_chunks = rag_service.chunk_markdown(content)
    assert len(chunks) == len(expected_chunks), f"DB chunks {len(chunks)} != chunk_markdown {len(expected_chunks)}"
    # Stage 5: pgvector is the only truth, no FAISS document_stores check
    assert get_chunk_count(doc_id) == len(expected_chunks)
    import psycopg as _psycopg

    with _psycopg.connect("host=localhost port=5432 dbname=askmymd_test user=postgres password=1234") as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT count(*) FROM chunks WHERE document_id=%s;", (doc_id,))
            assert cur.fetchone()[0] == len(expected_chunks)
            cur.execute("SELECT embedding FROM chunks WHERE document_id=%s LIMIT 1;", (doc_id,))
            emb_raw = cur.fetchone()[0]
            assert emb_raw is not None


def test_resync_deletes_old_chunks_no_stale_leftovers():
    """Editing a document and resyncing must delete old chunk rows before inserting new ones."""
    # Create doc via POST (so DB path exercised), then edit content via update_document
    orig_content = "# Original\nThis is the original document about cats. " * 4
    resp = client.post("/documents", headers=auth_headers(), json={"content": orig_content})
    assert resp.status_code == 200
    doc_id = resp.json()["document_id"]

    orig_chunks = get_chunks(doc_id)
    assert len(orig_chunks) >= 1
    orig_contents = {c["content"] for c in orig_chunks}

    # Edit content to something distinct (different vocabulary) and resync
    new_content = "# Updated\nQuantum physics and black holes are fascinating. " * 6
    update_document(doc_id, content=new_content)
    # Verify DB still has old chunks before resync
    before_resync = get_chunks(doc_id)
    assert len(before_resync) == len(orig_chunks)
    assert {c["content"] for c in before_resync} == orig_contents

    # Resync — mock LLM summary to avoid real Groq call, but keep real embedding
    with patch("app.services.llm_service.generate_summary", return_value="summary quantum"):
        resync_resp = client.post(f"/documents/{doc_id}/resync", headers=auth_headers())
    assert resync_resp.status_code == 200, resync_resp.text
    assert resync_resp.json()["status"] == "ready"
    new_expected = rag_service.chunk_markdown(new_content)
    assert resync_resp.json()["chunks"] == len(new_expected)

    # After resync: old chunks must be gone, new chunks must be exactly len(new_expected) and reflect new content
    after_chunks = get_chunks(doc_id)
    assert len(after_chunks) == len(new_expected), f"after {len(after_chunks)} != expected {len(new_expected)}"
    after_contents = [c["content"] for c in after_chunks]
    # No stale orig chunk content should remain
    for orig_c in orig_contents:
        assert orig_c not in after_contents, f"stale chunk leaked after resync: {orig_c[:40]!r}"
    # New content should be present (at least one new chunk contains 'Quantum' or 'physics')
    assert any("Quantum" in c or "physics" in c for c in after_contents), f"new content not in chunks: {after_contents}"
    # Embeddings still 384-dim
    for c in after_chunks:
        assert c["embedding_dim"] == 384
    # Also prove via direct SQL that only new rows exist (separate connection)
    import psycopg as _psycopg

    with _psycopg.connect("host=localhost port=5432 dbname=askmymd_test user=postgres password=1234") as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT count(*) FROM chunks WHERE document_id=%s;", (doc_id,))
            assert cur.fetchone()[0] == len(new_expected)
            # Ensure no row still has old content substring
            cur.execute("SELECT content FROM chunks WHERE document_id=%s;", (doc_id,))
            all_contents = [r[0] for r in cur.fetchall()]
            assert not any("original document about cats" in x for x in all_contents)
    # Stage 5: pgvector only, no FAISS check needed — DB already verified above
