import { useEffect, useRef, useState } from "react";
import {
  Bold,
  Italic,
  Strikethrough,
  Code,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Quote,
  Link2,
  FileCode,
  ChevronDown,
  Image as ImageIcon,
  Table as TableIcon,
  X,
  Undo2,
  Redo2,
  SeparatorHorizontal,
  ListChecks,
  Type,
  BookOpen,
  Check,
} from "lucide-react";
import { generateImageId, setImage } from "../imageStore";
import { EDITOR_FONTS, PREVIEW_FONTS } from "../fonts";

interface FormattingToolbarProps {
  editorRef: React.RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (value: string) => void;
  isDark: boolean;
  editorFontId: string;
  previewFontId: string;
  onEditorFontChange: (id: string) => void;
  onPreviewFontChange: (id: string) => void;
}

export default function FormattingToolbar({
  editorRef,
  value,
  onChange,
  isDark,
  editorFontId,
  previewFontId,
  onEditorFontChange,
  onPreviewFontChange,
}: FormattingToolbarProps) {
  const [headingOpen, setHeadingOpen] = useState(false);
  const [editorFontOpen, setEditorFontOpen] = useState(false);
  const [previewFontOpen, setPreviewFontOpen] = useState(false);
  const [showImageModal, setShowImageModal] = useState(false);
  const [imageMode, setImageMode] = useState<"choice" | "upload" | "url">("choice");
  const [imageAlt, setImageAlt] = useState("alt text");
  const [imageUrl, setImageUrl] = useState("https://example.com/image.jpg");
  const [imageFileName, setImageFileName] = useState("");
  const imageFileRef = useRef<HTMLInputElement>(null);
  const [pendingImageDataUrl, setPendingImageDataUrl] = useState<string | null>(null);
  const [imageWarning, setImageWarning] = useState<string | null>(null);
  const [showImageComingSoon, setShowImageComingSoon] = useState(false);

  const [showTableModal, setShowTableModal] = useState(false);
  const [tableHover, setTableHover] = useState({ rows: 3, cols: 3 });
  const [, forceHistoryUpdate] = useState(0);

  // History for Ctrl+Z / Ctrl+Shift+Z — also used for Undo/Redo buttons
  const historyRef = useRef<string[]>([value]);
  const historyIndexRef = useRef(0);
  const isUndoRedoRef = useRef(false);

  useEffect(() => {
    if (isUndoRedoRef.current) {
      isUndoRedoRef.current = false;
      return;
    }
    if (historyRef.current[historyIndexRef.current] === value) return;
    historyRef.current = historyRef.current.slice(0, historyIndexRef.current + 1);
    historyRef.current.push(value);
    historyIndexRef.current = historyRef.current.length - 1;
    if (historyRef.current.length > 100) {
      historyRef.current.shift();
      historyIndexRef.current--;
    }
    forceHistoryUpdate((v) => v + 1);
  }, [value]);

  function handleUndo() {
    // Also try native undo as fallback if history empty (browser's textarea supports execCommand)
    if (historyIndexRef.current > 0) {
      historyIndexRef.current--;
      isUndoRedoRef.current = true;
      const prev = historyRef.current[historyIndexRef.current];
      onChange(prev);
      forceHistoryUpdate((v) => v + 1);
      requestAnimationFrame(() => {
        editorRef.current?.focus();
      });
      return;
    }
    // Fallback to native
    try {
      const el = editorRef.current;
      if (el && document.execCommand) {
        el.focus();
        document.execCommand("undo");
      }
    } catch {}
  }

  function handleRedo() {
    if (historyIndexRef.current < historyRef.current.length - 1) {
      historyIndexRef.current++;
      isUndoRedoRef.current = true;
      const next = historyRef.current[historyIndexRef.current];
      onChange(next);
      forceHistoryUpdate((v) => v + 1);
      requestAnimationFrame(() => {
        editorRef.current?.focus();
      });
      return;
    }
    try {
      const el = editorRef.current;
      if (el && document.execCommand) {
        el.focus();
        document.execCommand("redo");
      }
    } catch {}
  }

  function getSelection() {
    const el = editorRef.current;
    if (!el) return null;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    return {
      el,
      start,
      end,
      text: value.slice(start, end),
      before: value.slice(0, start),
      after: value.slice(end),
    };
  }

  function replaceAndSelect(newValue: string, selStart: number, selEnd: number) {
    onChange(newValue);
    requestAnimationFrame(() => {
      const el = editorRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(selStart, selEnd);
    });
  }

  function isWrapped(text: string, prefix: string, suffix: string = prefix) {
    return text.startsWith(prefix) && text.endsWith(suffix) && text.length >= prefix.length + suffix.length;
  }

  function handleWrap(prefix: string, suffix: string = prefix, placeholder: string, trimSelection = true) {
    const sel = getSelection();
    if (!sel) return;
    const { start, end, text, before, after } = sel;
    const raw = trimSelection ? text : value.slice(start, end);
    if (isWrapped(raw, prefix, suffix) && raw !== placeholder) {
      const inner = raw.slice(prefix.length, raw.length - suffix.length);
      const newValue = before + inner + after;
      replaceAndSelect(newValue, start, start + inner.length);
      return;
    }
    if (raw) {
      const newValue = before + prefix + raw + suffix + after;
      replaceAndSelect(newValue, start + prefix.length, start + prefix.length + raw.length);
      return;
    }
    const newValue = before + prefix + placeholder + suffix + after;
    replaceAndSelect(newValue, start + prefix.length, start + prefix.length + placeholder.length);
  }

  function handleBold() {
    handleWrap("**", "**", "bold text");
  }
  function handleItalic() {
    handleWrap("*", "*", "italic text");
  }
  function handleStrike() {
    handleWrap("~~", "~~", "strikethrough");
  }
  function handleInlineCode() {
    handleWrap("`", "`", "code");
  }

  function handleHeading(level: 1 | 2 | 3) {
    const sel = getSelection();
    if (!sel) return;
    const { start, end, text } = sel;
    const prefix = "#".repeat(level) + " ";
    const placeholder = `Heading ${level}`;
    const lineStart = value.lastIndexOf("\n", start - 1) + 1;
    const lineEndIdx = value.indexOf("\n", end);
    const selEnd = lineEndIdx === -1 ? value.length : lineEndIdx;
    const block = value.slice(lineStart, selEnd);
    const lines = block.split("\n");
    const headingRe = /^#{1,6}\s+/;
    if (!block.trim() && !text) {
      const newBlock = prefix + placeholder;
      const newValue = value.slice(0, lineStart) + newBlock + value.slice(selEnd);
      replaceAndSelect(newValue, lineStart + prefix.length, lineStart + prefix.length + placeholder.length);
      return;
    }
    const allThisLevel = lines.every((l) => l.startsWith(prefix));
    if (allThisLevel) {
      const newBlock = lines.map((l) => l.slice(prefix.length)).join("\n");
      const newValue = value.slice(0, lineStart) + newBlock + value.slice(selEnd);
      replaceAndSelect(newValue, Math.max(lineStart, start - prefix.length), Math.max(lineStart, end - prefix.length));
      return;
    }
    const allHeaded = lines.every((l) => headingRe.test(l));
    let newBlock: string;
    if (allHeaded) {
      newBlock = lines.map((l) => l.replace(headingRe, prefix)).join("\n");
    } else {
      newBlock = lines.map((l) => prefix + l).join("\n");
    }
    const newValue = value.slice(0, lineStart) + newBlock + value.slice(selEnd);
    if (text) {
      replaceAndSelect(newValue, start + prefix.length, end + prefix.length + (newBlock.length - block.length));
    } else {
      replaceAndSelect(newValue, lineStart + prefix.length, lineStart + prefix.length + placeholder.length);
    }
  }

  function handlePrefixLines(prefix: string, placeholder: string) {
    const sel = getSelection();
    if (!sel) return;
    const { start, end, text } = sel;
    const lineStart = value.lastIndexOf("\n", start - 1) + 1;
    const lineEndIdx = value.indexOf("\n", end);
    const selEnd = lineEndIdx === -1 ? value.length : lineEndIdx;
    const block = value.slice(lineStart, selEnd);
    if (!block && !text) {
      const newBlock = prefix + placeholder;
      const newValue = value.slice(0, lineStart) + newBlock + value.slice(selEnd);
      replaceAndSelect(newValue, lineStart + prefix.length, lineStart + prefix.length + placeholder.length);
      return;
    }
    const lines = block.split("\n");
    const allPrefixed = lines.every((l) => l.startsWith(prefix));
    let newBlock: string;
    if (allPrefixed) {
      newBlock = lines.map((l) => l.slice(prefix.length)).join("\n");
    } else {
      newBlock = lines.map((l) => prefix + l).join("\n");
    }
    const newValue = value.slice(0, lineStart) + newBlock + value.slice(selEnd);
    replaceAndSelect(newValue, start + (allPrefixed ? -prefix.length : prefix.length), end + (allPrefixed ? -prefix.length : prefix.length));
  }

  function handleBulletList() {
    handlePrefixLines("- ", "list item");
  }
  function handleOrderedList() {
    const sel = getSelection();
    if (!sel) return;
    const { start, end, text } = sel;
    const lineStart = value.lastIndexOf("\n", start - 1) + 1;
    const lineEndIdx = value.indexOf("\n", end);
    const selEnd = lineEndIdx === -1 ? value.length : lineEndIdx;
    const block = value.slice(lineStart, selEnd);
    const lines = block.split("\n");
    const orderedRe = /^\d+\.\s+/;
    if (!block && !text) {
      const newBlock = "1. list item";
      const newValue = value.slice(0, lineStart) + newBlock + value.slice(selEnd);
      replaceAndSelect(newValue, lineStart + 3, lineStart + 3 + 9);
      return;
    }
    const allOrdered = lines.every((l) => orderedRe.test(l));
    let newBlock: string;
    if (allOrdered) {
      newBlock = lines.map((l) => l.replace(orderedRe, "")).join("\n");
    } else {
      newBlock = lines.map((l, i) => `${i + 1}. ${l}`).join("\n");
    }
    const newValue = value.slice(0, lineStart) + newBlock + value.slice(selEnd);
    replaceAndSelect(newValue, start, start + newBlock.length - block.length + (end - start));
  }
  function handleBlockquote() {
    handlePrefixLines("> ", "quote");
  }

  function handleHorizontalRule() {
    const sel = getSelection();
    if (!sel) return;
    const { start, before, after } = sel;
    let prefix = "";
    if (before.length === 0) {
      prefix = "";
    } else if (before.endsWith("\n\n")) {
      prefix = "";
    } else if (before.endsWith("\n")) {
      prefix = "\n";
    } else {
      prefix = "\n\n";
    }
    let suffix = "";
    if (after.length === 0) {
      suffix = "";
    } else if (after.startsWith("\n\n")) {
      suffix = "";
    } else if (after.startsWith("\n")) {
      suffix = "\n";
    } else {
      suffix = "\n\n";
    }
    const insert = `---`;
    const fullInsert = `${prefix}${insert}${suffix}`;
    const newValue = before + fullInsert + after;
    const cursorPos = start + prefix.length + insert.length + suffix.length;
    replaceAndSelect(newValue, cursorPos, cursorPos);
  }

  function handleTaskList() {
    const sel = getSelection();
    if (!sel) return;
    const { start, end, text } = sel;
    const lineStart = value.lastIndexOf("\n", start - 1) + 1;
    const lineEndIdx = value.indexOf("\n", end);
    const selEnd = lineEndIdx === -1 ? value.length : lineEndIdx;
    const block = value.slice(lineStart, selEnd);
    const lines = block.split("\n");
    const taskRe = /^- \[[ xX]\] /;
    const placeholder = "task";
    if (!block.trim() && !text) {
      const newBlock = `- [ ] ${placeholder}`;
      const newValue = value.slice(0, lineStart) + newBlock + value.slice(selEnd);
      replaceAndSelect(newValue, lineStart + 6, lineStart + 6 + placeholder.length);
      return;
    }
    const allTask = lines.every((l) => taskRe.test(l));
    let newBlock: string;
    if (allTask) {
      newBlock = lines.map((l) => l.replace(taskRe, "")).join("\n");
    } else {
      newBlock = lines.map((l) => {
        const stripped = l.replace(/^[-*]\s+/, "").replace(/^\d+\.\s+/, "").replace(/^>\s+/, "");
        return `- [ ] ${stripped}`;
      }).join("\n");
    }
    const newValue = value.slice(0, lineStart) + newBlock + value.slice(selEnd);
    const delta = newBlock.length - block.length;
    // Keep selection roughly centered
    replaceAndSelect(newValue, start + (allTask ? -6 : 6), end + delta + (allTask ? -6 : 6));
  }
  function handleLink() {
    const sel = getSelection();
    if (!sel) return;
    const { start, text, before, after } = sel;
    const linkText = text || "link text";
    const url = "https://example.com";
    const linkRe = /^\[.*\]\(.*\)$/;
    if (text && linkRe.test(text)) {
      const m = text.match(/^\[(.*)\]\(.*\)$/);
      const inner = m ? m[1] : text;
      const newValue = before + inner + after;
      replaceAndSelect(newValue, start, start + inner.length);
      return;
    }
    const newText = `[${linkText}](${url})`;
    const newValue = before + newText + after;
    if (text) {
      const urlStart = start + linkText.length + 3;
      replaceAndSelect(newValue, urlStart, urlStart + url.length);
    } else {
      replaceAndSelect(newValue, start + 1, start + 1 + linkText.length);
    }
  }
  function handleCodeBlock() {
    const sel = getSelection();
    if (!sel) return;
    const { start, text, before, after } = sel;
    const placeholder = "code block";
    const fence = "```";
    const isFenced = text.startsWith(fence) && text.endsWith(fence) && text.trim().length > 6;
    if (isFenced) {
      const inner = text.slice(3, -3).trim();
      const newValue = before + inner + after;
      replaceAndSelect(newValue, start, start + inner.length);
      return;
    }
    if (text) {
      const newText = `${fence}\n${text}\n${fence}`;
      const newValue = before + newText + after;
      replaceAndSelect(newValue, start + 4, start + 4 + text.length);
      return;
    }
    const newText = `${fence}\n${placeholder}\n${fence}`;
    const newValue = before + newText + after;
    replaceAndSelect(newValue, start + 4, start + 4 + placeholder.length);
  }

  function handleImage() {
    // For now, image upload is coming soon
    setShowImageComingSoon(true);
    setTimeout(() => setShowImageComingSoon(false), 2000);
  }

  function insertImageMarkdown(alt: string, url: string) {
    const sel = getSelection();
    if (!sel) return;
    const { start, text, before, after } = sel;
    const useAlt = alt || text || "alt text";
    const useUrl = url || "https://example.com/image.jpg";
    const imgRe = /^!\[.*\]\(.*\)$/;
    if (text && imgRe.test(text)) {
      const m = text.match(/^!\[(.*)\]\(.*\)$/);
      const inner = m ? m[1] : text;
      const newValue = before + inner + after;
      replaceAndSelect(newValue, start, start + inner.length);
      setShowImageModal(false);
      return;
    }
    const newText = `![${useAlt}](${useUrl})`;
    const newValue = before + newText + after;
    if (text && text !== useAlt) {
      const urlStart = start + useAlt.length + 3;
      replaceAndSelect(newValue, urlStart, urlStart + useUrl.length);
    } else if (!text) {
      replaceAndSelect(newValue, start + 2, start + 2 + useAlt.length);
    } else {
      replaceAndSelect(newValue, start + useAlt.length + 3, start + useAlt.length + 3 + useUrl.length);
    }
    setShowImageModal(false);
  }

  async function downscaleDataUrl(dataUrl: string, maxDim = 1024, quality = 0.75): Promise<string> {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width <= maxDim && height <= maxDim) {
          resolve(dataUrl);
          return;
        }
        if (width > height) {
          height = Math.round((height * maxDim) / width);
          width = maxDim;
        } else {
          width = Math.round((width * maxDim) / height);
          height = maxDim;
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          resolve(dataUrl);
          return;
        }
        ctx.drawImage(img, 0, 0, width, height);
        // Use jpeg for photos to get better compression, keep png for transparency? Use image/jpeg
        const mime = dataUrl.startsWith("data:image/png") ? "image/jpeg" : "image/jpeg";
        try {
          const out = canvas.toDataURL(mime, quality);
          resolve(out);
        } catch {
          resolve(dataUrl);
        }
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  async function handleImageFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImageFileName(file.name);
    setImageWarning(null);
    const nameWithoutExt = file.name.replace(/\.[^/.]+$/, "");
    if (!imageAlt || imageAlt === "alt text") {
      setImageAlt(nameWithoutExt || "image");
    }
    // Revoke previous blob if any (legacy)
    if (pendingImageDataUrl && pendingImageDataUrl.startsWith("blob:")) {
      URL.revokeObjectURL(pendingImageDataUrl);
    }
    const reader = new FileReader();
    reader.onload = async () => {
      let dataUrl = reader.result as string;
      // Warn/compress if over ~2.5MB (data URL length ~ 1.33x file size)
      const approxBytes = Math.round((dataUrl.length * 3) / 4);
      const limit = 2.5 * 1024 * 1024;
      if (approxBytes > limit || file.size > limit) {
        // Try to downscale/compress
        const compressed = await downscaleDataUrl(dataUrl, 1024, 0.7);
        const compressedBytes = Math.round((compressed.length * 3) / 4);
        if (compressedBytes < approxBytes) {
          dataUrl = compressed;
        }
        const finalBytes = Math.round((dataUrl.length * 3) / 4);
        if (finalBytes > limit) {
          setImageWarning(
            `Image is large (${(finalBytes / 1024 / 1024).toFixed(1)} MB). It will be stored as base64 in the markdown and counts toward localStorage limits (~5 MB). Consider using a smaller image or a URL.`
          );
        } else if (approxBytes > limit) {
          setImageWarning(`Image was compressed from ${(approxBytes / 1024 / 1024).toFixed(1)} MB to ${(finalBytes / 1024 / 1024).toFixed(1)} MB to fit localStorage.`);
        }
      } else {
        setImageWarning(null);
      }
      setPendingImageDataUrl(dataUrl);
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  }

  function closeImageModal() {
    if (pendingImageDataUrl && pendingImageDataUrl.startsWith("blob:")) {
      URL.revokeObjectURL(pendingImageDataUrl);
    }
    setPendingImageDataUrl(null);
    setImageFileName("");
    setImageWarning(null);
    setShowImageModal(false);
    setImageMode("choice");
  }

  function handleTable() {
    setTableHover({ rows: 3, cols: 3 });
    setShowTableModal(true);
  }

  function insertTable(rows: number, cols: number) {
    const sel = getSelection();
    if (!sel) return;
    const { start, before, after } = sel;
    const needsLeadingNewline = before.length > 0 && !before.endsWith("\n");
    const needsTrailingNewline = after.length > 0 && !after.startsWith("\n");
    const headerCells = Array.from({ length: cols }, (_, i) => `Header ${i + 1}`);
    const header = "| " + headerCells.join(" | ") + " |";
    const separator = "| " + Array.from({ length: cols }, () => "----------").join(" | ") + " |";
    const bodyRows = Array.from({ length: rows }, (_, r) =>
      "| " + Array.from({ length: cols }, (_, c) => `Cell ${r * cols + c + 1}`).join(" | ") + " |"
    ).join("\n");
    const tableBlock = [header, separator, bodyRows].join("\n");
    const prefix = needsLeadingNewline ? "\n\n" : before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
    const suffix = needsTrailingNewline ? "\n\n" : after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : "\n";
    const fullInsert = `${prefix}${tableBlock}${suffix}`;
    const newValue = before + fullInsert + after;
    const headerSelStart = start + prefix.length + 2;
    const headerSelEnd = headerSelStart + 8;
    replaceAndSelect(newValue, headerSelStart, headerSelEnd);
    setShowTableModal(false);
  }

  // Keyboard shortcuts: Cmd/Ctrl+B/I/K/Z/Y
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === "z" && !e.shiftKey) {
        e.preventDefault();
        handleUndo();
        return;
      }
      if ((key === "z" && e.shiftKey) || key === "y") {
        e.preventDefault();
        handleRedo();
        return;
      }
      if (key === "b") {
        e.preventDefault();
        handleBold();
      } else if (key === "i") {
        e.preventDefault();
        handleItalic();
      } else if (key === "k") {
        e.preventDefault();
        handleLink();
      }
    };
    el.addEventListener("keydown", onKeyDown as unknown as EventListener);
    return () => el.removeEventListener("keydown", onKeyDown as unknown as EventListener);
  }, [value, onChange]);

  const btnBase = `inline-flex items-center justify-center rounded-md p-1.5 text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 ${
    isDark ? "text-slate-300 hover:bg-slate-800 hover:text-slate-100" : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
  }`;
  const dividerClass = isDark ? "bg-slate-700" : "bg-gray-200";
  const canUndo = historyIndexRef.current > 0;
  const canRedo = historyIndexRef.current < historyRef.current.length - 1;

  return (
    <>
      <div
        className={`sticky top-14 z-20 flex flex-wrap items-center gap-1.5 border-b px-3 py-2 backdrop-blur supports-[backdrop-filter]:bg-opacity-80 ${isDark ? "border-slate-800 bg-slate-900/95" : "border-gray-200 bg-white/95"}`}
        role="toolbar"
        aria-label="Formatting toolbar"
      >
        {/* Group: History */}
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={handleUndo}
            disabled={!canUndo}
            title="Undo (Ctrl+Z)"
            aria-label="Undo"
            className={`${btnBase} ${!canUndo ? "opacity-40 cursor-not-allowed" : ""}`}
          >
            <Undo2 className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={handleRedo}
            disabled={!canRedo}
            title="Redo (Ctrl+Shift+Z)"
            aria-label="Redo"
            className={`${btnBase} ${!canRedo ? "opacity-40 cursor-not-allowed" : ""}`}
          >
            <Redo2 className="h-4 w-4" />
          </button>
        </div>

        <div className={`h-6 w-px shrink-0 ${dividerClass}`} aria-hidden="true" />

        {/* Group: Text formatting */}
        <div className="flex items-center gap-0.5">
          <button type="button" onClick={handleBold} title="Bold (Ctrl+B)" aria-label="Bold" className={btnBase}>
            <Bold className="h-4 w-4" />
          </button>
          <button type="button" onClick={handleItalic} title="Italic (Ctrl+I)" aria-label="Italic" className={btnBase}>
            <Italic className="h-4 w-4" />
          </button>
          <button type="button" onClick={handleStrike} title="Strikethrough" aria-label="Strikethrough" className={btnBase}>
            <Strikethrough className="h-4 w-4" />
          </button>
          <button type="button" onClick={handleInlineCode} title="Inline code" aria-label="Inline code" className={btnBase}>
            <Code className="h-4 w-4" />
          </button>
        </div>

        <div className={`h-6 w-px shrink-0 ${dividerClass}`} aria-hidden="true" />

        {/* Group: Structure — headings, quote, divider */}
        <div className="flex items-center gap-0.5">
          <div className="relative">
            <button
              type="button"
              onClick={() => setHeadingOpen((o) => !o)}
              onBlur={() => setTimeout(() => setHeadingOpen(false), 150)}
              title="Headings"
              aria-label="Headings"
              aria-expanded={headingOpen}
              aria-haspopup="menu"
              className={btnBase}
            >
              <Heading1 className="h-4 w-4" />
              <ChevronDown className="h-3 w-3 opacity-60" />
            </button>
            {headingOpen && (
              <div
                role="menu"
                className={`absolute left-0 top-full mt-1 w-36 rounded-md border py-1 shadow-lg ${isDark ? "border-slate-700 bg-slate-800" : "border-gray-200 bg-white"}`}
              >
                <button
                  role="menuitem"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    handleHeading(1);
                    setHeadingOpen(false);
                  }}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-sm ${isDark ? "hover:bg-slate-700 text-slate-200" : "hover:bg-gray-100 text-gray-700"}`}
                >
                  <Heading1 className="h-4 w-4" /> H1
                </button>
                <button
                  role="menuitem"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    handleHeading(2);
                    setHeadingOpen(false);
                  }}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-sm ${isDark ? "hover:bg-slate-700 text-slate-200" : "hover:bg-gray-100 text-gray-700"}`}
                >
                  <Heading2 className="h-4 w-4" /> H2
                </button>
                <button
                  role="menuitem"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    handleHeading(3);
                    setHeadingOpen(false);
                  }}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-sm ${isDark ? "hover:bg-slate-700 text-slate-200" : "hover:bg-gray-100 text-gray-700"}`}
                >
                  <Heading3 className="h-4 w-4" /> H3
                </button>
              </div>
            )}
          </div>
          <button type="button" onClick={handleBlockquote} title="Blockquote" aria-label="Blockquote" className={btnBase}>
            <Quote className="h-4 w-4" />
          </button>
          <button type="button" onClick={handleHorizontalRule} title="Horizontal rule" aria-label="Horizontal rule" className={btnBase}>
            <SeparatorHorizontal className="h-4 w-4" />
          </button>
        </div>

        <div className={`h-6 w-px shrink-0 ${dividerClass}`} aria-hidden="true" />

        {/* Group: Lists */}
        <div className="flex items-center gap-0.5">
          <button type="button" onClick={handleBulletList} title="Bullet list" aria-label="Bullet list" className={btnBase}>
            <List className="h-4 w-4" />
          </button>
          <button type="button" onClick={handleOrderedList} title="Numbered list" aria-label="Numbered list" className={btnBase}>
            <ListOrdered className="h-4 w-4" />
          </button>
          <button type="button" onClick={handleTaskList} title="Task list" aria-label="Task list" className={btnBase}>
            <ListChecks className="h-4 w-4" />
          </button>
        </div>

        <div className={`h-6 w-px shrink-0 ${dividerClass}`} aria-hidden="true" />

        {/* Group: Insert — link, code */}
        <div className="flex items-center gap-0.5">
          <button type="button" onClick={handleLink} title="Link (Ctrl+K)" aria-label="Link" className={btnBase}>
            <Link2 className="h-4 w-4" />
          </button>
          <button type="button" onClick={handleCodeBlock} title="Code block" aria-label="Code block" className={btnBase}>
            <FileCode className="h-4 w-4" />
          </button>
        </div>

        <div className={`h-6 w-px shrink-0 ${dividerClass}`} aria-hidden="true" />

        {/* Group: Media — image, table */}
        <div className="flex items-center gap-0.5">
          <button type="button" onClick={handleImage} title="Image" aria-label="Image" className={btnBase}>
            <ImageIcon className="h-4 w-4" />
          </button>
          <button type="button" onClick={handleTable} title="Table" aria-label="Table" className={btnBase}>
            <TableIcon className="h-4 w-4" />
          </button>
        </div>

        <div className={`h-6 w-px shrink-0 ${dividerClass}`} aria-hidden="true" />

        {/* Group: Fonts — editor & preview (independent, new cluster at end) */}
        <div className="flex items-center gap-1">
          {/* Editor font picker */}
          <div className="relative">
            <button
              type="button"
              onClick={() => {
                setEditorFontOpen((o) => !o);
                setPreviewFontOpen(false);
                setHeadingOpen(false);
              }}
              onBlur={() => setTimeout(() => setEditorFontOpen(false), 150)}
              title="Editor font"
              aria-label="Editor font"
              aria-expanded={editorFontOpen}
              aria-haspopup="menu"
              className={`${btnBase} gap-1.5 px-2`}
            >
              <Type className="h-4 w-4 shrink-0" />
              <span className="hidden sm:inline text-xs font-medium">Editor font</span>
              <ChevronDown className="h-3 w-3 opacity-60" />
            </button>
            {editorFontOpen && (
              <div
                role="menu"
                className={`absolute right-0 top-full z-30 mt-1 w-60 rounded-md border py-1 shadow-lg ${isDark ? "border-slate-700 bg-slate-800" : "border-gray-200 bg-white"}`}
              >
                <div className={`px-3 pt-3 pb-2.5 text-[10px] font-normal uppercase tracking-widest ${isDark ? "text-slate-500" : "text-gray-400"}`}>Editor font</div>
                <div className={`h-px shrink-0 ${dividerClass}`} aria-hidden="true" />
                {EDITOR_FONTS.map((f) => {
                  const selected = f.id === editorFontId;
                  return (
                    <button
                      key={f.id}
                      role="menuitem"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        onEditorFontChange(f.id);
                        setEditorFontOpen(false);
                      }}
                      className={`flex w-full items-center justify-between px-3 py-1.5 text-sm ${selected ? (isDark ? "bg-slate-700 text-emerald-400" : "bg-gray-100 text-emerald-600") : isDark ? "text-slate-200 hover:bg-slate-700" : "text-gray-700 hover:bg-gray-100"}`}
                    >
                      <span className="flex items-center gap-2">
                        <span style={{ fontFamily: f.family }} className="text-sm">
                          {f.label}
                        </span>
                        <span className={`text-[10px] uppercase tracking-wide ${isDark ? "text-slate-500" : "text-gray-400"}`}>{f.category}</span>
                      </span>
                      {selected && <Check className="h-4 w-4 shrink-0" aria-hidden="true" />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Preview font picker */}
          <div className="relative">
            <button
              type="button"
              onClick={() => {
                setPreviewFontOpen((o) => !o);
                setEditorFontOpen(false);
                setHeadingOpen(false);
              }}
              onBlur={() => setTimeout(() => setPreviewFontOpen(false), 150)}
              title="Preview font"
              aria-label="Preview font"
              aria-expanded={previewFontOpen}
              aria-haspopup="menu"
              className={`${btnBase} gap-1.5 px-2`}
            >
              <BookOpen className="h-4 w-4 shrink-0" />
              <span className="hidden sm:inline text-xs font-medium">Preview font</span>
              <ChevronDown className="h-3 w-3 opacity-60" />
            </button>
            {previewFontOpen && (
              <div
                role="menu"
                className={`absolute right-0 top-full z-30 mt-1 w-60 rounded-md border py-1 shadow-lg ${isDark ? "border-slate-700 bg-slate-800" : "border-gray-200 bg-white"}`}
              >
                <div className={`px-3 pt-3 pb-2.5 text-[10px] font-normal uppercase tracking-widest ${isDark ? "text-slate-500" : "text-gray-400"}`}>Preview font</div>
                <div className={`h-px shrink-0 ${dividerClass}`} aria-hidden="true" />
                {PREVIEW_FONTS.map((f) => {
                  const selected = f.id === previewFontId;
                  return (
                    <button
                      key={f.id}
                      role="menuitem"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        onPreviewFontChange(f.id);
                        setPreviewFontOpen(false);
                      }}
                      className={`flex w-full items-center justify-between px-3 py-1.5 text-sm ${selected ? (isDark ? "bg-slate-700 text-emerald-400" : "bg-gray-100 text-emerald-600") : isDark ? "text-slate-200 hover:bg-slate-700" : "text-gray-700 hover:bg-gray-100"}`}
                    >
                      <span className="flex items-center gap-2">
                        <span style={{ fontFamily: f.family }} className="text-sm">
                          {f.label}
                        </span>
                        <span className={`text-[10px] uppercase tracking-wide ${isDark ? "text-slate-500" : "text-gray-400"}`}>{f.category}</span>
                      </span>
                      {selected && <Check className="h-4 w-4 shrink-0" aria-hidden="true" />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {showImageComingSoon && (
        <div className={`fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-md border px-4 py-2 text-sm shadow-lg ${isDark ? "border-slate-700 bg-slate-800 text-slate-100" : "border-gray-200 bg-white text-gray-900"}`}>
          Image upload — Coming soon
        </div>
      )}

      {/* Image popup */}
      {showImageModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className={`w-full max-w-md rounded-lg border p-5 shadow-xl ${isDark ? "border-slate-700 bg-slate-800" : "border-gray-200 bg-white"}`}>
            <div className="flex items-center justify-between">
              <h3 className={`text-sm font-semibold ${isDark ? "text-slate-100" : "text-gray-900"}`}>Insert image</h3>
              <button
                type="button"
                onClick={closeImageModal}
                className={`rounded p-1 ${isDark ? "hover:bg-slate-700 text-slate-400" : "hover:bg-gray-100 text-gray-500"}`}
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {imageMode === "choice" && (
              <div className="mt-4 grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setImageMode("upload")}
                  className={`rounded-lg border p-4 text-sm font-medium ${isDark ? "border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-700" : "border-gray-200 bg-gray-50 text-gray-700 hover:bg-gray-100"}`}
                >
                  Upload from device
                </button>
                <button
                  type="button"
                  onClick={() => setImageMode("url")}
                  className={`rounded-lg border p-4 text-sm font-medium ${isDark ? "border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-700" : "border-gray-200 bg-gray-50 text-gray-700 hover:bg-gray-100"}`}
                >
                  From URL
                </button>
              </div>
            )}

            {imageMode === "upload" && (
              <div className="mt-4 space-y-3">
                <input ref={imageFileRef} type="file" accept="image/*" onChange={handleImageFileChange} className="hidden" />
                <button
                  type="button"
                  onClick={() => imageFileRef.current?.click()}
                  className={`w-full rounded-md border px-3 py-2 text-sm ${isDark ? "border-slate-700 bg-slate-900 text-slate-200" : "border-gray-300 bg-white text-gray-700"}`}
                >
                  {imageFileName ? imageFileName : "Choose image…"}
                </button>
                {pendingImageDataUrl && (
                  <img src={pendingImageDataUrl} alt="preview" className="max-h-40 w-full rounded object-contain" />
                )}
                {imageWarning && (
                  <p className={`text-xs ${isDark ? "text-amber-300" : "text-amber-600"}`}>{imageWarning}</p>
                )}
                <input
                  value={imageAlt}
                  onChange={(e) => setImageAlt(e.target.value)}
                  placeholder="Alt text"
                  className={`w-full rounded-md border px-3 py-2 text-sm ${isDark ? "border-slate-700 bg-slate-900 text-slate-100 placeholder:text-slate-500" : "border-gray-300 bg-white text-gray-900 placeholder:text-gray-400"}`}
                />
                <div className="flex justify-between gap-2">
                  <button type="button" onClick={() => setImageMode("choice")} className={`rounded-md px-3 py-2 text-sm ${isDark ? "bg-slate-700 text-slate-200" : "bg-gray-100 text-gray-700"}`}>
                    Back
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (pendingImageDataUrl) {
                        const id = generateImageId();
                        setImage(id, pendingImageDataUrl);
                        const placeholderUrl = `local:${id}`;
                        insertImageMarkdown(imageAlt, placeholderUrl);
                      } else {
                        const url = imageFileName || "https://example.com/image.jpg";
                        insertImageMarkdown(imageAlt, url);
                      }
                      setPendingImageDataUrl(null);
                      setImageFileName("");
                      setImageWarning(null);
                      setImageMode("choice");
                    }}
                    disabled={!pendingImageDataUrl && !imageFileName}
                    className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-emerald-400 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Insert
                  </button>
                </div>
              </div>
            )}

            {imageMode === "url" && (
              <div className="mt-4 space-y-3">
                <input
                  value={imageAlt}
                  onChange={(e) => setImageAlt(e.target.value)}
                  placeholder="Alt text"
                  className={`w-full rounded-md border px-3 py-2 text-sm ${isDark ? "border-slate-700 bg-slate-900 text-slate-100 placeholder:text-slate-500" : "border-gray-300 bg-white text-gray-900 placeholder:text-gray-400"}`}
                />
                <input
                  value={imageUrl}
                  onChange={(e) => setImageUrl(e.target.value)}
                  placeholder="https://example.com/image.jpg"
                  className={`w-full rounded-md border px-3 py-2 text-sm ${isDark ? "border-slate-700 bg-slate-900 text-slate-100 placeholder:text-slate-500" : "border-gray-300 bg-white text-gray-900 placeholder:text-gray-400"}`}
                />
                <div className="flex justify-between gap-2">
                  <button type="button" onClick={() => setImageMode("choice")} className={`rounded-md px-3 py-2 text-sm ${isDark ? "bg-slate-700 text-slate-200" : "bg-gray-100 text-gray-700"}`}>
                    Back
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      insertImageMarkdown(imageAlt, imageUrl);
                      setImageMode("choice");
                    }}
                    className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-emerald-400"
                  >
                    Insert
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Table popup — grid like Word/Docs */}
      {showTableModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className={`rounded-lg border p-5 shadow-xl ${isDark ? "border-slate-700 bg-slate-800" : "border-gray-200 bg-white"}`}>
            <div className="flex items-center justify-between">
              <h3 className={`text-sm font-semibold ${isDark ? "text-slate-100" : "text-gray-900"}`}>Insert table</h3>
              <button
                type="button"
                onClick={() => setShowTableModal(false)}
                className={`rounded p-1 ${isDark ? "hover:bg-slate-700 text-slate-400" : "hover:bg-gray-100 text-gray-500"}`}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className={`mt-1 text-xs ${isDark ? "text-slate-400" : "text-gray-500"}`}>
              {tableHover.cols} × {tableHover.rows}
            </p>
            <div className="mt-3 grid gap-1" style={{ gridTemplateColumns: `repeat(10, 1fr)` }}>
              {Array.from({ length: 80 }).map((_, idx) => {
                const r = Math.floor(idx / 10) + 1;
                const c = (idx % 10) + 1;
                const active = r <= tableHover.rows && c <= tableHover.cols;
                return (
                  <div
                    key={idx}
                    onMouseEnter={() => setTableHover({ rows: r, cols: c })}
                    onClick={() => insertTable(r, c)}
                    className={`h-6 w-6 cursor-pointer rounded-sm border ${active ? (isDark ? "bg-emerald-600 border-emerald-500" : "bg-emerald-100 border-emerald-500") : isDark ? "border-slate-700 bg-slate-900" : "border-gray-200 bg-white"}`}
                  />
                );
              })}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowTableModal(false)}
                className={`rounded-md px-3 py-2 text-sm ${isDark ? "bg-slate-700 text-slate-200" : "bg-gray-100 text-gray-700"}`}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
