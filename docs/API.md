# API Reference

> Full interactive schemas available at `/docs` (Swagger UI) when the server is running.

Legacy `/prepare` and `/chat` routes have been removed. All endpoints below are current.

## Auth

All endpoints except `GET /health` and `GET /documents/{id}/images/{image_id}` require authentication via one of:
- `Authorization: Bearer <user_id>`
- `X-User-Id: <user_id>`

User_id is an opaque string — no JWT or database lookup. See [SECURITY.md](../SECURITY.md) for caveats.

---

## Health

### `GET /health`

Service health check.

- **Auth:** No
- **Request body:** None
- **Response:** `{ "status": "ok" }`
- **Errors:** None

---

## Documents

### `POST /documents`

Create a document. Chunks the content, embeds it, and stores in pgvector. Generates and caches a summary via Groq.

- **Auth:** Required
- **Request body:**
  - `content` (string, required, 1–50000 chars)
  - `title` (string | null, optional, max 200 chars)
- **Response:** `{ "document_id": "<12-hex>", "status": "ready" }`
- **Errors:**
  - `400 EMPTY_DOCUMENT` — content is empty
  - `422 INVALID_REQUEST` — malformed body
  - `500 RESYNC_FAILED` — chunk embedding/persist failed
  - `503 LLM_UNAVAILABLE` — Groq API unreachable

### `POST /documents/{document_id}/ask`

Ask a question about a document. Runs the corrective-RAG pipeline: retrieve → grade → rewrite (if needed) → generate → verify.

- **Auth:** Required (must own the document)
- **Request body:**
  - `question` (string, required, min 1 char)
  - `chat_history` (array of `{ role: string, content: string }`, optional, default `[]`)
- **Response:** `{ "answer": "<string>" }`
- **Errors:**
  - `404 DOCUMENT_NOT_FOUND` — document doesn't exist or isn't owned by user
  - `400 NOT_PREPARED` — document has no chunks
  - `409 DOCUMENT_RESYNCING` — document is mid-resync
  - `409 DOCUMENT_ERROR` — document is in error state
  - `503 LLM_UNAVAILABLE` — Groq API error during RAG pipeline

### `POST /documents/{document_id}/resync`

Re-chunk, re-embed, and re-generate summary for a document. Archives all existing chat messages.

- **Auth:** Required (must own the document)
- **Request body:** None
- **Response:** `{ "document_id": "<string>", "status": "ready", "chunks": <int>, "archived": <int> }`
- **Errors:**
  - `404 DOCUMENT_NOT_FOUND`
  - `500 RESYNC_FAILED` — chunking or persist failed; document marked `error`

---

## Images

### `POST /documents/{document_id}/images`

Upload an image for a document. Accepts PNG, JPEG, GIF, WebP (validated by magic bytes, not Content-Type header). Max 5 MB.

- **Auth:** Required (must own the document)
- **Request body:** `multipart/form-data` with `file` field
- **Response:** `{ "image_id": "<12-hex>" }`
- **Errors:**
  - `404 DOCUMENT_NOT_FOUND`
  - `400 INVALID_IMAGE_TYPE` — unsupported format or empty file
  - `413 IMAGE_TOO_LARGE` — exceeds 5 MB
  - `500 RESYNC_FAILED` — database persist failed

### `GET /documents/{document_id}/images/{image_id}`

Serve raw image bytes. **Unauthenticated** — the 12-hex image_id acts as a capability token (deliberate design for personal/demo use).

- **Auth:** No
- **Request body:** None
- **Response:** Raw image bytes with correct `Content-Type` header
- **Errors:**
  - `404 IMAGE_NOT_FOUND` — image doesn't exist or doesn't belong to the document
