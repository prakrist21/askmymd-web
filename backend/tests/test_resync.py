"""Resync feature tests.

Covers:
- resync clears old vectors, re-embeds current content
- archives old chat history, history only returns non-archived
- ask returns 409 while status is resyncing (and after error until retry)
"""
import pytest
from unittest.mock import patch, MagicMock
from fastapi.testclient import TestClient

from app.main import app
from app.db import documents, chat_messages, chroma_store, clear_all, Document, ChatMessageRow
from app.routers.documents import document_stores
from app.services import rag_service

client = TestClient(app)

USER_A = "user-a"
USER_B = "user-b"

def auth_headers(user_id: str):
    return {"Authorization": f"Bearer {user_id}"}

def setup_method():
    clear_all()
    document_stores.clear()
    # Also clear legacy global store
    rag_service.store.index = None
    rag_service.store.chunks = []
    rag_service.store.summary = ""

@pytest.fixture(autouse=True)
def isolate():
    setup_method()
    yield
    setup_method()

def _create_doc(owner=USER_A, content="Hello world doc content. This is the original document."):
    doc = Document(id="doc-123", owner_id=owner, content=content, status="ready")
    documents[doc.id] = doc
    return doc

def test_resync_clears_old_vectors_and_reembeds():
    doc = _create_doc(content="Updated content after edit. New info about cats.")
    # Seed old vectors and chat history
    chroma_store[doc.id] = ["old chunk 1", "old chunk 2"]
    # Fake old FAISS store
    old_store = rag_service.RagStore()
    old_store.chunks = ["old chunk 1", "old chunk 2"]
    # create a dummy faiss index mock
    old_store.index = MagicMock()
    document_stores[doc.id] = old_store
    # Seed chat messages
    chat_messages.append(ChatMessageRow(id="m1", document_id=doc.id, owner_id=USER_A, role="user", content="hi"))
    chat_messages.append(ChatMessageRow(id="m2", document_id=doc.id, owner_id=USER_A, role="assistant", content="hello"))
    assert len([m for m in chat_messages if not m.is_archived]) == 2

    # Mock chunking and embedding to avoid real model
    with patch("app.routers.documents.rag_service.chunk_markdown", return_value=["new chunk cats", "new chunk dogs"]) as mock_chunk, \
         patch("app.services.llm_service.generate_summary", return_value="summary cats"), \
         patch.object(rag_service.RagStore, "build", autospec=True) as mock_build:
        # Make build populate chroma-like side effect and set chunks/index
        def fake_build(self, chunks, summary):
            self.chunks = list(chunks)
            self.summary = summary
            self.index = MagicMock()
            return len(chunks)
        mock_build.side_effect = fake_build

        resp = client.post(f"/documents/{doc.id}/resync", headers=auth_headers(USER_A))
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["status"] == "ready"
        assert data["archived"] == 2
        # Check that old vectors were cleared and new ones present
        assert chroma_store[doc.id] == ["new chunk cats", "new chunk dogs"]
        # History should now be empty (archived)
        assert len([m for m in chat_messages if not m.is_archived and m.document_id == doc.id]) == 0
        # Archived rows still exist
        assert len([m for m in chat_messages if m.is_archived]) == 2
        # Verify re-embed was called with current content
        mock_chunk.assert_called_once_with("Updated content after edit. New info about cats.")
        mock_build.assert_called_once()

        # Verify document status back to ready
        assert documents[doc.id].status == "ready"

        # Verify history endpoint only returns non-archived (empty)
        hist = client.get(f"/documents/{doc.id}/history", headers=auth_headers(USER_A))
        assert hist.status_code == 200
        assert hist.json()["messages"] == []

def test_ask_returns_409_while_resyncing():
    doc = _create_doc()
    doc.status = "resyncing"
    resp = client.post(f"/documents/{doc.id}/ask", headers=auth_headers(USER_A), json={"question": "what?", "chat_history": []})
    assert resp.status_code == 409
    assert resp.json()["code"] == "DOCUMENT_RESYNCING"
    assert "resyncing" in resp.json()["error"].lower()

def test_ask_still_blocked_after_error_status():
    doc = _create_doc()
    doc.status = "error"
    resp = client.post(f"/documents/{doc.id}/ask", headers=auth_headers(USER_A), json={"question": "what?", "chat_history": []})
    assert resp.status_code == 409
    assert resp.json()["code"] == "DOCUMENT_ERROR"

def test_resync_failure_sets_error_and_keeps_blocked():
    doc = _create_doc(content="content that will fail")
    chroma_store[doc.id] = ["old vec"]
    old_store = rag_service.RagStore()
    old_store.chunks = ["old vec"]
    old_store.index = MagicMock()
    document_stores[doc.id] = old_store

    with patch("app.routers.documents.rag_service.chunk_markdown", side_effect=RuntimeError("embedding failed")):
        resp = client.post(f"/documents/{doc.id}/resync", headers=auth_headers(USER_A))
        # resync_failed returns 500
        assert resp.status_code == 500
        assert resp.json()["code"] == "RESYNC_FAILED"
        # Status should be error, not resyncing
        assert documents[doc.id].status == "error"
        # Ask should still be blocked with 409
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

def test_history_filters_archived_after_resync():
    doc = _create_doc(content="fresh content")
    # Add two messages, then resync will archive them
    chat_messages.append(ChatMessageRow(id="m1", document_id=doc.id, owner_id=USER_A, role="user", content="old q"))
    chat_messages.append(ChatMessageRow(id="m2", document_id=doc.id, owner_id=USER_A, role="assistant", content="old a"))
    # Add a new message after archiving simulation by manually archiving
    with patch("app.routers.documents.rag_service.chunk_markdown", return_value=["new chunk"]), \
         patch("app.services.llm_service.generate_summary", return_value="sum"), \
         patch.object(rag_service.RagStore, "build", autospec=True) as mock_build:
        def fake(self, chunks, summary):
            self.chunks = list(chunks)
            self.summary = summary
            self.index = MagicMock()
            return 1
        mock_build.side_effect = fake
        client.post(f"/documents/{doc.id}/resync", headers=auth_headers(USER_A))

    # Add a new message after resync
    chat_messages.append(ChatMessageRow(id="m3", document_id=doc.id, owner_id=USER_A, role="user", content="new q"))

    hist = client.get(f"/documents/{doc.id}/history", headers=auth_headers(USER_A))
    assert hist.status_code == 200
    msgs = hist.json()["messages"]
    assert len(msgs) == 1
    assert msgs[0]["content"] == "new q"
    # Ensure total archived =2, total =3
    assert len(chat_messages) == 3
    assert len([m for m in chat_messages if m.is_archived]) == 2


def test_ask_document_isolation_no_cross_document_leak():
    """Proves the retrieval-scoping fix: ask for doc A never returns chunks from doc B,
    even when B was most recently prepared/resynced and the global store holds B's data.

    Two documents are seeded into document_stores with disjoint chunk vocabularies.
    The module-global rag_service.store is poisoned with doc B's chunks. The RAG
    graph is mocked to avoid real embeddings/LLM; we assert the llm's
    generate_answer receives only A's chunks and that the global store was never
    queried.
    """
    # Two owned documents with disjoint content
    doc_a = Document(id="doc-A", owner_id=USER_A, content="alpha cats " * 20, status="ready")
    doc_b = Document(id="doc-B", owner_id=USER_A, content="beta quantum " * 20, status="ready")
    documents[doc_a.id] = doc_a
    documents[doc_b.id] = doc_b

    chroma_store[doc_a.id] = ["AAA chunk cats unique 111"]
    chroma_store[doc_b.id] = ["BBB chunk quantum unique 999"]

    store_a = rag_service.RagStore()
    store_a.chunks = ["AAA chunk cats unique 111", "AAA second cats"]
    store_a.summary = "summary A cats"
    store_a.index = MagicMock()
    store_b = rag_service.RagStore()
    store_b.chunks = ["BBB chunk quantum unique 999"]
    store_b.summary = "summary B quantum"
    store_b.index = MagicMock()
    document_stores[doc_a.id] = store_a
    document_stores[doc_b.id] = store_b

    # Poison the global store with B's data — mimics B being the most recently
    # prepared/resynced via POST /prepare which writes to rag_service.store.
    rag_service.store.chunks = ["BBB chunk quantum unique 999"]
    rag_service.store.summary = "summary B quantum"
    rag_service.store.index = MagicMock()

    # Mock retrieve on each store so we can assert which store was queried.
    # Using patch.object ensures restoration after the test (isolate fixture
    # clears index/chunks but does not restore patched methods).
    with patch.object(store_a, "retrieve", return_value=["AAA chunk cats unique 111"], autospec=True) as mock_retrieve_a, \
         patch.object(store_b, "retrieve", return_value=["BBB chunk quantum unique 999"], autospec=True) as mock_retrieve_b, \
         patch.object(rag_service.store, "retrieve", return_value=["BBB chunk quantum unique 999"], autospec=True) as mock_retrieve_global, \
         patch("app.services.llm_service.grade_chunks", return_value=True), \
         patch("app.services.llm_service.verify_grounded", return_value=True), \
         patch("app.services.llm_service.generate_answer", return_value="answer from A") as mock_generate:
        resp = client.post(
            f"/documents/{doc_a.id}/ask",
            headers=auth_headers(USER_A),
            json={"question": "what about cats?", "chat_history": []},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["answer"] == "answer from A"

        # generate_answer must have been called with A's chunks, not B's/global
        assert mock_generate.called
        # generate_answer(question, chat_history, retrieved_chunks, summary, ...)
        gen_retrieved = mock_generate.call_args[0][2] if mock_generate.call_args[0] else mock_generate.call_args.kwargs.get("retrieved_chunks")
        assert any("AAA" in c for c in gen_retrieved), f"expected AAA chunks, got {gen_retrieved}"
        assert not any("BBB" in c for c in gen_retrieved), f"leaked BBB chunks into A answer: {gen_retrieved}"
        # Only A's store should have been queried on the direct retrieve path
        mock_retrieve_a.assert_called()
        mock_retrieve_b.assert_not_called()
        mock_retrieve_global.assert_not_called()
        # summary forwarded should be A's summary, not B's/global
        # generate_answer summary is 4th positional arg
        gen_summary = mock_generate.call_args[0][3] if len(mock_generate.call_args[0]) > 3 else mock_generate.call_args.kwargs.get("summary")
        assert gen_summary == "summary A cats"


def test_ask_document_rewrite_also_scoped_to_active_store():
    """Ensures the rewrite node's re-retrieve also closes over the caller-provided
    store. Grading returns irrelevant once so the graph goes rewrite->retrieve,
    and the second retrieval must still hit the per-document store, not the global.
    """
    doc_a = Document(id="doc-A2", owner_id=USER_A, content="alpha cats " * 20, status="ready")
    doc_b = Document(id="doc-B2", owner_id=USER_A, content="beta quantum " * 20, status="ready")
    documents[doc_a.id] = doc_a
    documents[doc_b.id] = doc_b
    chroma_store[doc_a.id] = ["AAA chunk cats 222"]
    chroma_store[doc_b.id] = ["BBB chunk quantum 999"]
    store_a = rag_service.RagStore()
    store_a.chunks = ["AAA chunk cats 222"]
    store_a.summary = "summary A"
    store_a.index = MagicMock()
    store_b = rag_service.RagStore()
    store_b.chunks = ["BBB chunk quantum 999"]
    store_b.summary = "summary B"
    store_b.index = MagicMock()
    document_stores[doc_a.id] = store_a
    document_stores[doc_b.id] = store_b
    rag_service.store.chunks = ["BBB chunk quantum 999"]
    rag_service.store.summary = "summary B"
    rag_service.store.index = MagicMock()

    # First grade -> irrelevant triggers rewrite; second grade after rewritten
    # retrieve will still be irrelevant but hits MAX_CORRECTIONS and goes to generate.
    with patch.object(store_a, "retrieve", return_value=["AAA chunk cats 222"]) as mock_retrieve_a, \
         patch.object(rag_service.store, "retrieve", return_value=["BBB chunk quantum 999"]) as mock_retrieve_global, \
         patch("app.services.llm_service.grade_chunks", side_effect=[False, False]) as mock_grade, \
         patch("app.services.llm_service.rewrite_query", return_value="rewritten cats query") as mock_rewrite, \
         patch("app.services.llm_service.verify_grounded", return_value=True), \
         patch("app.services.llm_service.generate_answer", return_value="final answer A") as mock_generate:
        resp = client.post(
            f"/documents/{doc_a.id}/ask",
            headers=auth_headers(USER_A),
            json={"question": "cats?", "chat_history": []},
        )
        assert resp.status_code == 200
        # Flow is retrieve -> grade(false) -> rewrite (re-retrieves internally) -> retrieve again -> grade -> generate,
        # so 3 retrieve calls hit the active store (initial + 2 after rewrite).
        assert mock_retrieve_a.call_count == 3, f"expected 3 retrieves on active store, got {mock_retrieve_a.call_count}"
        mock_retrieve_global.assert_not_called()
        # The rewritten query should have been used for retrieves after the rewrite
        assert mock_rewrite.called
        second_call_query = mock_retrieve_a.call_args_list[1][0][0]
        assert second_call_query == "rewritten cats query"
        third_call_query = mock_retrieve_a.call_args_list[2][0][0]
        assert third_call_query == "rewritten cats query"
        # generate should still see AAA chunks
        gen_retrieved = mock_generate.call_args[0][2] if mock_generate.call_args[0] else mock_generate.call_args.kwargs.get("retrieved_chunks")
        assert any("AAA" in c for c in gen_retrieved)
        assert not any("BBB" in c for c in gen_retrieved)
