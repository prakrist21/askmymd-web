import { useEffect, useRef, useState } from "react";
import { Check, Copy, Loader2, MessageCircle, RefreshCw, X } from "lucide-react";
import {
  ApiError,
  askDocument,
  createDocument,
  friendlyMessage,
  resyncDocument,
} from "../api";
import {
  type ChatMessage,
  loadStoredChatHistory,
  loadStoredDocumentId,
  loadStoredMarkdown,
  loadStoredMessagesDocumentId,
  loadStoredPrepared,
  saveChatHistory,
  saveDocumentId,
  saveMessagesDocumentId,
  savePrepared,
} from "../storage";

type Phase = "idle" | "preparing" | "ready";

interface ChatPanelProps {
  markdown: string;
  onDocError: (message: string) => void;
  onClose: () => void;
  onReadyChange: (ready: boolean) => void;
  isDark: boolean;
  documentId?: string | null;
  onDocumentIdChange?: (id: string | null) => void;
}

/**
 * Chat drawer body. Idle shows the chat button; clicking it creates or reuses
 * a document via POST /documents, then the panel becomes a message list + input
 * wired to /documents/{id}/ask. Bot answers render as plain text (no markdown).
 *
 * State (chat history + readiness) survives a page refresh via localStorage.
 */
export default function ChatPanel({
  markdown,
  onDocError,
  onClose,
  onReadyChange,
  isDark,
  documentId,
  onDocumentIdChange,
}: ChatPanelProps) {
  const [phase, setPhase] = useState<Phase>(() => {
    const restored = loadStoredPrepared() && !!loadStoredMarkdown().trim();
    if (restored) {
      return "ready";
    }
    return "idle";
  });
  const [messages, setMessages] = useState<ChatMessage[]>(() =>
    loadStoredChatHistory()
  );
  const [messagesDocumentId, setMessagesDocumentId] = useState<string | null>(() =>
    loadStoredMessagesDocumentId()
  );
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rePrepareNeeded, setRePrepareNeeded] = useState(false);
  const [isResyncing, setIsResyncing] = useState(false);
  const [showResyncConfirm, setShowResyncConfirm] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const isReady = phase === "ready";

  useEffect(() => {
    onReadyChange(isReady);
  }, [isReady, onReadyChange]);

  useEffect(() => {
    saveChatHistory(messages);
    saveMessagesDocumentId(messagesDocumentId);
    if (isReady) savePrepared(true);
  }, [messages, messagesDocumentId, isReady]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, pending]);

  async function handlePrepare() {
    const doc = markdown;
    if (!doc.trim()) {
      setError("Please add some content before starting the chat.");
      return;
    }

    let activeId = documentId ?? loadStoredDocumentId();
    if (!activeId) {
      try {
        const created = await createDocument(doc);
        activeId = created.document_id;
        saveDocumentId(activeId);
        onDocumentIdChange?.(activeId);
      } catch (err) {
        setPhase("idle");
        if (err instanceof ApiError) {
          setError(friendlyMessage(err, "Could not create document on server."));
        } else {
          setError("Could not create document on server.");
        }
        return;
      }
    }

    setError(null);
    setRePrepareNeeded(false);
    setPhase("preparing");
    try {
      // Document already created above (with content) — pgvector indexing
      // happens server-side on POST /documents. No separate /prepare call.
      if (messagesDocumentId !== null && messagesDocumentId !== activeId) {
        setMessages([]);
      }
      setMessagesDocumentId(activeId);
      saveMessagesDocumentId(activeId);
      setPhase("ready");
    } catch (err) {
      setPhase("idle");
      if (err instanceof ApiError && err.code === "FILE_TOO_LARGE") {
        onDocError(friendlyMessage(err, err.message));
      } else {
        setError(friendlyMessage(err, "Something went wrong while preparing the document."));
      }
    }
  }

  async function handleSend() {
    const question = input.trim();
    if (!question || pending || isResyncing) return;
    const effectiveId = documentId ?? loadStoredDocumentId() ?? messagesDocumentId;
    if (!effectiveId) {
      setError("No document — please prepare the document first.");
      return;
    }
    setError(null);
    setInput("");
    const history = messages;
    setMessages([...history, { role: "user", content: question }]);
    setPending(true);
    try {
      const { answer } = await askDocument(effectiveId, question, history);
      setMessages([
        ...history,
        { role: "user", content: question },
        { role: "assistant", content: answer },
      ]);
    } catch (err) {
      setMessages(history);
      setInput(question);
      if (err instanceof ApiError && err.code === "NOT_PREPARED") {
        savePrepared(false);
        setRePrepareNeeded(true);
        setPhase("idle");
      } else {
        setError(friendlyMessage(err, "Something went wrong while sending your message."));
      }
    } finally {
      setPending(false);
    }
  }

  async function handleResync() {
    if (isResyncing) return;
    setError(null);
    setIsResyncing(true);
    const previousMessages = [...messages];
    const effectiveId = documentId ?? loadStoredDocumentId();
    try {
      if (effectiveId) {
        try {
          await resyncDocument(effectiveId);
        } catch (err) {
          if (err instanceof ApiError && err.code === "DOCUMENT_NOT_FOUND") {
            // Document missing on server (e.g. after DB wipe) — recreate it
            const created = await createDocument(markdown);
            const newId = created.document_id;
            saveDocumentId(newId);
            onDocumentIdChange?.(newId);
            setMessagesDocumentId(newId);
            saveMessagesDocumentId(newId);
          } else {
            throw err;
          }
        }
      } else {
        const created = await createDocument(markdown);
        const newId = created.document_id;
        saveDocumentId(newId);
        onDocumentIdChange?.(newId);
        setMessagesDocumentId(newId);
        saveMessagesDocumentId(newId);
      }
      setMessages([]);
      saveChatHistory([]);
      if (effectiveId) {
        setMessagesDocumentId(effectiveId);
        saveMessagesDocumentId(effectiveId);
      }
      setToast(null);
    } catch (err) {
      const msg = friendlyMessage(err, "Resync failed — please try again.");
      setToast(msg);
      setError(msg);
      setMessages(previousMessages);
      setTimeout(() => setToast(null), 4000);
    } finally {
      setIsResyncing(false);
      setShowResyncConfirm(false);
    }
  }

  async function handleCopy(text: string, idx: number) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx(null), 2000);
    } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        setCopiedIdx(idx);
        setTimeout(() => setCopiedIdx(null), 2000);
      } catch {
        // ignore
      }
    }
  }

  return (
    <div className={`flex h-full w-full flex-col ${isDark ? "bg-slate-900 text-slate-100" : "bg-white text-gray-900"}`}>
      <div className={`flex items-center justify-between border-b px-4 py-2 ${isDark ? "border-slate-800 bg-slate-900" : "border-gray-200 bg-white"}`}>
        <span className={`text-sm font-semibold tracking-wide uppercase ${isDark ? "text-slate-400" : "text-gray-500"}`}>
          Chat
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setShowResyncConfirm(true)}
            disabled={isResyncing || phase !== "ready"}
            aria-label="Resync document"
            title="Resync document"
            className={`rounded-md p-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
              isDark
                ? "border border-emerald-600/40 bg-emerald-900/20 text-emerald-400 hover:bg-emerald-900/40 hover:text-emerald-300"
                : "border border-emerald-500/30 bg-emerald-50 text-emerald-600 hover:bg-emerald-100 hover:text-emerald-700"
            }`}
          >
            {isResyncing ? (
              <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCw className="h-5 w-5" aria-hidden="true" />
            )}
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close chat"
            className={`rounded-md p-1.5 transition-colors ${isDark ? "text-slate-400 hover:bg-slate-800 hover:text-slate-100" : "text-gray-500 hover:bg-gray-100 hover:text-gray-900"}`}
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
      </div>

      {showResyncConfirm && !isResyncing && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/40 px-6">
          <div className={`w-full max-w-sm rounded-lg border p-4 shadow-xl ${isDark ? "border-slate-700 bg-slate-800" : "border-gray-200 bg-white"}`}>
            <p className={`text-sm ${isDark ? "text-slate-100" : "text-gray-900"}`}>This will clear the current chat and re-index the document. Continue?</p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowResyncConfirm(false)}
                disabled={isResyncing}
                className={`rounded-md px-3 py-1.5 text-sm ${isDark ? "bg-slate-700 text-slate-200 hover:bg-slate-600" : "bg-gray-100 text-gray-700 hover:bg-gray-200"}`}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleResync}
                disabled={isResyncing}
                className="rounded-md bg-emerald-500 px-3 py-1.5 text-sm font-medium text-slate-950 hover:bg-emerald-400 disabled:opacity-40"
              >
                {isResyncing ? "Resyncing…" : "Continue"}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className={`mx-3 mt-2 rounded-md border px-3 py-2 text-xs ${isDark ? "border-red-800 bg-red-950/60 text-red-300" : "border-red-200 bg-red-50 text-red-700"}`} role="alert">
          {toast}
        </div>
      )}

      {phase === "idle" && (
        <div className={`flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center ${isDark ? "" : "bg-white"}`}>
          <button
            type="button"
            onClick={handlePrepare}
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-500 px-5 py-3 text-sm font-medium text-slate-950 transition-colors hover:bg-emerald-400"
          >
            {rePrepareNeeded ? (
              <>
                <RefreshCw className="h-4 w-4" aria-hidden="true" /> Re-prepare document
              </>
            ) : (
              <>
                <MessageCircle className="h-4 w-4" aria-hidden="true" /> Chat with this document
              </>
            )}
          </button>
          <p className={`text-xs ${isDark ? "text-slate-500" : "text-gray-500"}`}>
            Analyzes the markdown in the editor, then answers questions about
            it.
          </p>
          {rePrepareNeeded && (
            <p className={`text-xs ${isDark ? "text-amber-400" : "text-amber-600"}`}>
              The server was restarted, so the document needs to be prepared
              again. Your chat history will be kept.
            </p>
          )}
          {error && <p className={`text-xs ${isDark ? "text-red-400" : "text-red-600"}`}>{error}</p>}
        </div>
      )}

      {phase === "preparing" && (
        <div className={`flex flex-1 flex-col items-center justify-center gap-3 ${isDark ? "bg-slate-900" : "bg-white"}`}>
          <div
            className={`h-8 w-8 animate-spin rounded-full border-2 border-t-emerald-500 ${isDark ? "border-slate-700" : "border-gray-200"}`}
            role="status"
            aria-label="Preparing document"
          />
          <p className={`text-sm ${isDark ? "text-slate-400" : "text-gray-500"}`}>Preparing document…</p>
        </div>
      )}

      {phase === "ready" && (
        <>
          {isResyncing ? (
            <div className={`flex flex-1 flex-col items-center justify-center gap-3 ${isDark ? "bg-slate-900" : "bg-white"}`}>
              <Loader2 className={`h-8 w-8 animate-spin ${isDark ? "text-emerald-400" : "text-emerald-600"}`} />
              <p className={`text-sm font-medium ${isDark ? "text-slate-300" : "text-gray-600"}`}>Resyncing document...</p>
            </div>
          ) : (
            <div ref={scrollRef} className={`min-h-0 flex-1 space-y-3 overflow-y-auto p-4 ${isDark ? "bg-slate-900" : "bg-white"}`}>
              {messages.length === 0 && !pending ? (
                <p className={`py-8 text-center text-sm ${isDark ? "text-slate-500" : "text-gray-400"}`}>No messages yet — ask something about the document.</p>
              ) : (
                messages.map((msg, i) => {
                  const isUser = msg.role === "user";
                  if (isUser) {
                    return (
                      <div
                        key={i}
                        className={
                          isDark
                            ? "ml-auto max-w-[85%] rounded-2xl rounded-br-sm border border-emerald-600/30 bg-emerald-900/30 px-3 py-2 text-sm break-words whitespace-pre-wrap text-slate-100"
                            : "ml-auto max-w-[85%] rounded-2xl rounded-br-sm border border-emerald-500/30 bg-emerald-50 px-3 py-2 text-sm break-words whitespace-pre-wrap text-gray-900"
                        }
                      >
                        {msg.content}
                      </div>
                    );
                  }
                  const isCopied = copiedIdx === i;
                  return (
                    <div key={i} className="mr-auto max-w-[85%] space-y-1">
                      <div
                        className={
                          isDark
                            ? "rounded-2xl rounded-bl-sm border border-slate-700 bg-slate-800 px-3 py-2 text-sm break-words whitespace-pre-wrap text-slate-100"
                            : "rounded-2xl rounded-bl-sm border border-gray-200 bg-gray-100 px-3 py-2 text-sm break-words whitespace-pre-wrap text-gray-900"
                        }
                      >
                        {msg.content}
                      </div>
                      <button
                        type="button"
                        onClick={() => handleCopy(msg.content, i)}
                        aria-label={isCopied ? "Copied" : "Copy response"}
                        className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors ${
                          isDark
                            ? "text-slate-400 hover:bg-slate-800 hover:text-slate-200"
                            : "text-gray-500 hover:bg-gray-100 hover:text-gray-700"
                        }`}
                      >
                        {isCopied ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
                        {isCopied ? "Copied" : "Copy"}
                      </button>
                    </div>
                  );
                })
              )}
              {pending && (
                <div className={`mr-auto animate-pulse rounded-2xl rounded-bl-sm border px-3 py-2 text-sm ${isDark ? "border-slate-700 bg-slate-800 text-slate-400" : "border-gray-200 bg-gray-100 text-gray-500"}`}>
                  Thinking…
                </div>
              )}
            </div>
          )}

          {error && (
            <p className={`border-t px-4 py-2 text-xs ${isDark ? "border-slate-800 text-red-400" : "border-gray-200 text-red-600"}`}>
              {error}
            </p>
          )}

          <form
            className={`flex gap-2 border-t p-3 ${isDark ? "border-slate-800 bg-slate-900" : "border-gray-200 bg-white"}`}
            onSubmit={(e) => {
              e.preventDefault();
              handleSend();
            }}
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={isResyncing ? "Resyncing document..." : "Ask about the document…"}
              disabled={pending || isResyncing}
              className={`min-w-0 flex-1 rounded-md border px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none disabled:opacity-50 ${isDark ? "border-slate-700 bg-slate-950 placeholder:text-slate-600 text-slate-100" : "border-gray-300 bg-white placeholder:text-gray-400 text-gray-900"}`}
            />
            <button
              type="submit"
              disabled={!input.trim() || pending || isResyncing}
              className="shrink-0 rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-slate-950 transition-colors hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Send
            </button>
          </form>
        </>
      )}
    </div>
  );
}
