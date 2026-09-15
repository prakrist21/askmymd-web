"""Resync feature tests — pgvector only."""

import pytest
from unittest.mock import patch
from fastapi.testclient import TestClient

from app.main import app
from app.db import clear_all, Document, ChatMessageRow, get_document, update_document, get_chunks, get_chunk_count, search_chunks, insert_chunks, get_chat_messages, add_chat_message
from app import db_models
from app.database import get_engine
from sqlalchemy.orm import Session

client = TestClient(app)

USER_A = "user-a"
USER_B = "user-b"


def auth_headers(user_id: str):
    return {"Authorization": f"Bearer {user_id}"}


def _insert_doc(doc: Document) -> Document:
    engine = get_engine()
    with Session(engine) as s:
        row = db_models.Document(id=doc.id, owner_id=doc.owner_id, content=doc.content, status=doc.status, summary=doc.summary)
        s.add(row)
        s.commit()
    return doc


def _add_chat(row: ChatMessageRow) -> ChatMessageRow:
    engine = get_engine()
    with Session(engine) as s:
        db_row = db_models.ChatMessage(id=row.id, document_id=row.document_id, owner_id=row.owner_id, role=row.role, content=row.content, is_archived=row.is_archived)
        s.add(db_row)
        s.commit()
    return row


def setup_method():
    clear_all()


@pytest.fixture(autouse=True)
def isolate(db_isolation):
    setup_method()
    yield
    setup_method()


def _create_doc(owner=USER_A, content="Hello world doc content. This is the original document."):
    doc = Document(id="doc-123", owner_id=owner, content=content, status="ready")
    _insert_doc(doc)
    return doc


def test_resync_clears_old_vectors_and_reembeds():
    doc = _create_doc(content="Updated content after edit. New info about cats.")
    insert_chunks(doc.id, ["old chunk 1", "old chunk 2"])
    assert get_chunk_count(doc.id) == 2
    _add_chat(ChatMessageRow(id="m1", document_id=doc.id, owner_id=USER_A, role="user", content="hi"))
    _add_chat(ChatMessageRow(id="m2", document_id=doc.id, owner_id=USER_A, role="assistant", content="hello"))
    assert len([m for m in get_chat_messages() if not m.is_archived]) == 2

    with patch("app.routers.documents.rag_service.chunk_markdown", return_value=["new chunk cats", "new chunk dogs"]) as mock_chunk, \
         patch("app.services.llm_service.generate_summary", return_value="summary cats"):
        resp = client.post(f"/documents/{doc.id}/resync", headers=auth_headers(USER_A))
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["status"] == "ready"
        assert data["archived"] == 2
        new_chunks = get_chunks(doc.id)
        assert [c["content"] for c in new_chunks] == ["new chunk cats", "new chunk dogs"]
        assert all(c["embedding_dim"] == 384 for c in new_chunks)
        assert len([m for m in get_chat_messages() if not m.is_archived and m.document_id == doc.id]) == 0
        assert len([m for m in get_chat_messages() if m.is_archived]) == 2
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
    _add_chat(ChatMessageRow(id="m1", document_id=doc.id, owner_id=USER_A, role="user", content="old q"))
    _add_chat(ChatMessageRow(id="m2", document_id=doc.id, owner_id=USER_A, role="assistant", content="old a"))
    with patch("app.routers.documents.rag_service.chunk_markdown", return_value=["new chunk"]), \
         patch("app.services.llm_service.generate_summary", return_value="sum"):
        client.post(f"/documents/{doc.id}/resync", headers=auth_headers(USER_A))

    _add_chat(ChatMessageRow(id="m3", document_id=doc.id, owner_id=USER_A, role="user", content="new q"))

    non_archived = [m for m in get_chat_messages() if m.document_id == doc.id and not m.is_archived]
    assert len(non_archived) == 1
    assert non_archived[0].content == "new q"
    assert len(get_chat_messages()) == 3
    assert len([m for m in get_chat_messages() if m.is_archived]) == 2


def test_ask_document_isolation_no_cross_document_leak():
    """Stage 5 isolation via SQL: search for doc A never returns doc B's chunks."""
    doc_a = Document(id="doc-A", owner_id=USER_A, content="alpha cats " * 20, status="ready")
    doc_b = Document(id="doc-B", owner_id=USER_A, content="beta quantum " * 20, status="ready")
    _insert_doc(doc_a)
    _insert_doc(doc_b)

    insert_chunks(doc_a.id, ["AAA chunk cats unique 111", "AAA second cats"])
    insert_chunks(doc_b.id, ["BBB chunk quantum unique 999"])

    results_a = search_chunks(doc_a.id, "what about cats?", k=5)
    assert any("AAA" in c for c in results_a), f"expected AAA chunks, got {results_a}"
    assert not any("BBB" in c for c in results_a), f"leaked BBB chunks into A search: {results_a}"

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
        assert get_document(server_id) is not None
        assert get_document(server_id).owner_id == USER_A
        assert get_document(server_id).content == "# Doc via createDocument\nHello backend"
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
    _insert_doc(doc_a)
    _insert_doc(doc_b)
    insert_chunks(doc_a.id, ["AAA chunk cats 222"])
    insert_chunks(doc_b.id, ["BBB chunk quantum 999"])

    def fake_search(doc_id, query, k=5):
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
        for call in mock_search.call_args_list:
            assert call.kwargs.get("document_id") == "doc-A2" or call.args[0] == "doc-A2"
        assert len(mock_search.call_args_list) == 3, f"expected 3 pgvector searches, got {mock_search.call_args_list}"
        def _get_k(call):
            if "k" in call.kwargs:
                return call.kwargs["k"]
            return call.args[2] if len(call.args) > 2 else None
        assert _get_k(mock_search.call_args_list[0]) == 5, f"first call should be k=5, got {_get_k(mock_search.call_args_list[0])}"
        assert _get_k(mock_search.call_args_list[1]) == 7, f"rewrite call should be k=7, got {_get_k(mock_search.call_args_list[1])}"
        assert _get_k(mock_search.call_args_list[2]) == 7, f"second retrieve after rewrite should be k=7, got {_get_k(mock_search.call_args_list[2])}"
        assert mock_rewrite.called
        gen_retrieved = mock_generate.call_args[0][2] if mock_generate.call_args[0] else mock_generate.call_args.kwargs.get("retrieved_chunks")
        assert any("AAA" in c for c in gen_retrieved)
        assert not any("BBB" in c for c in gen_retrieved)
