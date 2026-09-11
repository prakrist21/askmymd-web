import { useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw, X } from "lucide-react";
import {
  ApiError,
  friendlyMessage,
  prepareDocument,
  resyncDocument,
  sendChatMessage,
} from "../api";
import {
  type ChatMessage,
  loadStoredChatHistory,
  loadStoredMarkdown,
  loadStoredPrepared,
  saveChatHistory,
  savePrepared,
} from "../storage";

type Phase = "idle" | "preparing" | "ready";

interface ChatPanelProps {
  markdown: string;
  /** Document-scoped errors (e.g. FILE_TOO_LARGE) surface above the editor. */
  onDocError: (message: string) => void;
  /** Drawer chrome: closes the drawer (header X button). */
  onClose: () => void;
  /** Readiness mirror for the header Chat button (emerald when ready). */
  onReadyChange: (ready: boolean) => void;
  isDark: boolean;
  /** Document id for /documents/{id}/resync — when absent, resync falls back to re-prepare. */
  documentId?: string | null;
}

/**
 * Chat drawer body. Idle shows the chat button; clicking it runs /prepare on
 * the current markdown, then the panel becomes a message list + input wired
 * to /chat. Bot answers render as plain text (no markdown).
 *
 * State (chat history + readiness) survives a page refresh via localStorage.
 * If a chat call then fails with NOT_PREPARED (backend restarted, in-memory
 * store lost), the panel drops back to idle and prompts for re-prepare.
 */
export default function ChatPanel({
  markdown,
  onDocError,
  onClose,
  onReadyChange,
  isDark,
  documentId,
}: ChatPanelProps) {
  const [phase, setPhase] = useState<Phase>(() => {
    const restored = loadStoredPrepared() && !!loadStoredMarkdown().trim();
    if (restored) {
      // Refresh restores a "ready" panel; the backend may still have been
      // restarted since — the NOT_PREPARED path below handles that.
      return "ready";
    }
    return "idle";
  });
  const [messages, setMessages] = useState<ChatMessage[]>(() =>
    loadStoredChatHistory()
  );
  // Which document the current `messages` are about; empty when there is no
  // history. Lets a re-prepare keep history for an unchanged document.
  const [messagesDoc, setMessagesDoc] = useState<string>(() =>
    loadStoredChatHistory().length > 0 ? loadStoredMarkdown() : ""
  );
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rePrepareNeeded, setRePrepareNeeded] = useState(false);
  const [isResyncing, setIsResyncing] = useState(false);
  const [showResyncConfirm, setShowResyncConfirm] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const isReady = phase === "ready";

  // Mirror readiness up to App for the header button color.
  useEffect(() => {
    onReadyChange(isReady);
  }, [isReady, onReadyChange]);

  // Persist chat history on every change, and the prepared flag once ready.
  // (prepared=false is written explicitly on demotion below, never here, so
  // a restored "ready" state isn't clobbered by the mount-time effect run.)
  useEffect(() => {
    saveChatHistory(messages);
    if (isReady) savePrepared(true);
  }, [messages, isReady]);

  // Keep the newest message (or the typing indicator) in view.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, pending]);

  async function handlePrepare() {
    const doc = markdown;
    if (!doc.trim()) {
      setError("Please add some content before starting the chat.");
      return;
    }
    setError(null);
    setRePrepareNeeded(false);
    setPhase("preparing");
    try {
      await prepareDocument(doc);
      // Keep history if it belongs to this same document (e.g. re-prepare
      // after a backend restart); clear it when the document changed.
      if (messagesDoc !== doc) setMessages([]);
      setMessagesDoc(doc);
      setPhase("ready");
    } catch (err) {
      setPhase("idle");
      if (err instanceof ApiError && err.code === "FILE_TOO_LARGE") {
        // Document-scoped: show it up top where the document lives.
        onDocError(friendlyMessage(err, err.message));
      } else {
        setError(friendlyMessage(err, "Something went wrong while preparing the document."));
      }
    }
  }

  async function handleSend() {
    const question = input.trim();
    if (!question || pending || isResyncing) return;
    setError(null);
    setInput("");
    const history = messages;
    // Show the user's message immediately, then the bot's answer on return.
    setMessages([...history, { role: "user", content: question }]);
    setPending(true);
    try {
      const { answer } = await sendChatMessage(question, history);
      setMessages([
        ...history,
        { role: "user", content: question },
        { role: "assistant", content: answer },
      ]);
    } catch (err) {
      // Roll back the optimistic message and restore the input so retrying
      // is one click; prior history stays untouched.
      setMessages(history);
      setInput(question);
      if (err instanceof ApiError && err.code === "NOT_PREPARED") {
        // Backend lost its in-memory store (restart) while the UI said
        // ready — demote to idle and prompt for re-prepare.
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
    try {
      if (documentId) {
        await resyncDocument(documentId);
      } else {
        // Fallback for single-document (no ID) mode: re-run /prepare with current markdown
        // This still re-indexes and we manually clear chat.
        await prepareDocument(markdown);
      }
      // On success, clear the visible chat messages and show a fresh empty chat state
      setMessages([]);
      saveChatHistory([]);
      setToast(null);
    } catch (err) {
      // On failure, show an error toast and leave the previous chat state intact
      const msg = friendlyMessage(err, "Resync failed — please try again.");
      setToast(msg);
      setError(msg);
      // Restore previous messages (they were not cleared yet on failure, but ensure)
      setMessages(previousMessages);
      // auto-dismiss toast after 4s
      setTimeout(() => setToast(null), 4000);
    } finally {
      setIsResyncing(false);
      setShowResyncConfirm(false);
    }
  }

  return (
    <div className={`flex h-full w-full flex-col ${isDark ? "bg-slate-900 text-slate-100" : "bg-white text-gray-900"}`}>
      {/* Drawer header with resync + close buttons */}
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

      {/* Confirmation dialog */}
      {showResyncConfirm && (
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

      {/* Toast for resync failure */}
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
            className="rounded-lg bg-emerald-500 px-5 py-3 text-sm font-medium text-slate-950 transition-colors hover:bg-emerald-400"
          >
            {rePrepareNeeded ? "🔄 Re-prepare document" : "💬 Chat with this document"}
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
          <div ref={scrollRef} className={`relative min-h-0 flex-1 space-y-3 overflow-y-auto p-4 ${isDark ? "bg-slate-900" : "bg-white"}`}>
            {isResyncing && (
              <div className={`absolute inset-0 z-5 flex flex-col items-center justify-center gap-3 ${isDark ? "bg-slate-900/80" : "bg-white/80"} backdrop-blur-sm`}>
                <Loader2 className={`h-8 w-8 animate-spin ${isDark ? "text-emerald-400" : "text-emerald-600"}`} />
                <p className={`text-sm font-medium ${isDark ? "text-slate-300" : "text-gray-600"}`}>Resyncing document...</p>
              </div>
            )}
            {messages.length === 0 && !isResyncing && !pending ? (
              <p className={`py-8 text-center text-sm ${isDark ? "text-slate-500" : "text-gray-400"}`}>No messages yet — ask something about the document.</p>
            ) : (
              messages.map((msg, i) => (
                <div
                  key={i}
                  className={
                    msg.role === "user"
                      ? isDark
                        ? "ml-auto max-w-[85%] rounded-2xl rounded-br-sm border border-emerald-600/30 bg-emerald-900/30 px-3 py-2 text-sm break-words whitespace-pre-wrap text-slate-100"
                        : "ml-auto max-w-[85%] rounded-2xl rounded-br-sm border border-emerald-500/30 bg-emerald-50 px-3 py-2 text-sm break-words whitespace-pre-wrap text-gray-900"
                      : isDark
                        ? "mr-auto max-w-[85%] rounded-2xl rounded-bl-sm border border-slate-700 bg-slate-800 px-3 py-2 text-sm break-words whitespace-pre-wrap text-slate-100"
                        : "mr-auto max-w-[85%] rounded-2xl rounded-bl-sm border border-gray-200 bg-gray-100 px-3 py-2 text-sm break-words whitespace-pre-wrap text-gray-900"
                  }
                >
                  {msg.content}
                </div>
              ))
            )}
            {pending && !isResyncing && (
              <div className={`mr-auto animate-pulse rounded-2xl rounded-bl-sm border px-3 py-2 text-sm ${isDark ? "border-slate-700 bg-slate-800 text-slate-400" : "border-gray-200 bg-gray-100 text-gray-500"}`}>
                Thinking…
              </div>
            )}
          </div>

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
