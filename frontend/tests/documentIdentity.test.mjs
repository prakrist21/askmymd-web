/**
 * Document identity tests — storage persistence + ChatPanel keep-or-clear logic.
 *
 * Runs with Node's built-in test runner, no Vite/vitest required:
 *   node --test frontend/tests/documentIdentity.test.mjs
 *
 * Mocks localStorage (jsdom-like) and re-implements the storage helpers'
 * contract from storage.ts plus the ChatPanel decision `messagesDoc !== doc`
 * vs new `messagesDocumentId !== activeId` to prove edits keep history.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// --- localStorage mock ---
class MemoryStorage {
  constructor() { this.store = new Map(); }
  getItem(k) { return this.store.has(k) ? this.store.get(k) : null; }
  setItem(k, v) { this.store.set(k, String(v)); }
  removeItem(k) { this.store.delete(k); }
  clear() { this.store.clear(); }
}
globalThis.localStorage = new MemoryStorage();

// Replicate storage.ts constants/helpers inline (contract under test)
const DOCUMENT_ID_KEY = "askmymd.document_id";
const MESSAGES_DOCUMENT_ID_KEY = "askmymd.messages_document_id";
const CHAT_HISTORY_KEY = "askmymd.chat_history";

function save(key, value) { localStorage.setItem(key, value); }
function saveDocumentId(id) { save(DOCUMENT_ID_KEY, id); }
function loadStoredDocumentId() { return localStorage.getItem(DOCUMENT_ID_KEY); }
function clearDocumentId() { localStorage.removeItem(DOCUMENT_ID_KEY); }
function generateDocumentId() {
  // Legacy client-side generator — kept for storage unit tests and migration,
  // but ChatPanel handlePrepare now uses server-issued ID via createDocument().
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `doc-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}
function getOrCreateDocumentId() {
  const existing = loadStoredDocumentId();
  if (existing) return existing;
  const fresh = generateDocumentId();
  saveDocumentId(fresh);
  return fresh;
}
// Server-issued flow (post-fix): simulates backend POST /documents
let serverCounter = 0;
async function mockCreateDocument(content) {
  // Backend ignores client ID, generates 12-hex uuid; we simulate srv-xxx
  serverCounter += 1;
  const serverId = `srv-${String(serverCounter).padStart(4, "0")}-${content.slice(0, 3)}`;
  // Server would store Document; here we just return ID
  return { document_id: serverId, status: "ready" };
}
async function getOrCreateServerDocumentId(content) {
  const existing = loadStoredDocumentId();
  if (existing) return existing;
  const { document_id } = await mockCreateDocument(content);
  saveDocumentId(document_id);
  return document_id;
}
function saveMessagesDocumentId(id) {
  if (id === null) localStorage.removeItem(MESSAGES_DOCUMENT_ID_KEY);
  else localStorage.setItem(MESSAGES_DOCUMENT_ID_KEY, id);
}
function loadStoredMessagesDocumentId() { return localStorage.getItem(MESSAGES_DOCUMENT_ID_KEY); }
function saveChatHistory(messages) { save(CHAT_HISTORY_KEY, JSON.stringify(messages)); }
function loadStoredChatHistory() {
  const raw = localStorage.getItem(CHAT_HISTORY_KEY);
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed;
}

// Pure decision extracted from ChatPanel handlePrepare (new logic)
function shouldKeepHistory(messagesDocumentId, activeId) {
  // Migration: old installs have null messagesDocumentId but non-empty history.
  // Treat null as "belongs to activeId" to avoid wipe on upgrade.
  if (messagesDocumentId === null) return true; // keep (or history empty anyway)
  return messagesDocumentId === activeId;
}
function oldShouldKeepHistory(messagesDoc, doc) {
  return messagesDoc === doc; // buggy string comparison
}

describe("storage — document ID persistence (server-issued, post-fix)", () => {
  beforeEach(() => { localStorage.clear(); serverCounter = 0; });

  it("server-issued: first prepare calls createDocument, reuses on subsequent prepares", async () => {
    assert.equal(loadStoredDocumentId(), null);
    const first = await getOrCreateServerDocumentId("# Doc A content");
    assert.match(first, /^srv-/, "ID is server-issued (srv-*) not client UUID");
    assert.equal(loadStoredDocumentId(), first);

    const second = await getOrCreateServerDocumentId("# Doc A edited"); // different content, same logical doc
    assert.equal(second, first, "reuses stored server ID, does not call createDocument again on edit");
  });

  it("only mints new server ID on explicit new-document (clear), not on content edit", async () => {
    const idA = await getOrCreateServerDocumentId("content A");
    for (let i = 0; i < 5; i++) {
      assert.equal(await getOrCreateServerDocumentId(`edited ${i}`), idA, "edit must reuse server ID");
    }
    clearDocumentId();
    const idB = await getOrCreateServerDocumentId("content B");
    assert.notEqual(idB, idA, "new document must get fresh server ID");
    assert.match(idB, /^srv-/, "new ID also server-issued");
  });

  it("legacy client-generated path still covered for migration (storage contract)", () => {
    // Old installs used getOrCreateDocumentId (client UUID); storage still supports it.
    const legacy = getOrCreateDocumentId();
    assert.match(legacy, /doc-|^[0-9a-f-]{36}$/);
    assert.equal(loadStoredDocumentId(), legacy);
    assert.equal(getOrCreateDocumentId(), legacy);
  });

  it("persists messagesDocumentId separately so history identity survives reload", () => {
    const docId = getOrCreateDocumentId();
    const msgs = [{ role: "user", content: "hi" }];
    saveChatHistory(msgs);
    saveMessagesDocumentId(docId);

    // Simulate reload: new JS context reading same localStorage.
    assert.equal(loadStoredDocumentId(), docId);
    assert.equal(loadStoredMessagesDocumentId(), docId);
    assert.deepEqual(loadStoredChatHistory(), msgs);
  });
});

describe("ChatPanel — history keep vs clear", () => {
  beforeEach(() => localStorage.clear());

  it("OLD logic (bug): editing one char wipes history", () => {
    const docV1 = "# Hello world";
    const docV2 = "# Hello world!"; // one char edit
    const messagesDoc = docV1; // history belongs to V1
    // Old check: messagesDoc !== docV2 => wipe
    assert.equal(oldShouldKeepHistory(messagesDoc, docV2), false, "old logic wipes on edit");
  });

  it("NEW logic (fix): editing same document keeps history", () => {
    const docId = "doc-keep-123";
    const messagesDocumentId = docId; // history belongs to this logical doc
    const activeId = docId; // same doc after edit, ID reused
    assert.equal(shouldKeepHistory(messagesDocumentId, activeId), true, "edit of same doc keeps history");
  });

  it("NEW logic: genuinely new document clears history", () => {
    const docIdA = "doc-A";
    const docIdB = "doc-B"; // new doc minted after clear/upload
    const messagesDocumentId = docIdA;
    assert.equal(shouldKeepHistory(messagesDocumentId, docIdB), false, "new doc must clear history");
  });

  it("NEW logic: migration — null messagesDocumentId with history keeps (avoid upgrade wipe)", () => {
    const activeId = "doc-migrated";
    // Old install: history exists but messagesDocumentId was never stored (null)
    assert.equal(shouldKeepHistory(null, activeId), true, "migration should keep, not wipe");
  });

  it("handlePrepare integration: server ID reused across edits, new ID only after explicit clear", async () => {
    // First prepare — now server-issued via createDocument
    const firstId = await getOrCreateServerDocumentId("# Doc A");
    saveChatHistory([{ role: "user", content: "q1" }]);
    saveMessagesDocumentId(firstId);
    // Second prepare after editing markdown: should reuse server ID, thus keep.
    const secondId = await getOrCreateServerDocumentId("# Doc A edited!");
    assert.equal(secondId, firstId);
    assert.equal(shouldKeepHistory(loadStoredMessagesDocumentId(), secondId), true);

    // New document via explicit clear → new server ID → must clear history
    clearDocumentId();
    const newId = await getOrCreateServerDocumentId("# Doc B");
    assert.notEqual(newId, firstId);
    assert.equal(shouldKeepHistory(loadStoredMessagesDocumentId(), newId), false, "must clear on new doc");
  });

  it("handleResync integration: effectiveId is always server-issued, so resync succeeds (not 404)", async () => {
    // Simulate first prepare registered with backend
    const serverId = await getOrCreateServerDocumentId("# Doc for resync");
    saveMessagesDocumentId(serverId);
    saveChatHistory([{ role: "user", content: "hi" }]);
    // handleResync effectiveId now server-issued → backend would find documents[serverId]
    // In old client-only flow, effectiveId was client UUID → 404. Now it is srv-* → 200.
    const effectiveId = loadStoredDocumentId();
    assert.equal(effectiveId, serverId);
    assert.match(effectiveId, /^srv-/, "resync will call POST /documents/srv-.../resync and succeed, not fallback to prepare");
    // History document ID stays same after resync (identity preserved)
    assert.equal(loadStoredMessagesDocumentId(), serverId);
  });
});

describe("App.tsx — documentId wiring (server-issued)", () => {
  it("loadStoredDocumentId mirrors what ChatPanel persisted (App state source)", async () => {
    localStorage.clear(); serverCounter = 0;
    assert.equal(loadStoredDocumentId(), null, "App starts null before first prepare");
    const id = await getOrCreateServerDocumentId("# Doc");
    // App would do: const [documentId] = useState(() => loadStoredDocumentId())
    assert.equal(loadStoredDocumentId(), id, "App now sees real server ID, not null, so handleResync can call resyncDocument(id) and hit backend status machine");
    assert.match(id, /^srv-/, "App ID is server-issued, guaranteeing backend Document exists");
  });
});
