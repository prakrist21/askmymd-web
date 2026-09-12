import { useEffect, useRef, useState } from "react";
import ChatPanel from "./components/ChatPanel";
import Editor from "./components/Editor";
import FormattingToolbar from "./components/FormattingToolbar";
import Header from "./components/Header";
import Preview from "./components/Preview";
import ResizableSplit from "./components/ResizableSplit";
import {
  loadStoredDocumentId,
  loadStoredMarkdown,
  loadStoredPrepared,
  loadStoredTheme,
  saveDocumentId,
  saveMarkdown,
  saveTheme,
} from "./storage";

export default function App() {
  const [markdown, setMarkdown] = useState<string>(() => loadStoredMarkdown());
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const [docError, setDocError] = useState<string | null>(null);
  // Chat lives in a slide-in drawer; hidden until the header button opens it.
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Mirrors ChatPanel's readiness so the header Chat button can be
  // emerald-when-ready / gray-when-idle. Initialized from storage so the
  // color is correct on first paint after a refresh.
  const [chatReady, setChatReady] = useState<boolean>(
    () => loadStoredPrepared() && !!loadStoredMarkdown().trim()
  );
  // Preview theme (dark default). The app chrome stays dark; this drives
  // the preview surface + mermaid palette and persists across refreshes.
  const [theme, setTheme] = useState<"dark" | "light">(() => loadStoredTheme());
  // Document identity: stable ID representing the logical document.
  // - Generated on first prepare (see ChatPanel handlePrepare / storage.getOrCreateDocumentId)
  // - Reused on subsequent edits/re-prepares so chat history survives text changes.
  // - Only a NEW document (explicit "New document" action, file upload of a
  //   different logical file, or manual localStorage clear) should generate a
  //   fresh ID. There is currently NO "New document" button in the UI, so in
  //   practice a new ID only appears after clearing storage or via future upload flow.
  // This state mirrors localStorage so ChatPanel can scope history by ID instead of markdown.
  const [documentId, setDocumentId] = useState<string | null>(() => loadStoredDocumentId());

  useEffect(() => {
    saveTheme(theme);
  }, [theme]);

  // Persist the document so a refresh restores the editor.
  useEffect(() => {
    saveMarkdown(markdown);
  }, [markdown]);

  // Keep documentId state in sync if another tab changes storage (and on mount).
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === "askmymd.document_id") {
        setDocumentId(e.newValue);
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const handleDocumentIdChange = (id: string | null) => {
    if (id) saveDocumentId(id);
    setDocumentId(id);
  };

  // Escape closes the drawer.
  useEffect(() => {
    if (!drawerOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setDrawerOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  const isDark = theme === "dark";

  return (
    <div className={`flex h-screen min-h-0 flex-col overflow-hidden ${isDark ? "bg-slate-950 text-slate-100" : "bg-white text-slate-900"}`}>
      <Header
        chatReady={chatReady}
        chatOpen={drawerOpen}
        onToggleChat={() => setDrawerOpen((o) => !o)}
        isDark={isDark}
        onToggleTheme={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
      />
      <FormattingToolbar editorRef={editorRef} value={markdown} onChange={setMarkdown} isDark={isDark} />
      {docError && (
        <div className={`flex items-center justify-between gap-3 border-b px-6 py-2 text-sm ${isDark ? "border-red-900/60 bg-red-950/60 text-red-300" : "border-red-200 bg-red-50 text-red-700"}`}>
          <span>{docError}</span>
          <button
            type="button"
            onClick={() => setDocError(null)}
            className={`shrink-0 rounded px-2 py-0.5 text-xs ${isDark ? "text-red-300 hover:bg-red-900/60 hover:text-red-100" : "text-red-600 hover:bg-red-100 hover:text-red-800"}`}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Editor + Preview fill the full width; the chat is no longer a
           permanent sidebar. */}
      <main className={`flex min-h-0 flex-1 ${isDark ? "bg-slate-950" : "bg-white"}`}>
        <ResizableSplit
          isDark={isDark}
          left={<Editor value={markdown} onChange={setMarkdown} isDark={isDark} editorRef={editorRef} />}
          right={<Preview content={markdown} isDark={isDark} />}
        />
      </main>

      {/* Chat drawer: dimmed backdrop + sliding panel. The panel stays
          mounted (chat state survives open/close) but is inert and
          translated off-screen while closed. Sits below the h-14 header. */}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 top-14 z-40">
        <div
          onClick={() => setDrawerOpen(false)}
          aria-hidden="true"
          className={`absolute inset-0 transition-opacity duration-300 ${isDark ? "bg-slate-950/60" : "bg-gray-900/30"} ${
            drawerOpen
              ? "pointer-events-auto opacity-100"
              : "pointer-events-none opacity-0"
          }`}
        />
        <section
          id="chat-drawer"
          aria-label="Chat"
          aria-hidden={!drawerOpen}
          inert={!drawerOpen}
          className={`pointer-events-auto absolute bottom-0 right-0 top-0 w-96 border-l shadow-2xl transition-transform duration-300 ${isDark ? "border-slate-800 bg-slate-900" : "border-gray-200 bg-white"} ${
            drawerOpen ? "translate-x-0" : "translate-x-full"
          }`}
        >
          <ChatPanel
            markdown={markdown}
            documentId={documentId}
            onDocumentIdChange={handleDocumentIdChange}
            onDocError={setDocError}
            onClose={() => setDrawerOpen(false)}
            onReadyChange={setChatReady}
            isDark={isDark}
          />
        </section>
      </div>
    </div>
  );
}
