/**
 * Interactive controls for rendered Mermaid diagrams.
 *
 * attachMermaidToolbar(container) wraps every rendered diagram in a
 * hover-reveal toolbar (top-right): PNG download (2x canvas), SVG download,
 * clipboard PNG copy, and a full-screen preview with zoom/pan.
 *
 * Plain DOM, not React: mermaid owns the diagram lifecycle and the whole
 * preview subtree is rebuilt on every content change (same reason the
 * containers themselves are plain DOM — see Preview.tsx).
 */

/* ------------------------------------------------------------------ */
/* Icon markup (inline SVG, stroke = currentColor to inherit theme)    */
/* ------------------------------------------------------------------ */

const ICONS = {
  png:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
  svg:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/><circle cx="17.5" cy="6.5" r="2.5"/></svg>',
  copy:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v3"/></svg>',
  check:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>',
  expand:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>',
  close:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  plus:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  minus:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  reset:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>',
} as const;

/* ------------------------------------------------------------------ */
/* Derived names                                                       */
/* ------------------------------------------------------------------ */

/** Index of the diagram among all rendered ones, for generic fallback names. */
let diagramCounter = 0;

/**
 * Diagram name: explicit `%%title` comment, or the first node/section
 * label in the source, sanitized for filenames. Falls back to
 * mermaid-diagram-{index} for anonymous diagrams.
 */
function deriveDiagramName(source: string): string {
  const titleMatch = source.match(/^\s*%%\s*title:\s*(.+)$/m);
  if (titleMatch) {
    const t = titleMatch[1].trim().replace(/[\\/:*?"<>|#]+/g, "").slice(0, 60).trim();
    if (t) return t;
  }
  // First quoted or bracketed label: A[Start], root((Docs)), "My Chart"
  const labelMatch = source.match(/[([]"([^")\]]+)"?[)\]]|\["([^"\]]+)"\]|"([^"\n]{2,})"/);
  const raw = labelMatch ? (labelMatch[1] ?? labelMatch[2] ?? labelMatch[3]) : "";
  const t = raw.replace(/[\\/:*?"<>|#]+/g, "").slice(0, 60).trim();
  if (t) return t;
  diagramCounter += 1;
  return `mermaid-diagram-${diagramCounter}`;
}

/* ------------------------------------------------------------------ */
/* SVG → canvas rasterization                                          */
/* ------------------------------------------------------------------ */

/** Parse a width/height attribute, rejecting percentages and garbage. */
function parseSizeAttr(value: string | null): number | null {
  if (!value) return null;
  const s = value.trim();
  if (s.endsWith("%")) return null; // mermaid emits width="100%" — not intrinsic
  const n = parseFloat(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Read the diagram's intrinsic size. Mermaid sets width/height attributes
 * (or viewBox); CSS may additionally scale the element, which we ignore —
 * exports always use the diagram's natural geometry.
 */
function getSvgSize(svg: SVGSVGElement): { width: number; height: number } {
  const wAttr = parseSizeAttr(svg.getAttribute("width"));
  const hAttr = parseSizeAttr(svg.getAttribute("height"));
  const viewBox = svg.viewBox?.baseVal;
  if (wAttr !== null && hAttr !== null) {
    return { width: wAttr, height: hAttr };
  }
  if (viewBox && viewBox.width > 0 && viewBox.height > 0) {
    return { width: viewBox.width, height: viewBox.height };
  }
  const rect = svg.getBoundingClientRect();
  return { width: Math.max(rect.width, 1), height: Math.max(rect.height, 1) };
}

const INLINED_PROPS = [
  "fill",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-dasharray",
  "fill-opacity",
  "stroke-opacity",
  "opacity",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "color",
  "background-color",
  "text-anchor",
  "dominant-baseline",
  "letter-spacing",
  "marker-end",
  "paint-order",
  "shape-rendering",
  "text-rendering",
] as const;

/**
 * Inline the *computed* styles of `source`'s elements onto the matching
 * elements of `target` (a same-structure clone). The diagrams are styled
 * by page-level CSS (preview.css node/edge overrides) which does not
 * apply inside an <img> or a modal outside .preview-container — baking
 * the computed values in keeps exports and the modal visually identical
 * to the inline render.
 */
function inlineComputedSvgStyles(source: Element, target: Element): void {
  const srcEls = [source, ...Array.from(source.querySelectorAll("*"))];
  const tgtEls = [target, ...Array.from(target.querySelectorAll("*"))];
  if (srcEls.length !== tgtEls.length) return; // structure drifted; bail out safely
  const cs = window.getComputedStyle;
  for (let i = 0; i < srcEls.length; i++) {
    const computed = cs(srcEls[i]);
    const style = (tgtEls[i] as HTMLElement | SVGElement).style;
    for (const prop of INLINED_PROPS) {
      style.setProperty(prop, computed.getPropertyValue(prop));
    }
  }
}

/** UTF-8-safe SVG markup → base64 data URL (TextEncoder, no deprecated unescape). */
function svgToDataUrl(xml: string): string {
  const bytes = new TextEncoder().encode(xml);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return `data:image/svg+xml;base64,${window.btoa(binary)}`;
}

/** Serialize `svg` (styles already inlined by the caller) into an XML string. */
function serializeSvg(svg: SVGSVGElement, width: number, height: number): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  // Export at natural size: the on-screen svg is CSS-scaled to 100% width.
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
  return new XMLSerializer().serializeToString(clone);
}

/** Draw the SVG into an off-DOM canvas at `scale` × natural size. */
async function svgToCanvas(
  svg: SVGSVGElement,
  scale: number,
  background: string
): Promise<HTMLCanvasElement> {
  const { width, height } = getSvgSize(svg);

  // Bake page-level CSS into inline styles before serializing.
  const styled = svg.cloneNode(true) as SVGSVGElement;
  inlineComputedSvgStyles(svg, styled);
  const xml = serializeSvg(styled, width, height);

  const img = new Image();
  img.decoding = "sync";
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("Failed to rasterize diagram SVG"));
    img.src = svgToDataUrl(xml);
  });

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");
  // Opaque theme-colored background: dark-theme diagrams use light text,
  // which would be invisible if pasted onto white with a transparent bg.
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.scale(scale, scale);
  ctx.drawImage(img, 0, 0, width, height);
  return canvas;
}

/** Background color for exports: the diagram card's own computed surface. */
function diagramSurfaceColor(container: HTMLElement): string {
  const bg = window.getComputedStyle(container).backgroundColor;
  return bg && bg !== "transparent" && bg !== "rgba(0, 0, 0, 0)" ? bg : "#ffffff";
}

/* ------------------------------------------------------------------ */
/* Downloads                                                           */
/* ------------------------------------------------------------------ */

function triggerDownload(href: string, filename: string) {
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function downloadPng(svg: SVGSVGElement, filename: string, background: string) {
  const canvas = await svgToCanvas(svg, 2, background);
  const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("PNG encoding failed");
  const url = URL.createObjectURL(blob);
  triggerDownload(url, `${filename}.png`);
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function downloadSvg(svg: SVGSVGElement, filename: string) {
  const { width, height } = getSvgSize(svg);
  const xml = serializeSvg(svg, width, height);
  const blob = new Blob([xml], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  triggerDownload(url, `${filename}.svg`);
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/* ------------------------------------------------------------------ */
/* Clipboard                                                           */
/* ------------------------------------------------------------------ */

async function copyPngToClipboard(svg: SVGSVGElement, background: string): Promise<void> {
  const canvas = await svgToCanvas(svg, 2, background);
  const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("PNG encoding failed");
  if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
    throw new Error("Clipboard image write not supported in this browser");
  }
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}

/* ------------------------------------------------------------------ */
/* Toolbar attachment (per rendered diagram container)                 */
/* ------------------------------------------------------------------ */

/**
 * Blink the button to the check icon (green via .copied) for 1.5s, then
 * restore the copy icon. Buttons are icon-only and fixed-size, so the
 * flash swaps icons without any layout shift. Both callers are copy
 * buttons, so restoring ICONS.copy is always correct.
 */
function flashCopied(btn: HTMLButtonElement) {
  btn.classList.add("copied");
  btn.innerHTML = ICONS.check;
  btn.setAttribute("aria-label", "Copied diagram to clipboard");
  btn.title = "Copied!";
  window.setTimeout(() => {
    btn.classList.remove("copied");
    btn.innerHTML = ICONS.copy;
    btn.setAttribute("aria-label", "Copy diagram as PNG to clipboard");
    btn.title = "Copy diagram as PNG to clipboard";
  }, 1500);
}

/**
 * Build one compact icon-only button: a fixed 32×32 box (6px padding,
 * overflow hidden — enforced again in CSS) holding an 18px icon. The
 * accessible name comes from aria-label and the tooltip from title, so
 * no visible text span is needed.
 */
function makeToolbarButton(className: string, label: string, icon: string): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `mermaid-toolbar-btn ${className}`;
  btn.setAttribute("aria-label", label);
  btn.title = label;
  btn.innerHTML = icon;
  return btn;
}

/**
 * Attach the hover toolbar to one rendered mermaid container.
 * Idempotent per container (guards against double-attach).
 */
export function attachMermaidToolbar(container: HTMLElement, source: string): void {
  if (container.querySelector(".mermaid-toolbar")) return;
  const svg = container.querySelector("svg");
  if (!svg) return;
  const svgEl = svg as SVGSVGElement;
  const name = deriveDiagramName(source);
  const surface = diagramSurfaceColor(container);

  const toolbar = document.createElement("div");
  toolbar.className = "mermaid-toolbar";

  // --- PNG download -------------------------------------------------
  const pngBtn = makeToolbarButton("mermaid-btn-png", "PNG", ICONS.png);
  pngBtn.addEventListener("click", () => {
    downloadPng(svgEl, name, surface).catch((err) =>
      console.error("mermaid PNG export failed", err)
    );
  });

  // --- SVG download -------------------------------------------------
  const svgBtn = makeToolbarButton("mermaid-btn-svg", "SVG", ICONS.svg);
  svgBtn.addEventListener("click", () => {
    try {
      const styled = svgEl.cloneNode(true) as SVGSVGElement;
      inlineComputedSvgStyles(svgEl, styled);
      downloadSvg(styled, name);
    } catch (err) {
      console.error("mermaid SVG export failed", err);
    }
  });

  // --- Copy image ---------------------------------------------------
  const copyBtn = makeToolbarButton("mermaid-btn-copy", "Copy", ICONS.copy);
  copyBtn.addEventListener("click", () => {
    copyPngToClipboard(svgEl, surface)
      .then(() => flashCopied(copyBtn))
      .catch((err) => {
        console.error("mermaid clipboard copy failed", err);
        window.alert("Could not copy diagram to clipboard. Try the PNG download instead.");
      });
  });

  // --- Preview / zoom ----------------------------------------------
  const previewBtn = makeToolbarButton("mermaid-btn-preview", "Preview", ICONS.expand);
  previewBtn.addEventListener("click", () => {
    // Theme can change after attach; derive from the live container.
    const isDark = container.closest(".preview-container")?.classList.contains("dark") ?? true;
    openMermaidModal(svgEl, name, surface, isDark);
  });

  toolbar.append(pngBtn, svgBtn, copyBtn, previewBtn);
  container.appendChild(toolbar);
}

/* ------------------------------------------------------------------ */
/* Full-screen preview modal                                           */
/* ------------------------------------------------------------------ */

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 5;
const ZOOM_STEP = 1.2;

/**
 * Open the full-screen modal for a diagram SVG (cloned, with the inline
 * render's computed styles baked in so it matches the card). Closes via
 * Escape / backdrop / ✕ — all handled here.
 */
function openMermaidModal(svg: SVGSVGElement, name: string, surface: string, isDark: boolean) {
  // Close any already-open modal first.
  document.querySelector(".mermaid-modal-overlay")?.remove();

  const overlay = document.createElement("div");
  overlay.className = "mermaid-modal-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", `Diagram preview: ${name}`);

  const panel = document.createElement("div");
  panel.className = `mermaid-modal-panel ${isDark ? "dark" : "light"}`;

  const header = document.createElement("div");
  header.className = "mermaid-modal-header";

  const title = document.createElement("span");
  title.className = "mermaid-modal-title";
  title.textContent = name;

  const headerActions = document.createElement("div");
  headerActions.className = "mermaid-modal-header-actions";

  const zoomOutBtn = makeToolbarButton("mermaid-btn-zoom-out", "Zoom out", ICONS.minus);
  const zoomLabel = document.createElement("span");
  zoomLabel.className = "mermaid-zoom-label";
  zoomLabel.textContent = "100%";
  const zoomInBtn = makeToolbarButton("mermaid-btn-zoom-in", "Zoom in", ICONS.plus);
  const resetBtn = makeToolbarButton("mermaid-btn-reset", "Reset zoom", ICONS.reset);
  const closeBtn = makeToolbarButton("mermaid-btn-close", "Close preview", ICONS.close);

  // Same download/copy actions as the inline toolbar.
  const pngBtn = makeToolbarButton("mermaid-btn-png", "PNG", ICONS.png);
  const svgBtn = makeToolbarButton("mermaid-btn-svg", "SVG", ICONS.svg);
  const copyBtn = makeToolbarButton("mermaid-btn-copy", "Copy", ICONS.copy);

  headerActions.append(zoomOutBtn, zoomLabel, zoomInBtn, resetBtn, pngBtn, svgBtn, copyBtn, closeBtn);
  header.append(title, headerActions);

  const viewport = document.createElement("div");
  viewport.className = "mermaid-modal-viewport";
  const stage = document.createElement("div");
  stage.className = "mermaid-modal-stage";

  // Clone with page-CSS styles baked in so the modal render matches the card.
  // cloneNode(true) is a DEEP clone — all rendered child nodes and inline
  // styles come along; the toolbar is only attached after mermaid.render()
  // resolved and data-state="done" was set, so the source can't be a
  // placeholder at this point.
  const modalSvg = svg.cloneNode(true) as SVGSVGElement;
  inlineComputedSvgStyles(svg, modalSvg);

  // Defensive: a clone with no rendered children would paint nothing.
  if (!modalSvg.firstElementChild) {
    console.error("mermaid modal: diagram SVG has no rendered content; aborting open");
    return;
  }

  stage.appendChild(modalSvg);
  viewport.appendChild(stage);

  panel.append(header, viewport);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  // Give the clone DEFINITE dimensions. Mermaid emits width="100%" (and
  // sometimes max-width in a style attr), which collapses to zero inside
  // the auto-sized flex stage — an invisible modal body. Size it to the
  // diagram's intrinsic geometry (viewBox user units), scaled to fit the
  // viewport so 100% zoom always shows the whole diagram on open.
  const intrinsic = getSvgSize(svg);
  const vw = viewport.clientWidth || Math.floor(window.innerWidth * 0.9);
  const vh = viewport.clientHeight || Math.floor(window.innerHeight * 0.7);
  const fit = Math.min(1, vw / intrinsic.width, vh / intrinsic.height);
  const drawW = Math.max(1, Math.floor(intrinsic.width * fit));
  const drawH = Math.max(1, Math.floor(intrinsic.height * fit));
  modalSvg.style.width = `${drawW}px`;
  modalSvg.style.height = `${drawH}px`;
  modalSvg.removeAttribute("width");
  modalSvg.removeAttribute("height");

  // --- zoom + pan state ---------------------------------------------
  const state = { scale: 1, tx: 0, ty: 0 };

  const applyTransform = () => {
    stage.style.transform = `translate(${state.tx}px, ${state.ty}px) scale(${state.scale})`;
    zoomLabel.textContent = `${Math.round(state.scale * 100)}%`;
  };

  const clamp = (s: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, s));

  const setZoom = (next: number, cx = 0, cy = 0) => {
    const clamped = clamp(next);
    // Keep the point under (cx, cy) stationary while zooming (wheel/dblclick).
    const ratio = clamped / state.scale;
    state.tx = cx - (cx - state.tx) * ratio;
    state.ty = cy - (cy - state.ty) * ratio;
    state.scale = clamped;
    applyTransform();
  };

  const zoomBy = (factor: number) => setZoom(state.scale * factor);

  const resetView = () => {
    state.scale = 1;
    state.tx = 0;
    state.ty = 0;
    applyTransform();
  };

  zoomInBtn.addEventListener("click", () => zoomBy(ZOOM_STEP));
  zoomOutBtn.addEventListener("click", () => zoomBy(1 / ZOOM_STEP));
  resetBtn.addEventListener("click", resetView);

  // Scroll-wheel zoom (anchored at cursor).
  viewport.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const rect = viewport.getBoundingClientRect();
      const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
      setZoom(
        state.scale * factor,
        e.clientX - rect.left - rect.width / 2,
        e.clientY - rect.top - rect.height / 2
      );
    },
    { passive: false }
  );

  // Click-and-drag panning.
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  viewport.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    viewport.classList.add("is-panning");
    viewport.setPointerCapture(e.pointerId);
  });
  viewport.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    state.tx += e.clientX - lastX;
    state.ty += e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    applyTransform();
  });
  const endPan = () => {
    dragging = false;
    viewport.classList.remove("is-panning");
  };
  viewport.addEventListener("pointerup", endPan);
  viewport.addEventListener("pointercancel", endPan);

  // Double-click toggles 1x ↔ 2x, anchored at the click point.
  viewport.addEventListener("dblclick", (e) => {
    if (state.scale > 1.01) {
      resetView();
    } else {
      const rect = viewport.getBoundingClientRect();
      setZoom(2, e.clientX - rect.left - rect.width / 2, e.clientY - rect.top - rect.height / 2);
    }
  });

  // --- close paths ----------------------------------------------------
  const close = () => {
    document.removeEventListener("keydown", onKey);
    overlay.remove();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "+" || e.key === "=") {
      zoomBy(ZOOM_STEP);
    } else if (e.key === "-" || e.key === "_") {
      zoomBy(1 / ZOOM_STEP);
    } else if (e.key === "0") {
      resetView();
    }
  };
  document.addEventListener("keydown", onKey);

  closeBtn.addEventListener("click", close);
  // Click on the dark backdrop (not the panel) closes.
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });

  // Modal actions reuse the styled clone (2x PNG, same derived names).
  pngBtn.addEventListener("click", () => {
    downloadPng(modalSvg, name, surface).catch((err) =>
      console.error("mermaid PNG export failed", err)
    );
  });
  svgBtn.addEventListener("click", () => {
    try {
      downloadSvg(modalSvg, name);
    } catch (err) {
      console.error("mermaid SVG export failed", err);
    }
  });
  copyBtn.addEventListener("click", () => {
    copyPngToClipboard(modalSvg, surface)
      .then(() => flashCopied(copyBtn))
      .catch((err) => {
        console.error("mermaid clipboard copy failed", err);
        window.alert("Could not copy diagram to clipboard. Try the PNG download instead.");
      });
  });

  applyTransform();
}
