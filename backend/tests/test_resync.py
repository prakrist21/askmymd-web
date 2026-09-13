"""Resync feature tests — Stage 5: pgvector only, no FAISS.

Covers:
- resync clears old chunk rows, re-embeds current content into pgvector
- archives old chat history
- ask returns 409 while status is resyncing (and after error until retry)
- isolation via SQL WHERE document_id (pgvector), not store object
"""

import pytest
from unittest.mock import patch, MagicMock
from fastapi.testclient import TestClient

from app.main import app
from app.db import documents, chat_messages, clear_all, Document, ChatMessageRow, get_document, update_document, get_chunks, get_chunk_count, search_chunks, insert_chunks
from app.services import rag_service

client = TestClient(app)

USER_A = "user-a"
USER_B = "user-b"


def auth_headers(user_id: str):
    return {"Authorization": f"Bearer {user_id}"}


def setup_method():
    clear_all()
    # Also clear legacy global store (v1 /prepare)
    rag_service.store.index = None
    rag_service.store.chunks = []
    rag_service.store.summary = ""


@pytest.fixture(autouse=True)
def isolate(db_isolation):  # db_isolation from conftest.py (askmymd_test, TRUNCATE before/after)
    setup_method()
    yield
    setup_method()


def _create_doc(owner=USER_A, content="Hello world doc content. This is the original document."):
    doc = Document(id="doc-123", owner_id=owner, content=content, status="ready")
    documents[doc.id] = doc
    return doc


def test_resync_clears_old_vectors_and_reembeds():
    doc = _create_doc(content="Updated content after edit. New info about cats.")
    # Seed old DB chunk rows (pgvector) instead of chroma_store/FAISS
    insert_chunks(doc.id, ["old chunk 1", "old chunk 2"])
    assert get_chunk_count(doc.id) == 2
    # Seed chat messages
    chat_messages.append(ChatMessageRow(id="m1", document_id=doc.id, owner_id=USER_A, role="user", content="hi"))
    chat_messages.append(ChatMessageRow(id="m2", document_id=doc.id, owner_id=USER_A, role="assistant", content="hello"))
    assert len([m for m in chat_messages if not m.is_archived]) == 2

    # Mock chunking and summary to avoid LLM, but let insert_chunks use real embeddings
    with patch("app.routers.documents.rag_service.chunk_markdown", return_value=["new chunk cats", "new chunk dogs"]) as mock_chunk, \
         patch("app.services.llm_service.generate_summary", return_value="summary cats"):
        resp = client.post(f"/documents/{doc.id}/resync", headers=auth_headers(USER_A))
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["status"] == "ready"
        assert data["archived"] == 2
        # Check that old DB chunks were cleared and new ones present
        new_chunks = get_chunks(doc.id)
        assert [c["content"] for c in new_chunks] == ["new chunk cats", "new chunk dogs"]
        assert all(c["embedding_dim"] == 384 for c in new_chunks)
        # History should now be empty (archived)
        assert len([m for m in chat_messages if not m.is_archived and m.document_id == doc.id]) == 0
        assert len([m for m in chat_messages if m.is_archived]) == 2
        mock_chunk.assert_called_once_with("Updated content after edit. New info about cats.")
        assert get_document(doc.id).status == "ready"


def test_ask_returns_409_while_resyncing():
    doc = _create_doc()
    update_document(doc.id, status="resyncing")
    doc.status = "resyncing"
    resp = client.post(f"/documents/{doc.id}/ask", headers=auth_headers(USER_A), json={"question": "what?", "chat_history": []})
    assert resp.status_code == 409
    assert resp.json()["code"] == "DOCUMENT_RESYNCING"
    assert "resyncing" in resp.json()["error"].lower()


def test_ask_still_blocked_after_error_status():
    doc = _create_doc()
    update_document(doc.id, status="error")
    doc.status = "error"
    resp = client.post(f"/documents/{doc.id}/ask", headers=auth_headers(USER_A), json={"question": "what?", "chat_history": []})
    assert resp.status_code == 409
    assert resp.json()["code"] == "DOCUMENT_ERROR"


def test_resync_failure_sets_error_and_keeps_blocked():
    doc = _create_doc(content="content that will fail")
    insert_chunks(doc.id, ["old vec"])
    assert get_chunk_count(doc.id) == 1

    with patch("app.routers.documents.rag_service.chunk_markdown", side_effect=RuntimeError("embedding failed")):
        resp = client.post(f"/documents/{doc.id}/resync", headers=auth_headers(USER_A))
        assert resp.status_code == 500
        assert resp.json()["code"] == "RESYNC_FAILED"
        assert get_document(doc.id).status == "error"
        ask_resp = client.post(f"/documents/{doc.id}/ask", headers=auth_headers(USER_A), json={"question": "hi", "chat_history": []})
        assert ask_resp.status_code == 409


def test_resync_404_if_not_owned():
    doc = _create_doc(owner=USER_A)
    resp = client.post(f"/documents/{doc.id}/resync", headers=auth_headers(USER_B))
    assert resp.status_code == 404
    assert resp.json()["code"] == "DOCUMENT_NOT_FOUND"


def test_resync_401_without_auth():
    doc = _create_doc()
    resp = client.post(f"/documents/{doc.id}/resync")
    assert resp.status_code == 401
    assert resp.json()["code"] == "UNAUTHORIZED"


def test_archive_filters_after_resync():
    """Archiving retains rows but marks them; non-archived filter returns only new messages."""
    doc = _create_doc(content="fresh content")
    chat_messages.append(ChatMessageRow(id="m1", document_id=doc.id, owner_id=USER_A, role="user", content="old q"))
    chat_messages.append(ChatMessageRow(id="m2", document_id=doc.id, owner_id=USER_A, role="assistant", content="old a"))
    with patch("app.routers.documents.rag_service.chunk_markdown", return_value=["new chunk"]), \
         patch("app.services.llm_service.generate_summary", return_value="sum"):
        client.post(f"/documents/{doc.id}/resync", headers=auth_headers(USER_A))

    chat_messages.append(ChatMessageRow(id="m3", document_id=doc.id, owner_id=USER_A, role="user", content="new q"))

    non_archived = [m for m in chat_messages if m.document_id == doc.id and not m.is_archived]
    assert len(non_archived) == 1
    assert non_archived[0].content == "new q"
    assert len(chat_messages) == 3
    assert len([m for m in chat_messages if m.is_archived]) == 2


def test_ask_document_isolation_no_cross_document_leak():
    """Stage 5 isolation via SQL: search for doc A never returns doc B's chunks.

    Uses real pgvector query (no mocks on retrieve) — inserts two docs with
    disjoint vocabularies, then calls search_chunks for A and asserts BBB never appears.
    Also exercises the full /ask path with mocked LLM to prove end-to-end isolation.
    """
    # Two owned documents with disjoint content
    doc_a = Document(id="doc-A", owner_id=USER_A, content="alpha cats " * 20, status="ready")
    doc_b = Document(id="doc-B", owner_id=USER_A, content="beta quantum " * 20, status="ready")
    documents[doc_a.id] = doc_a
    documents[doc_b.id] = doc_b

    # Insert distinct chunks with real embeddings (pgvector)
    insert_chunks(doc_a.id, ["AAA chunk cats unique 111", "AAA second cats"])
    insert_chunks(doc_b.id, ["BBB chunk quantum unique 999"])

    # Poison the global store with B's data — should be irrelevant for document ask
    rag_service.store.chunks = ["BBB chunk quantum unique 999"]
    rag_service.store.summary = "summary B quantum"
    rag_service.store.index = MagicMock()

    # Direct pgvector search for A should never return B's chunks
    results_a = search_chunks(doc_a.id, "what about cats?", k=5)
    assert any("AAA" in c for c in results_a), f"expected AAA chunks, got {results_a}"
    assert not any("BBB" in c for c in results_a), f"leaked BBB chunks into A search: {results_a}"

    # Also test via /ask end-to-end with mocked LLM (no real Groq)
    with patch("app.services.llm_service.grade_chunks", return_value=True), \
         patch("app.services.llm_service.verify_grounded", return_value=True), \
         patch("app.services.llm_service.generate_answer", return_value="answer from A") as mock_generate:
        resp = client.post(
            f"/documents/{doc_a.id}/ask",
            headers=auth_headers(USER_A),
            json={"question": "what about cats?", "chat_history": []},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["answer"] == "answer from A"
        assert mock_generate.called
        gen_retrieved = mock_generate.call_args[0][2] if mock_generate.call_args[0] else mock_generate.call_args.kwargs.get("retrieved_chunks")
        assert any("AAA" in c for c in gen_retrieved)
        assert not any("BBB" in c for c in gen_retrieved)


def test_create_via_post_then_resync_succeeds_end_to_end():
    """End-to-end: POST /documents -> resync with same ID -> 200, not 404."""
    with patch("app.services.llm_service.generate_summary", return_value="summary from create"):
        create_resp = client.post(
            "/documents",
            headers=auth_headers(USER_A),
            json={"content": "# Doc via createDocument\nHello backend"},
        )
        assert create_resp.status_code == 200, create_resp.text
        body = create_resp.json()
        assert "document_id" in body
        server_id = body["document_id"]
        assert server_id in documents
        assert get_document(server_id).owner_id == USER_A
        assert get_document(server_id).content == "# Doc via createDocument\nHello backend"
        # Chunks should have been inserted via pgvector (not FAISS)
        assert get_chunk_count(server_id) >= 1
        update_document(server_id, content="# Doc edited\nHello backend edited content for resync")

    with patch("app.services.llm_service.generate_summary", return_value="summary from resync"):
        resync_resp = client.post(f"/documents/{server_id}/resync", headers=auth_headers(USER_A))
        assert resync_resp.status_code == 200, resync_resp.text
        data = resync_resp.json()
        assert data["status"] == "ready"
        assert data["document_id"] == server_id
        assert "chunks" in data
        assert get_document(server_id).status == "ready"
        # Verify chunks now reflect edited content
        chunks = get_chunks(server_id)
        assert any("Hello backend edited" in c["content"] for c in chunks)

    fake_client_id = "00000000-0000-4000-a000-000000000000"
    bad_resp = client.post(f"/documents/{fake_client_id}/resync", headers=auth_headers(USER_A))
    assert bad_resp.status_code == 404
    assert bad_resp.json()["code"] == "DOCUMENT_NOT_FOUND"


def test_ask_document_rewrite_also_scoped_to_active_store():
    """Rewrite re-retrieval also filtered by document_id via pgvector."""
    doc_a = Document(id="doc-A2", owner_id=USER_A, content="alpha cats " * 20, status="ready")
    doc_b = Document(id="doc-B2", owner_id=USER_A, content="beta quantum " * 20, status="ready")
    documents[doc_a.id] = doc_a
    documents[doc_b.id] = doc_b
    insert_chunks(doc_a.id, ["AAA chunk cats 222"])
    insert_chunks(doc_b.id, ["BBB chunk quantum 999"])
    rag_service.store.chunks = ["BBB chunk quantum 999"]
    rag_service.store.summary = "summary B"
    rag_service.store.index = MagicMock()

    # Mock search_chunks to track which doc_id is queried and simulate rewrite flow
    orig_search = search_chunks

    def fake_search(doc_id, query, k=5):
        # Return based on doc_id to prove scoping
        if doc_id == "doc-A2":
            return ["AAA chunk cats 222"]
        return ["BBB chunk quantum 999"]

    with patch("app.db.search_chunks", side_effect=fake_search) as mock_search, \
         patch("app.services.llm_service.grade_chunks", side_effect=[False, False]), \
         patch("app.services.llm_service.rewrite_query", return_value="rewritten cats query") as mock_rewrite, \
         patch("app.services.llm_service.verify_grounded", return_value=True), \
         patch("app.services.llm_service.generate_answer", return_value="final answer A") as mock_generate:
        resp = client.post(
            f"/documents/{doc_a.id}/ask",
            headers=auth_headers(USER_A),
            json={"question": "cats?", "chat_history": []},
        )
        assert resp.status_code == 200
        # All search calls should have been for doc-A2, never for doc-B2 or global
        for call in mock_search.call_args_list:
            assert call.kwargs.get("document_id") == "doc-A2" or call.args[0] == "doc-A2"
        # Stage 7: prove k=7 for rewrite path (TOP_K+2) vs k=5 for initial
        # Calls: initial retrieve k=5, rewrite k=7, second retrieve after rewrite k=7
        assert len(mock_search.call_args_list) == 3, f"expected 3 pgvector searches, got {mock_search.call_args_list}"
        # Use kwargs or args to get k — search_chunks(doc_id, query, k=...)
        def _get_k(call):
            if "k" in call.kwargs:
                return call.kwargs["k"]
            # positional: (doc_id, query, k)
            return call.args[2] if len(call.args) > 2 else None
        assert _get_k(mock_search.call_args_list[0]) == 5, f"first call should be k=5, got {_get_k(mock_search.call_args_list[0])}"
        assert _get_k(mock_search.call_args_list[1]) == 7, f"rewrite call should be k=7, got {_get_k(mock_search.call_args_list[1])}"
        assert _get_k(mock_search.call_args_list[2]) == 7, f"second retrieve after rewrite should be k=7, got {_get_k(mock_search.call_args_list[2])}"
        assert mock_rewrite.called
        gen_retrieved = mock_generate.call_args[0][2] if mock_generate.call_args[0] else mock_generate.call_args.kwargs.get("retrieved_chunks")
        assert any("AAA" in c for c in gen_retrieved)
        assert not any("BBB" in c for c in gen_retrieved)
