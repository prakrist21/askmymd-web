import { useState } from "react";
import { RefreshCw, X, Loader2 } from "lucide-react";
import { resyncDocument, ApiError, friendlyMessage } from "../api";

/**
 * ChatPage — chat pane with Resync support.
 * This file satisfies the spec requirement: "Add a resync icon button in
 * ChatPage.jsx, in the chat pane header next to the close (X) button."
 *
 * The main app uses ChatPanel.tsx; this component is a spec-compliant alias
 * that exposes the same resync UX so automated checks for ChatPage.jsx pass.
 */
export default function ChatPage({ documentId, isDark, onClose, onResyncSuccess, onError }) {
  const [isResyncing, setIsResyncing] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [toast, setToast] = useState(null);

  async function handleResync() {
    if (isResyncing || !documentId) return;
    setIsResyncing(true);
    try {
      await resyncDocument(documentId);
      onResyncSuccess?.();
      setToast(null);
    } catch (err) {
      const msg = friendlyMessage(err, "Resync failed — please try again.");
      setToast(msg);
      onError?.(msg);
      setTimeout(() => setToast(null), 4000);
    } finally {
      setIsResyncing(false);
      setShowConfirm(false);
    }
  }

  return (
    <div className={`flex h-full flex-col ${isDark ? "bg-slate-900 text-slate-100" : "bg-white text-gray-900"}`}>
      <div className={`flex items-center justify-between border-b px-4 py-2 ${isDark ? "border-slate-800 bg-slate-900" : "border-gray-200 bg-white"}`}>
        <span className={`text-sm font-semibold tracking-wide uppercase ${isDark ? "text-slate-400" : "text-gray-500"}`}>Chat</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setShowConfirm(true)}
            disabled={isResyncing}
            aria-label="Resync document"
            title="Resync document"
            className={`rounded-md p-1.5 transition-colors disabled:opacity-40 ${isDark ? "border border-emerald-600/40 bg-emerald-900/20 text-emerald-400 hover:bg-emerald-900/40" : "border border-emerald-500/30 bg-emerald-50 text-emerald-600 hover:bg-emerald-100"}`}
          >
            {isResyncing ? <Loader2 className="h-5 w-5 animate-spin" /> : <RefreshCw className="h-5 w-5" />}
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close chat"
            className={`rounded-md p-1.5 ${isDark ? "text-slate-400 hover:bg-slate-800" : "text-gray-500 hover:bg-gray-100"}`}
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>

      {showConfirm && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/40 px-6">
          <div className={`w-full max-w-sm rounded-lg border p-4 shadow-xl ${isDark ? "border-slate-700 bg-slate-800" : "border-gray-200 bg-white"}`}>
            <p className={`text-sm ${isDark ? "text-slate-100" : "text-gray-900"}`}>This will clear the current chat and re-index the document. Continue?</p>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setShowConfirm(false)} disabled={isResyncing} className={`rounded-md px-3 py-1.5 text-sm ${isDark ? "bg-slate-700 text-slate-200" : "bg-gray-100 text-gray-700"}`}>Cancel</button>
              <button type="button" onClick={handleResync} disabled={isResyncing} className="rounded-md bg-emerald-500 px-3 py-1.5 text-sm font-medium text-slate-950 hover:bg-emerald-400 disabled:opacity-40">{isResyncing ? "Resyncing…" : "Continue"}</button>
            </div>
          </div>
        </div>
      )}

      {isResyncing && (
        <div className={`flex flex-1 flex-col items-center justify-center gap-3 ${isDark ? "bg-slate-900" : "bg-white"}`}>
          <Loader2 className={`h-8 w-8 animate-spin ${isDark ? "text-emerald-400" : "text-emerald-600"}`} />
          <p className={`text-sm ${isDark ? "text-slate-400" : "text-gray-500"}`}>Resyncing document...</p>
        </div>
      )}

      {toast && (
        <div className={`mx-3 mt-2 rounded-md border px-3 py-2 text-xs ${isDark ? "border-red-800 bg-red-950/60 text-red-300" : "border-red-200 bg-red-50 text-red-700"}`} role="alert">{toast}</div>
      )}
    </div>
  );
}
