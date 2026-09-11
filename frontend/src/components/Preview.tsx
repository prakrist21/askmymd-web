import { useEffect, useRef } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
// highlight.js-free by design: code blocks render plain on the dark card.
// The dark variant (not the main entry) is deliberate: the main css resolves
// its variables to the LIGHT theme unless the OS prefers dark — headless
// Chrome and light-mode users would get white-table zebra and muted grays.
// Its variable-driven light values only leak through on table chrome in
// light mode; every text color is pinned per-theme in preview.css.
import "github-markdown-css/github-markdown-dark.css";
import "../styles/preview.css";

export type PreviewTheme = "dark" | "light";

interface PreviewProps {
  content: string;
  isDark: boolean;
}

/* ------------------------------------------------------------------ */
/* Mermaid                                                             */
/* ------------------------------------------------------------------ */

type LoadedMermaid = typeof import("mermaid").default;

// The id passed to mermaid.render must be unique per call; reuse poisons
// the SVG output, so hand out monotonically increasing ids.
let mermaidRenderId = 0;

let mermaidPromise: Promise<LoadedMermaid> | null = null;

// Color config per theme (the diagram palette flips; behavior does not).
// Initialize mermaid for diagrams — conditional on isDark so light mode
// gets dark diagram colors (visible on white) and dark mode gets light
// colors (visible on dark background). The initialize-level color keys
// belong under themeVariables — that is where mermaid actually reads them.
// securityLevel "strict": user-authored diagrams must not run scripts/HTML labels.
// startOnLoad stays false — we render manually because the global walker
// double-fires under React re-renders.
const MERMAID_CONFIG = {
  light: {
    startOnLoad: false as const,
    securityLevel: "strict" as const,
    theme: "default" as const,
    flowchart: { curve: "basis" } as const,
    themeVariables: {
      // Flowchart palette: teal/coral instead of flat lavender — rounded + shadow via CSS
      primaryColor: "#ccfbf1",
      primaryBorderColor: "#2dd4bf",
      primaryTextColor: "#134e4a",
      secondaryColor: "#ffe4e6",
      secondaryBorderColor: "#fb7185",
      secondaryTextColor: "#881337",
      tertiaryColor: "#fef3c7",
      tertiaryBorderColor: "#fcd34d",
      tertiaryTextColor: "#78350f",
      lineColor: "#6b7280",
      textColor: "#1f2937",
      titleColor: "#1f2937",
      noteBkgColor: "#f9fafb",
      noteBorderColor: "#d1d5db",
      noteTextColor: "#1f2937",
      // Mindmap central root (section-root uses git0 / gitBranchLabel0)
      // Light: soft pastel lavender matching branch lightness, dark text
      git0: "#ede9fe",
      gitBranchLabel0: "#1e293b",
      // Ensure mindmap branches also use light pastels (override defaults)
      cScale0: "#ede9fe",
      cScaleLabel0: "#1e293b",
      cScale1: "#f3e8ff",
      cScaleLabel1: "#1f2937",
      cScale2: "#fef3c7",
      cScaleLabel2: "#1f2937",
      cScale3: "#cffafe",
      cScaleLabel3: "#1f2937",
      cScale4: "#dcfce7",
      cScaleLabel4: "#1f2937",
      cScale5: "#fce7f3",
      cScaleLabel5: "#1f2937",
    },
  },
  dark: {
    startOnLoad: false as const,
    securityLevel: "strict" as const,
    theme: "dark" as const,
    flowchart: { curve: "basis" } as const,
    themeVariables: {
      primaryColor: "#134e4a",
      primaryBorderColor: "#2dd4bf",
      primaryTextColor: "#f0fdfa",
      secondaryColor: "#881337",
      secondaryBorderColor: "#fb7185",
      secondaryTextColor: "#ffe4e6",
      tertiaryColor: "#78350f",
      tertiaryBorderColor: "#fcd34d",
      tertiaryTextColor: "#fef3c7",
      lineColor: "#9ca3af",
      textColor: "#f1f5f9",
      titleColor: "#f1f5f9",
      noteBkgColor: "#1e293b",
      noteBorderColor: "#475569",
      noteTextColor: "#f1f5f9",
      // Mindmap central root — mid-tone distinct center with white text
      git0: "#1e3a8a",
      gitBranchLabel0: "#f1f5f9",
      cScale0: "#1e3a8a",
      cScaleLabel0: "#f1f5f9",
      cScale1: "#4c1d95",
      cScaleLabel1: "#f1f5f9",
      cScale2: "#0c4a6e",
      cScaleLabel2: "#f1f5f9",
      cScale3: "#3730a3",
      cScaleLabel3: "#f1f5f9",
      cScale4: "#14532d",
      cScaleLabel4: "#f1f5f9",
      cScale5: "#831843",
      cScaleLabel5: "#f1f5f9",
    },
  },
} as const;

// For backward compat with existing getMermaid(theme) calls — maps PreviewTheme to MERMAID_CONFIG
const MERMAID_THEMES = {
  light: MERMAID_CONFIG.light,
  dark: MERMAID_CONFIG.dark,
} as const;

async function getMermaid(theme: PreviewTheme): Promise<LoadedMermaid> {
  mermaidPromise ??= import("mermaid").then((m) => m.default);
  const mermaid = await mermaidPromise;
  mermaid.initialize(MERMAID_THEMES[theme]);
  return mermaid;
}

async function getMermaidForTheme(isDark: boolean): Promise<LoadedMermaid> {
  mermaidPromise ??= import("mermaid").then((m) => m.default);
  const mermaid = await mermaidPromise;
  mermaid.initialize(MERMAID_CONFIG[isDark ? "dark" : "light"]);
  return mermaid;
}
void getMermaid;
void getMermaidForTheme;

function nextRenderId(): string {
  mermaidRenderId += 1;
  return `askmymd-mermaid-${mermaidRenderId}`;
}

function addCodeCopyButtons(container: HTMLElement) {
  const pres = Array.from(container.querySelectorAll("pre"));
  pres.forEach((pre) => {
    const code = pre.querySelector("code");
    if (!code) return;
    if (code.classList.contains("language-mermaid")) return;
    if (pre.querySelector(".code-copy-btn")) return;
    const codeText = (code.textContent ?? "").replace(/\n$/, "");
    if (!codeText.trim()) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "code-copy-btn";
    btn.setAttribute("aria-label", "Copy code");
    btn.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v3"></path></svg><span>Copy</span>';
    let timeout: number | undefined;
    btn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(codeText);
      } catch {
        const ta = document.createElement("textarea");
        ta.value = codeText;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        try {
          document.execCommand("copy");
        } catch {}
        document.body.removeChild(ta);
      }
      const original = btn.innerHTML;
      btn.classList.add("copied");
      btn.innerHTML =
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg><span>Copied</span>';
      btn.setAttribute("aria-label", "Copied");
      clearTimeout(timeout);
      timeout = window.setTimeout(() => {
        btn.classList.remove("copied");
        btn.innerHTML = original;
        btn.setAttribute("aria-label", "Copy code");
      }, 1500);
    });
    pre.appendChild(btn);
  });
}

/**
 * Patch mindmap central root node + light-mode dark fills.
 * Mermaid's root (section-0) was previously hardcoded to dark blue fill
 * (#1e3a8a) with dark text, unreadable in light mode. This enforces
 * per-theme fills: light = soft pastel #ede9fe + dark text #1e293b
 * (matches branch pastel lightness), dark = #1e3a8a + near-white text.
 * Handles both SVG <text> and <foreignObject><div> label cases.
 *
 * Additionally, in light mode ANY shape that still has a dark fill
 * (e.g. other diagrams that slipped through themeVariables) is
 * lightened to a pastel, because black text on dark bg is unreadable.
 */
function patchMindmapRoot(container: HTMLElement, isDark: boolean) {
  const lightFill = "#ede9fe";
  const lightStroke = "#a78bfa";
  const lightText = "#1e293b";
  const darkFill = "#1e3a8a";
  const darkStroke = "#3b82f6";
  const darkText = "#f1f5f9";

  const fill = isDark ? darkFill : lightFill;
  const stroke = isDark ? darkStroke : lightStroke;
  const text = isDark ? darkText : lightText;

  // Root shapes: section-root / section--1 is mermaid's central node (section-0 is branch 0)
  // Covers both .askmymd-mermaid and .mermaid aliases
  const shapeSelectors = [
    ".section-root rect",
    ".section-root circle",
    ".section-root path",
    ".section-root polygon",
    ".section--1 rect",
    ".section--1 circle",
    ".section--1 path",
    ".section--1 polygon",
    ".section-0 rect",
    ".section-0 circle",
    ".section-0 path",
    '[class*="section-root"] rect',
    '[class*="section-root"] circle',
    '[class*="section-root"] path',
    '[class*="section--1"] rect',
    '[class*="section--1"] circle',
    '[class*="section--1"] path',
    '[class*="section-0"] rect',
    '[class*="section-0"] circle',
    '[class*="section-0"] path',
  ].join(", ");
  const shapes = container.querySelectorAll(shapeSelectors);
  shapes.forEach((el) => {
    const shape = el as SVGElement & HTMLElement;
    try {
      shape.setAttribute("fill", fill);
      shape.setAttribute("stroke", stroke);
      shape.style.fill = fill;
      shape.style.stroke = stroke;
    } catch {
      // Ignore non-SVG elements
    }
  });

  const textSelectors = [
    ".section-root text",
    ".section--1 text",
    ".section-0 text",
    '[class*="section-root"] text',
    '[class*="section--1"] text',
    '[class*="section-0"] text',
    ".section-root foreignObject div",
    ".section--1 foreignObject div",
    ".section-0 foreignObject div",
    '[class*="section-root"] foreignObject div',
    '[class*="section--1"] foreignObject div',
    '[class*="section-0"] foreignObject div',
    ".section-root foreignObject span",
    ".section--1 foreignObject span",
    ".section-0 foreignObject span",
    '[class*="section-root"] foreignObject span',
    '[class*="section--1"] foreignObject span',
    '[class*="section-0"] foreignObject span',
  ].join(", ");
  const texts = container.querySelectorAll(textSelectors);
  texts.forEach((el) => {
    const t = el as SVGElement & HTMLElement;
    try {
      t.setAttribute("fill", text);
      t.style.fill = text;
      t.style.color = text;
    } catch {
      // Ignore
    }
  });

  // Light mode: ensure NO shape keeps a dark fill with black/dark text.
  // Branch nodes already use light pastels correctly; this catches any
  // stray dark fills (mindmap root or other diagram types) that were
  // hardcoded or leaked from dark theme. Includes pure blue #0000ff
  // seen in the Cricket Performance mindmap central node.
  if (!isDark) {
    const DARK_FILLS = new Set([
      "#1e3a8a",
      "#1e3a8a".toUpperCase(),
      "#4c1d95",
      "#0c4a6e",
      "#1e293b",
      "#0f172a",
      "#334155",
      "#1e40af",
      "#312e81",
      "#082f49",
      "#0000ff",
      "#0000FF",
      "#0000cd",
      "#0000CD",
      "#000080",
    ]);
    const allShapes = container.querySelectorAll(
      "rect, circle, path, polygon, ellipse, rect[fill], circle[fill], path[fill]"
    );
    allShapes.forEach((el) => {
      const shape = el as SVGElement & HTMLElement;
      const rawFill = (shape.getAttribute("fill") || shape.style.fill || "").toLowerCase().trim();
      // Normalize rgb() to hex would be ideal, but check hex set and luminance fallback
      let isDarkFill = false;
      if (DARK_FILLS.has(rawFill) || DARK_FILLS.has(rawFill.toUpperCase())) {
        isDarkFill = true;
      } else if (rawFill.startsWith("#")) {
        // Check luminance: dark if < 0x777777-ish
        try {
          const hex = rawFill.replace("#", "");
          const fullHex = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
          if (fullHex.length === 6) {
            const r = parseInt(fullHex.slice(0, 2), 16);
            const g = parseInt(fullHex.slice(2, 4), 16);
            const b = parseInt(fullHex.slice(4, 6), 16);
            const lum = 0.299 * r + 0.587 * g + 0.114 * b;
            if (lum < 80) isDarkFill = true; // very dark bg
          }
        } catch {
          // ignore parse errors
        }
      } else if (rawFill.startsWith("rgb")) {
        const m = rawFill.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
        if (m) {
          const lum = 0.299 * parseInt(m[1]) + 0.587 * parseInt(m[2]) + 0.114 * parseInt(m[3]);
          if (lum < 80) isDarkFill = true;
        }
      }
      if (isDarkFill) {
        try {
          shape.setAttribute("fill", lightFill);
          shape.style.fill = lightFill;
          // Keep border visible but not dark
          const curStroke = shape.getAttribute("stroke") || "";
          if (!curStroke || DARK_FILLS.has(curStroke.toLowerCase())) {
            shape.setAttribute("stroke", lightStroke);
            shape.style.stroke = lightStroke;
          }
        } catch {
          // ignore
        }
      }
    });
    // Also ensure all text in light mode is dark (not white on light)
    // – branch nodes already have dark text, but fix any light text that
    //   would be invisible on light bg after we lightened the fill.
    const allTexts = container.querySelectorAll("text, foreignObject div, foreignObject span, foreignObject p");
    allTexts.forEach((el) => {
      const t = el as HTMLElement & SVGElement;
      const raw = (t.getAttribute("fill") || (t as HTMLElement).style.fill || (t as HTMLElement).style.color || "").toLowerCase();
      const lightTexts = new Set(["#f1f5f9", "#f8fafc", "#ffffff", "white", "#fefefe"]);
      if (lightTexts.has(raw) || raw === "rgb(241, 245, 249)") {
        try {
          t.setAttribute("fill", lightText);
          (t as HTMLElement).style.fill = lightText;
          (t as HTMLElement).style.color = lightText;
        } catch {
          // ignore
        }
      }
    });
  }
}

/* ------------------------------------------------------------------ */
/* Preview                                                             */
/* ------------------------------------------------------------------ */

/**
 * marked + DOMPurify pipeline: parse → sanitize → innerHTML, then swap
 * every ```mermaid code block for a fixed, styled container rendered via
 * mermaid.render(). Invalid diagrams degrade to an amber fallback card
 * showing the parse error plus the source. Re-renders on content AND
 * theme change — diagrams re-render with the theme's palette.
 *
 * The containers are plain DOM (not React nodes) on purpose: mermaid owns
 * their lifecycle, and the whole subtree is rebuilt on every content
 * change, so React reconciliation would only fight the renderer.
 */
export default function Preview({ content, isDark }: PreviewProps) {
  const previewRef = useRef<HTMLDivElement>(null);
  const theme: PreviewTheme = isDark ? "dark" : "light";

  useEffect(() => {
    const el = previewRef.current;
    if (!el) return;

    if (!content.trim()) {
      el.innerHTML = "";
      return;
    }

    const html = marked.parse(content) as string;
    el.innerHTML = DOMPurify.sanitize(html);

    addCodeCopyButtons(el);

    // marked emits ```mermaid as <pre><code class="language-mermaid">.
    const blocks = Array.from(el.querySelectorAll("pre > code.language-mermaid"));
    if (blocks.length === 0) return;

    let cancelled = false;
    const jobs = blocks
      .map((block) => {
        const pre = block.parentElement;
        if (!pre) return null;
        const source = (block.textContent ?? "").replace(/\n$/, "");
        const container = document.createElement("div");
        container.className = "askmymd-mermaid";
        container.dataset.state = "loading";
        pre.replaceWith(container);
        return { container, source };
      })
      .filter((job): job is { container: HTMLDivElement; source: string } => job !== null);

    // Clear mermaid cache so theme variables take effect on next render
    if ((window as unknown as { mermaid?: { contentLoaded: () => void } }).mermaid) {
      (window as unknown as { mermaid: { contentLoaded: () => void } }).mermaid.contentLoaded();
    }

    // Use isDark-aware initializer so light mode gets dark diagram colors
    getMermaidForTheme(isDark)
      .then((mermaid) =>
        Promise.all(
          jobs.map(async ({ container, source }) => {
            try {
              const { svg } = await mermaid.render(nextRenderId(), source);
              if (cancelled) return;
              container.innerHTML = svg;
              // Per-theme mindmap root fix — ensures light/dark root is readable
              try {
                patchMindmapRoot(container, isDark);
              } catch {
                // Non-fatal: CSS fallback in preview.css still applies
              }
              container.dataset.state = "done";
            } catch (err) {
              if (cancelled) return;
              const message =
                err instanceof Error ? err.message : "Unknown mermaid rendering error";
              // Built with createElement/textContent (no string templates)
              // so the error message and source can't inject markup.
              const fig = document.createElement("figure");
              fig.className = "askmymd-mermaid-error";
              const cap = document.createElement("figcaption");
              cap.textContent = "Mermaid diagram failed to render";
              const msg = document.createElement("p");
              msg.textContent = message;
              const src = document.createElement("pre");
              src.textContent = source;
              fig.append(cap, msg, src);
              container.replaceWith(fig);
            }
          })
        )
      )
      .catch((err: unknown) => {
        // Mermaid itself failed to load; containers stay empty placeholders.
        console.error("mermaid failed to load", err);
      });

    return () => {
      cancelled = true;
    };
  }, [content, theme, isDark]);

  return (
    <div className={`flex flex-col ${isDark ? "bg-slate-950" : "bg-white"}`}>
      <div className={`sticky top-14 z-10 border-b px-4 py-2 ${isDark ? "border-slate-800 bg-slate-950" : "border-gray-200 bg-white"}`}>
        <span className={`text-sm font-semibold tracking-wide uppercase ${isDark ? "text-slate-400" : "text-gray-500"}`}>
          Preview
        </span>
      </div>
      <div
        ref={previewRef}
        className={`preview-container markdown-body ${isDark ? "dark" : "light"}`}
      />
    </div>
  );
}
