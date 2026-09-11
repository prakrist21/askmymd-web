const BACKEND_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8000";

/** API error carrying the backend's machine-readable { error, code } shape. */
export class ApiError extends Error {
  code: string;

  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

async function parseError(res: Response): Promise<ApiError> {
  try {
    const body = await res.json();
    if (body?.error && body?.code) {
      return new ApiError(body.error, body.code);
    }
  } catch {
    // fall through to generic message
  }
  return new ApiError(`Request failed with status ${res.status}`, "UNKNOWN");
}

/** Network-level failure (backend down, CORS, etc.) — no response at all. */
function networkError(): ApiError {
  return new ApiError(
    "Could not reach the backend — is the server running?",
    "NETWORK_ERROR"
  );
}

/** User-facing message per known API error code; unmapped codes use the
 * backend's own message, which is already written for humans. */
const FRIENDLY_MESSAGES: Record<string, string> = {
  FILE_TOO_LARGE:
    "This document exceeds the 3,000-word limit. Please shorten it and try again.",
  LLM_UNAVAILABLE:
    "The AI service is temporarily unavailable. Please try again in a moment.",
  DOCUMENT_RESYNCING:
    "Document is resyncing — please wait a moment and try again.",
  DOCUMENT_ERROR:
    "Document is in an error state — please resync again.",
};

/** Map any thrown error to a short, user-facing message. `fallback` is used
 * for non-ApiError throws (unexpected bugs, JSON parsing, etc.). */
export function friendlyMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    return FRIENDLY_MESSAGES[err.code] ?? err.message;
  }
  return fallback;
}

export async function checkHealth(): Promise<{ status: string }> {
  const res = await fetch(`${BACKEND_URL}/health`);
  if (!res.ok) {
    throw new Error(`Health check failed with status ${res.status}`);
  }
  return res.json();
}

export async function prepareDocument(
  markdownContent: string
): Promise<{ ready: boolean }> {
  let res: Response;
  try {
    res = await fetch(`${BACKEND_URL}/prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown_content: markdownContent }),
    });
  } catch {
    throw networkError();
  }
  if (!res.ok) throw await parseError(res);
  return res.json();
}

export async function sendChatMessage(
  question: string,
  chatHistory: { role: string; content: string }[]
): Promise<{ answer: string }> {
  let res: Response;
  try {
    res = await fetch(`${BACKEND_URL}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, chat_history: chatHistory }),
    });
  } catch {
    throw networkError();
  }
  if (!res.ok) throw await parseError(res);
  return res.json();
}

function authHeaders(): Record<string, string> {
  // Simple demo auth — backend expects Bearer <user_id>.
  // In production this would be a real JWT; for the demo we use a stable id
  // stored in localStorage so the same user owns the same documents.
  try {
    let uid = localStorage.getItem("askmymd.user_id");
    if (!uid) {
      uid = `user-${Math.random().toString(36).slice(2, 9)}`;
      localStorage.setItem("askmymd.user_id", uid);
    }
    return { Authorization: `Bearer ${uid}` };
  } catch {
    return { Authorization: "Bearer demo-user" };
  }
}

export async function resyncDocument(documentId: string): Promise<{ status: string; chunks?: number }> {
  let res: Response;
  try {
    res = await fetch(`${BACKEND_URL}/documents/${encodeURIComponent(documentId)}/resync`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
    });
  } catch {
    throw networkError();
  }
  if (!res.ok) throw await parseError(res);
  return res.json();
}

export async function askDocument(
  documentId: string,
  question: string,
  chatHistory: { role: string; content: string }[]
): Promise<{ answer: string }> {
  let res: Response;
  try {
    res = await fetch(`${BACKEND_URL}/documents/${encodeURIComponent(documentId)}/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ question, chat_history: chatHistory }),
    });
  } catch {
    throw networkError();
  }
  if (!res.ok) throw await parseError(res);
  return res.json();
}

export async function getDocumentHistory(documentId: string): Promise<{ messages: { role: string; content: string }[] }> {
  let res: Response;
  try {
    res = await fetch(`${BACKEND_URL}/documents/${encodeURIComponent(documentId)}/history`, {
      headers: { ...authHeaders() },
    });
  } catch {
    throw networkError();
  }
  if (!res.ok) throw await parseError(res);
  return res.json();
}

export async function createDocument(content: string): Promise<{ document_id: string; status: string }> {
  let res: Response;
  try {
    res = await fetch(`${BACKEND_URL}/documents`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ content }),
    });
  } catch {
    throw networkError();
  }
  if (!res.ok) throw await parseError(res);
  return res.json();
}
