import { FileText, MessageCircle, Moon, Sun } from "lucide-react";

interface HeaderProps {
  /** Whether the document is prepared — colors the Chat button. */
  chatReady: boolean;
  /** Whether the chat drawer is open (button acts as a toggle). */
  chatOpen: boolean;
  onToggleChat: () => void;
  /** Preview theme (the app chrome itself stays dark). */
  isDark: boolean;
  onToggleTheme: () => void;
}

export default function Header({
  chatReady,
  chatOpen,
  onToggleChat,
  isDark,
  onToggleTheme,
}: HeaderProps) {
  // h-14 pins the height to 56px to match the drawer overlay's top-14 in
  // App.tsx — content-driven height would drift out of alignment.
  return (
    <header className={`sticky top-0 z-40 flex h-14 shrink-0 items-center justify-between border-b px-6 ${isDark ? "border-slate-800 bg-slate-900" : "border-gray-200 bg-white"}`}>
      <div className="flex items-center gap-2">
        <FileText className="h-6 w-6 text-emerald-500" aria-hidden="true" />
        <h1 className={`text-lg font-bold ${isDark ? "text-slate-100" : "text-gray-900"}`}>AskmyMD</h1>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onToggleTheme}
          aria-pressed={isDark}
          aria-label={
            isDark ? "Switch preview to light mode" : "Switch preview to dark mode"
          }
          className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${isDark ? "bg-slate-800 text-slate-100 hover:bg-slate-700" : "bg-gray-100 text-gray-900 hover:bg-gray-200 border border-gray-200"}`}
        >
          {isDark ? (
            <Sun className="h-4 w-4" aria-hidden="true" />
          ) : (
            <Moon className="h-4 w-4" aria-hidden="true" />
          )}
          {isDark ? "Light" : "Dark"}
        </button>
        <button
          type="button"
          onClick={onToggleChat}
          aria-expanded={chatOpen}
          aria-controls="chat-drawer"
        className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
          chatReady
            ? "bg-emerald-500 text-slate-950 hover:bg-emerald-400"
            : isDark ? "bg-slate-700 text-slate-100 hover:bg-slate-600" : "bg-gray-100 text-gray-800 hover:bg-gray-200 border border-gray-200"
        } ${chatOpen ? `ring-2 ring-emerald-500/60 ring-offset-2 ${isDark ? "ring-offset-slate-900" : "ring-offset-white"}` : ""}`}
      >
          <MessageCircle className="h-4 w-4" aria-hidden="true" />
          Chat
        </button>
      </div>
    </header>
  );
}
