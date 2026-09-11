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
