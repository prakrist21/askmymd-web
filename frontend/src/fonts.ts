/**
 * Font options for editor and preview panes.
 *
 * Each picker offers the same curated 6-font set so users have a consistent
 * choice everywhere, but defaults differ: editor defaults to monospace for
 * source alignment, preview defaults to Inter for prose readability.
 *
 * Fonts use web-safe stacks or the already-loaded Inter CDN import
 * (preview.css @import Inter via Google Fonts). No heavy new dependency is
 * introduced; JetBrains Mono / Fira Code stacks degrade gracefully to
 * ui-monospace if not installed locally.
 */
export type FontCategory = "sans" | "serif" | "mono";

export interface FontOption {
  id: string;
  label: string;
  family: string;
  category: FontCategory;
}

export const FONT_OPTIONS: FontOption[] = [
  {
    id: "inter",
    label: "Inter",
    family: "'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    category: "sans",
  },
  {
    id: "system-sans",
    label: "System Sans",
    family: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    category: "sans",
  },
  {
    id: "georgia",
    label: "Georgia",
    family: "Georgia, 'Times New Roman', serif",
    category: "serif",
  },
  {
    id: "times",
    label: "Times New Roman",
    family: "'Times New Roman', Times, serif",
    category: "serif",
  },
  {
    id: "jetbrains-mono",
    label: "JetBrains Mono",
    family: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    category: "mono",
  },
  {
    id: "fira-code",
    label: "Fira Code",
    family: "'Fira Code', ui-monospace, SFMono-Regular, monospace",
    category: "mono",
  },
] as const;

// Curated same list for both panes; exported separately for clarity / future divergence
export const EDITOR_FONTS: FontOption[] = FONT_OPTIONS;
export const PREVIEW_FONTS: FontOption[] = FONT_OPTIONS;

export const DEFAULT_EDITOR_FONT_ID = "jetbrains-mono";
export const DEFAULT_PREVIEW_FONT_ID = "inter";

export function getFontById(id: string): FontOption | undefined {
  return FONT_OPTIONS.find((f) => f.id === id);
}

export function getFontFamily(id: string, fallbackId: string): string {
  return getFontById(id)?.family ?? getFontById(fallbackId)!.family;
}
