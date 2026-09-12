# Manual verification — document identity vs markdown comparison

Existing automated e2e (scripts/preview.e2e.mjs) covers preview/mermaid only.
Use these steps to verify the frontend identity fix without a full test harness.

## Prereq
- `localStorage` clear: DevTools → Application → Local Storage → remove `askmymd.*`
- Backend optional (v1 `/prepare`+`/chat` still works even without `/documents` row)

## 1) First prepare mints ID and persists
1. Load app with empty editor.
2. Type `# Doc A` and click "Chat with this document".
3. Open DevTools → `localStorage.getItem('askmymd.document_id')` → non-null UUID/doc-*
4. `localStorage.getItem('askmymd.messages_document_id')` → same ID
5. Refresh page → Chat drawer still "ready", `askmymd.document_id` unchanged.

Expected: `App.documentId` state mirrors stored ID (header Chat stays emerald after refresh).

## 2) Edit same doc keeps history (the bug was history wiped)
1. With history: send a chat message "hello" → assistant reply.
2. Edit markdown: `# Doc A` → `# Doc A!` (one char).
3. Click re-prepare (or just observe that prepare would be triggered).
4. History still shows "hello" + reply.

Old behavior: `messagesDoc !== doc` was true → history cleared. New: ID reuse → `messagesDocumentId === activeId` → keep.

## 3) Re-prepare after backend restart keeps history
1. Restart backend (kills in-memory store) → send chat → get NOT_PREPARED → panel shows "Re-prepare".
2. Click "Re-prepare" (same doc, ID reused).
3. History after re-prepare still visible (not wiped).

## 4) Genuinely new doc clears history
Only these should mint a fresh ID (documented in storage.ts):
- Clearing `localStorage` (or calling `clearDocumentId()`),
- Future explicit "New document" button/menu (does not exist yet),
- Future file upload of a different logical file.

To simulate: `localStorage.clear()` → reload → create new doc → new UUID differs → history cleared on first prepare with new ID.

## 5) Resync now hits /documents/{id}/resync
1. After first prepare (documentId real), open Chat drawer → click resync (refresh icon) → confirm.
2. Network tab: request `POST /documents/<uuid>/resync` via `resyncDocument()`.
3. On success: chat messages cleared, spinner shown during, toast cleared.
4. If backend has no record for client-only UUID (v1 flow, no createDocument), the call 404s with DOCUMENT_NOT_FOUND → fallback to `POST /prepare` so resync still re-indexes (client-side-only decision, out of scope to create backend row yet).

## 6) Automated check
```
node --test frontend/tests/documentIdentity.test.mjs
# 9 tests, covering storage persistence, keep-vs-clear, migration, App wiring
```
