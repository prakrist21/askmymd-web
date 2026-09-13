import { MessageCircle, Moon, Sun } from "lucide-react";

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
  const toggleBase =
    "inline-flex h-9 items-center justify-center gap-2 rounded-full border px-4 text-sm font-medium leading-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40";
  const chatBase =
    "inline-flex h-9 items-center justify-center gap-2 rounded-full border px-4 text-sm font-medium leading-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40";
  return (
    <header className={`sticky top-0 z-40 flex h-14 shrink-0 items-center justify-between border-b px-5 sm:px-6 ${isDark ? "border-slate-800 bg-slate-900" : "border-gray-200 bg-white"}`}>
      <div className="flex items-center gap-3">
        <img
          src="/logo-final.png"
          alt="AskmyMD"
          className="h-7 w-7 shrink-0 object-contain sm:h-8 sm:w-8"
        />
        <h1 className={`text-[15px] font-bold tracking-tight leading-none sm:text-[17px] ${isDark ? "text-slate-100" : "text-gray-900"}`}>askmymd</h1>
      </div>
      <div className="flex items-center gap-2.5">
        <button
          type="button"
          onClick={onToggleTheme}
          aria-pressed={isDark}
          aria-label={
            isDark ? "Switch preview to light mode" : "Switch preview to dark mode"
          }
          className={`${toggleBase} ${
            isDark
              ? "border-slate-700 bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-slate-100 hover:border-slate-600"
              : "border-gray-200 bg-white text-gray-500 hover:bg-gray-50 hover:text-gray-700 hover:border-gray-300"
          }`}
        >
          {isDark ? (
            <Sun className="h-4 w-4 shrink-0" aria-hidden="true" />
          ) : (
            <Moon className="h-4 w-4 shrink-0" aria-hidden="true" />
          )}
          <span className="hidden sm:inline">{isDark ? "Light" : "Dark"}</span>
          <span className="sm:hidden" aria-hidden="true">
            {isDark ? "Light" : "Dark"}
          </span>
        </button>
        <button
          type="button"
          onClick={onToggleChat}
          aria-expanded={chatOpen}
          aria-controls="chat-drawer"
          className={`${chatBase} ${
            chatReady
              ? "border-emerald-500 bg-emerald-500 text-slate-950 shadow-sm hover:bg-emerald-400 hover:border-emerald-400"
              : isDark
                ? "border-slate-600 bg-slate-700 text-slate-100 hover:bg-slate-600 hover:border-slate-500"
                : "border-gray-200 bg-gray-100 text-gray-700 hover:bg-gray-200 hover:text-gray-900"
          } ${chatOpen ? `ring-2 ring-emerald-500/60 ring-offset-2 ${isDark ? "ring-offset-slate-900" : "ring-offset-white"}` : ""}`}
        >
          <MessageCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
          Chat
        </button>
      </div>
    </header>
  );
}
