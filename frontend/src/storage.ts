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
