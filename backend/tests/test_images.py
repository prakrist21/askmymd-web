"""Image upload/serve tests — Postgres bytea storage via /documents/{id}/images.

Covers:
- upload returns a short image_id usable as a markdown reference
- GET serves the exact bytes uploaded (byte-for-byte) with the right Content-Type
- deleting the document cascades to its images (no orphan bytea rows)
- non-image payloads are rejected by magic-byte sniffing (even with a spoofed Content-Type)
- oversized uploads (> 5 MB) are rejected with IMAGE_TOO_LARGE
- 404 for unknown ids, wrong document scoping, and 401/404 auth/ownership on upload
"""

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.db import clear_all, create_document, get_image, insert_image
from app.database import get_engine
from sqlalchemy import text

client = TestClient(app)

USER_A = "user-a"
USER_B = "user-b"

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def auth_headers(user_id: str):
    return {"Authorization": f"Bearer {user_id}"}


def _doc_id() -> str:
    return create_document(owner_id=USER_A, content="doc for images", status="ready").id


@pytest.fixture(autouse=True)
def isolate(db_isolation):  # db_isolation from conftest.py (askmymd_test, TRUNCATE before/after)
    clear_all()
    yield
    clear_all()


def test_upload_returns_reference_and_serves_bytes_identically():
    doc_id = _doc_id()
    # A small but structurally plausible PNG payload (signature + IHDR + extra bytes)
    png_bytes = (
        PNG_MAGIC
        + b"\x00\x00\x00\rIHDR"
        + b"\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89"
        + b"IDAT-real-pixel-data-here"
    )
    resp = client.post(
        f"/documents/{doc_id}/images",
        files={"file": ("shot.png", png_bytes, "image/png")},
        headers=auth_headers(USER_A),
    )
    assert resp.status_code == 200, resp.text
    image_id = resp.json()["image_id"]
    assert image_id and len(image_id) == 12

    # The id is embeddable as a normal markdown image reference
    markdown_ref = f"![shot](/documents/{doc_id}/images/{image_id})"
    assert f"/documents/{doc_id}/images/{image_id}" in markdown_ref

    served = client.get(f"/documents/{doc_id}/images/{image_id}")
    assert served.status_code == 200
    assert served.headers["content-type"].startswith("image/png")
    assert served.content == png_bytes  # byte-for-byte identical roundtrip


def test_jpeg_upload_gets_canonical_content_type():
    doc_id = _doc_id()
    jpeg_bytes = b"\xff\xd8\xff" + b"\xe0" + b"JFIF-ish payload"
    resp = client.post(
        f"/documents/{doc_id}/images",
        files={"file": ("photo.jpg", jpeg_bytes, "image/jpeg")},
        headers=auth_headers(USER_A),
    )
    assert resp.status_code == 200
    served = client.get(f"/documents/{doc_id}/images/{resp.json()['image_id']}")
    assert served.headers["content-type"].startswith("image/jpeg")
    assert served.content == jpeg_bytes


def test_delete_document_cascades_to_images():
    doc_id = _doc_id()
    image_id = insert_image(doc_id, "image/png", PNG_MAGIC + b"payload")
    assert get_image(image_id) is not None

    engine = get_engine()
    with engine.begin() as conn:
        conn.execute(text("DELETE FROM documents WHERE id = :d"), {"d": doc_id})

    assert get_image(image_id) is None  # cascade removed the bytea row


def test_non_image_rejected_even_with_spoofed_content_type():
    doc_id = _doc_id()
    resp = client.post(
        f"/documents/{doc_id}/images",
        # Liar header: declares image/png but bytes are plain text
        files={"file": ("evil.png", b"#!/bin/sh\nrm -rf /", "image/png")},
        headers=auth_headers(USER_A),
    )
    assert resp.status_code == 400
    body = resp.json()
    assert body["code"] == "INVALID_IMAGE_TYPE"
    assert "image" in body["error"].lower()


def test_oversized_upload_rejected_with_413():
    doc_id = _doc_id()
    big = PNG_MAGIC + b"0" * (5 * 1024 * 1024)  # 8 + 5 MiB > 5 MiB cap
    resp = client.post(
        f"/documents/{doc_id}/images",
        files={"file": ("big.png", big, "image/png")},
        headers=auth_headers(USER_A),
    )
    assert resp.status_code == 413
    body = resp.json()
    assert body["code"] == "IMAGE_TOO_LARGE"
    assert "5 MB" in body["error"]


def test_get_unknown_or_mismatched_image_is_404():
    doc_id = _doc_id()
    image_id = insert_image(doc_id, "image/png", PNG_MAGIC + b"payload")

    resp = client.get(f"/documents/{doc_id}/images/doesnotexist")
    assert resp.status_code == 404
    assert resp.json()["code"] == "IMAGE_NOT_FOUND"

    # Image exists but belongs to another document path → 404, not a leak
    wrong_doc = client.get(f"/documents/other-doc/images/{image_id}")
    assert wrong_doc.status_code == 404


def test_upload_requires_auth_and_ownership():
    doc_id = _doc_id()

    unauth = client.post(
        f"/documents/{doc_id}/images",
        files={"file": ("x.png", PNG_MAGIC, "image/png")},
    )
    assert unauth.status_code == 401
    assert unauth.json()["code"] == "UNAUTHORIZED"

    other = client.post(
        f"/documents/{doc_id}/images",
        files={"file": ("x.png", PNG_MAGIC, "image/png")},
        headers=auth_headers(USER_B),
    )
    assert other.status_code == 404
    assert other.json()["code"] == "DOCUMENT_NOT_FOUND"


def test_upload_to_missing_document_is_404():
    resp = client.post(
        "/documents/no-such-doc/images",
        files={"file": ("x.png", PNG_MAGIC, "image/png")},
        headers=auth_headers(USER_A),
    )
    assert resp.status_code == 404
    assert resp.json()["code"] == "DOCUMENT_NOT_FOUND"
