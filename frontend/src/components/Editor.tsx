import { useRef } from "react";

interface EditorProps {
  value: string;
  onChange: (value: string) => void;
  isDark: boolean;
}

export default function Editor({ value, onChange, isDark }: EditorProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    file
      .text()
      .then((text) => onChange(text))
      .catch(() => {
        // Leave editor content untouched if the file can't be read.
      });
    // Allow re-uploading the same file later.
    event.target.value = "";
  }

  return (
    <div className={`flex h-full flex-col border-r ${isDark ? "border-slate-800 bg-slate-950" : "border-gray-200 bg-white"}`}>
      <div className={`flex items-center justify-between border-b px-4 py-2 ${isDark ? "border-slate-800 bg-slate-950" : "border-gray-200 bg-white"}`}>
        <span className={`text-sm font-semibold tracking-wide uppercase ${isDark ? "text-slate-400" : "text-gray-500"}`}>
          Editor
        </span>
        <div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".md,.markdown,.txt,text/markdown,text/plain"
            onChange={handleFileChange}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className={`rounded-md border px-3 py-1 text-sm transition-colors ${isDark ? "border-slate-700 text-slate-300 hover:bg-slate-800 hover:text-slate-50" : "border-gray-300 text-gray-700 hover:bg-gray-100 hover:text-gray-900 bg-white"}`}
          >
            Upload .md
          </button>
        </div>
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Paste or type markdown here, or upload a .md file…"
        spellCheck={false}
        className={`h-full w-full flex-1 resize-none p-4 font-mono text-sm focus:outline-none ${isDark ? "bg-slate-950 text-slate-200 placeholder:text-slate-600" : "bg-white text-gray-900 placeholder:text-gray-400"}`}
      />
    </div>
  );
}
