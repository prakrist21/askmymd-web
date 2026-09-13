import { useRef } from "react";
import { ArrowLeft, Maximize2 } from "lucide-react";

interface EditorProps {
  value: string;
  onChange: (value: string) => void;
  isDark: boolean;
  editorRef?: React.RefObject<HTMLTextAreaElement | null>;
  fontFamily?: string;
  onExpand?: () => void;
  onCollapse?: () => void;
  isExpanded?: boolean;
}

export default function Editor({ value, onChange, isDark, editorRef, fontFamily, onExpand, onCollapse, isExpanded }: EditorProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const internalRef = useRef<HTMLTextAreaElement>(null);
  const textareaRef = editorRef ?? internalRef;

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
    <div className={`flex h-full min-h-0 w-full flex-1 flex-col ${isExpanded ? "" : "border-r"} ${isDark ? "border-slate-800 bg-slate-950" : "border-gray-200 bg-white"}`}>
      <div className={`flex h-10 shrink-0 items-center justify-between border-b px-4 ${isDark ? "border-slate-800 bg-slate-950" : "border-gray-200 bg-white"}`}>
        <div className="flex items-center gap-2">
          {isExpanded && onCollapse && (
            <button
              type="button"
              onClick={onCollapse}
              aria-label="Back to split view"
              className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${isDark ? "border-slate-700 text-slate-300 hover:bg-slate-800 hover:text-slate-50" : "border-gray-300 text-gray-700 hover:bg-gray-100 hover:text-gray-900 bg-white"}`}
            >
              <ArrowLeft className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              Back
            </button>
          )}
          <span className={`text-sm font-semibold tracking-wide uppercase ${isDark ? "text-slate-400" : "text-gray-500"}`}>
            Editor
          </span>
        </div>
        <div className="flex items-center gap-2">
          {!isExpanded && onExpand && (
            <button
              type="button"
              onClick={onExpand}
              aria-label="Expand editor"
              title="Expand editor"
              className={`rounded p-1.5 transition-colors ${isDark ? "text-slate-400 hover:bg-slate-800 hover:text-slate-100" : "text-gray-500 hover:bg-gray-100 hover:text-gray-900"}`}
            >
              <Maximize2 className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
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
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Paste or type markdown here, or upload a .md file…"
        spellCheck={false}
        style={fontFamily ? { fontFamily } : undefined}
        className={`min-h-0 w-full flex-1 resize-none overflow-auto p-4 text-sm focus:outline-none ${isDark ? "bg-slate-950 text-slate-200 placeholder:text-slate-600" : "bg-white text-gray-900 placeholder:text-gray-400"}`}
      />
    </div>
  );
}
