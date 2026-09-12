/**
 * localStorage persistence for the app's state (Phase 6.5).
 *
 * Keys are versioned with an `askmymd.` prefix so a future format change can
 * bump the key instead of migrating. All reads are defensive: a missing or
 * corrupt value restores as empty rather than crashing the app.
 */

const MARKDOWN_KEY = "askmymd.markdown_content";
const CHAT_HISTORY_KEY = "askmymd.chat_history";
const PREPARED_KEY = "askmymd.prepared";
const THEME_KEY = "askmymd.theme";
const DOCUMENT_ID_KEY = "askmymd.document_id";
/**
 * Document identity tracking (fix for history wipe on edits).
 *
 * - A stable document ID represents "the same document" across edits.
 * - markdown content is mutable; document ID is immutable for the lifetime
 *   of a logical document.
 *
 * When a new ID is generated vs reused:
 *  - GENERATED: first ever prepare (no stored ID), or explicit "new document"
 *    action. Explicit new-document triggers are currently NONE in the UI —
 *    future triggers will be: file upload of a new file, "New document"
 *    button/ menu item, or clearing localStorage. See `generateAndPersistDocumentId`.
 *  - REUSED: subsequent edits and re-prepares of the SAME logical document.
 *    Any text change, even deleting a character, reuses the stored ID so chat
 *    history is retained.
 *
 * Backend note: IDs are client-side for v1 `/prepare`+`/chat` flow. The
 * `/documents/{id}` backend record is NOT yet created on prepare; that is
 * out of scope and kept client-side until we wire `createDocument()`.
 * When `resyncDocument()` is called with a client-only ID the backend will
 * 404; the caller should treat that as "no backend record yet" and fallback
 * if needed (still client-side only).
 */
const MESSAGES_DOCUMENT_ID_KEY = "askmymd.messages_document_id";

/** One chat bubble. Shared by ChatPanel and the persistence helpers. */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

function save(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // localStorage unavailable (quota / private mode) — persistence is
    // best-effort, the app still works without it.
  }
}

export function saveMarkdown(markdown: string) {
  save(MARKDOWN_KEY, markdown);
}

export function saveChatHistory(messages: ChatMessage[]) {
  save(CHAT_HISTORY_KEY, JSON.stringify(messages));
}

export function savePrepared(prepared: boolean) {
  save(PREPARED_KEY, prepared ? "true" : "false");
}

export function loadStoredMarkdown(): string {
  try {
    return localStorage.getItem(MARKDOWN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function loadStoredChatHistory(): ChatMessage[] {
  try {
    const raw = localStorage.getItem(CHAT_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (m): m is ChatMessage =>
        m &&
        typeof m === "object" &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string"
    );
  } catch {
    return [];
  }
}

export function loadStoredPrepared(): boolean {
  try {
    return localStorage.getItem(PREPARED_KEY) === "true";
  } catch {
    return false;
  }
}

/** Preview theme. Anything other than a stored "light" restores dark —
 *  the app chrome is dark-first, so dark is the safe default. */
export function saveTheme(theme: "dark" | "light") {
  save(THEME_KEY, theme);
}

export function loadStoredTheme(): "dark" | "light" {
  try {
    return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function saveDocumentId(id: string) {
  save(DOCUMENT_ID_KEY, id);
}

export function loadStoredDocumentId(): string | null {
  try {
    return localStorage.getItem(DOCUMENT_ID_KEY);
  } catch {
    return null;
  }
}

export function clearDocumentId() {
  try {
    localStorage.removeItem(DOCUMENT_ID_KEY);
  } catch {
    // ignore
  }
}

/**
 * Generate a new stable document ID client-side.
 * Uses crypto.randomUUID when available for collision-safe IDs.
 */
export function generateDocumentId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // fall through to Math.random fallback
  }
  return `doc-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Ensure a document ID exists: return stored one if present, otherwise
 * generate, persist, and return a new one. Call ONLY on first prepare
 * or explicit new-document — NOT on every edit.
 */
export function getOrCreateDocumentId(): string {
  const existing = loadStoredDocumentId();
  if (existing) return existing;
  const fresh = generateDocumentId();
  saveDocumentId(fresh);
  return fresh;
}

/**
 * Which document the current `messages` belong to.
 * Persisted so history identity survives reload.
 */
export function saveMessagesDocumentId(id: string | null) {
  try {
    if (id === null) {
      localStorage.removeItem(MESSAGES_DOCUMENT_ID_KEY);
    } else {
      localStorage.setItem(MESSAGES_DOCUMENT_ID_KEY, id);
    }
  } catch {
    // best-effort
  }
}

export function loadStoredMessagesDocumentId(): string | null {
  try {
    return localStorage.getItem(MESSAGES_DOCUMENT_ID_KEY);
  } catch {
    return null;
  }
}
