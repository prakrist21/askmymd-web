"""Stage 6: summary caching — cached summary is used on cold start, no Groq call."""

from unittest.mock import patch

from fastapi.testclient import TestClient

from app.db import get_document, update_document, Document, get_chunks
from app import db_models
from app.database import get_engine
from sqlalchemy.orm import Session
from app.main import app

client = TestClient(app)
USER = "summary-user"


def auth_headers(uid: str = USER):
    return {"Authorization": f"Bearer {uid}"}


def _insert_doc(doc: Document) -> Document:
    engine = get_engine()
    with Session(engine) as s:
        row = db_models.Document(id=doc.id, owner_id=doc.owner_id, content=doc.content, status=doc.status, summary=doc.summary)
        s.add(row)
        s.commit()
    return doc


def test_ask_uses_cached_summary_no_groq_call_on_cold_start():
    """Seed a document with summary already in DB, simulate cold start,
    call ask, and assert generate_summary was never called while the
    answer still uses the cached summary."""
    doc = Document(id="doc-sum-123", owner_id=USER, content="# Big Doc\nCats are everywhere. " * 20, status="ready", summary="CACHED summary cats")
    _insert_doc(doc)
    stored = get_document(doc.id)
    assert stored is not None
    if stored.summary != "CACHED summary cats":
        update_document(doc.id, summary="CACHED summary cats")
        stored = get_document(doc.id)
    assert stored.summary == "CACHED summary cats"

    from app.db import insert_chunks
    from app.services.rag_service import chunk_markdown

    chunks = chunk_markdown(stored.content)
    if not get_chunks(doc.id):
        insert_chunks(doc.id, chunks)

    with patch("app.services.llm_service.generate_summary") as mock_summary, \
         patch("app.services.llm_service.grade_chunks", return_value=True), \
         patch("app.services.llm_service.verify_grounded", return_value=True), \
         patch("app.services.llm_service.generate_answer", return_value="answer via cached") as mock_generate:
        resp = client.post(
            f"/documents/{doc.id}/ask",
            headers=auth_headers(),
            json={"question": "what about cats?", "chat_history": []},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["answer"] == "answer via cached"
        mock_summary.assert_not_called()
        assert mock_generate.called
        gen_summary = mock_generate.call_args[0][3] if len(mock_generate.call_args[0]) > 3 else mock_generate.call_args.kwargs.get("summary")
        assert gen_summary == "CACHED summary cats", f"expected cached summary, got {gen_summary!r}"


def test_create_caches_summary_and_resync_overwrites():
    """POST /documents should cache summary; resync should overwrite it."""
    content_v1 = "# V1\nFirst version about cats. " * 10
    with patch("app.services.llm_service.generate_summary", return_value="summary v1 cats") as mock_gen:
        resp = client.post("/documents", headers=auth_headers(), json={"content": content_v1})
        assert resp.status_code == 200
        doc_id = resp.json()["document_id"]
        assert mock_gen.call_count == 1
        stored = get_document(doc_id)
        assert stored.summary == "summary v1 cats"

    update_document(doc_id, content="# V2\nUpdated about quantum physics. " * 10)
    with patch("app.services.llm_service.generate_summary", return_value="summary v2 quantum") as mock_gen2, \
         patch("app.services.rag_service.chunk_markdown", return_value=["new chunk quantum"]):
        resync_resp = client.post(f"/documents/{doc_id}/resync", headers=auth_headers())
        assert resync_resp.status_code == 200
        assert mock_gen2.call_count == 1
        stored2 = get_document(doc_id)
        assert stored2.summary == "summary v2 quantum"
        assert stored2.summary != "summary v1 cats"
