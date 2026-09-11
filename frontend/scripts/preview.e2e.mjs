/**
 * AskmyMD — Preview e2e for the marked + github-markdown-css + mermaid
 * pipeline (headless Chrome).
 *
 * Covers: dark-theme typography (headings/body/emphasis/links), task lists,
 * tables, code cards, blockquote, fixed mermaid containers (light text,
 * capped, chrome-free), the invalid-diagram fallback, full re-render on
 * content change with no stale nodes, light-mode typography + diagrams,
 * theme toggle, and theme persistence across reload, and zero page JS
 * errors.
 *
 * Usage: BASE_URL=http://localhost:5173 node scripts/preview.e2e.mjs
 */
import puppeteer from "puppeteer-core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.BASE_URL || "http://localhost:5173";

const DIAGRAMS = {
  flowchart: "flowchart TD\n  A[Start] --> B{Is it?}\n  B -- Yes --> C[OK]\n  B -- No --> D[End]",
  gantt: "gantt\n  title Plan\n  dateFormat YYYY-MM-DD\n  section Build\n  Design :a1, 2026-09-01, 7d\n  Implement :a2, after a1, 14d",
  mindmap: "mindmap\n  root((Docs))\n    Frontend\n      React\n    Backend\n      FastAPI",
  sequence: "sequenceDiagram\n  Alice->>Bob: Hello\n  Bob-->>Alice: Hi back",
  class: "classDiagram\n  class Animal {\n    +String name\n    +speak()\n  }\n  class Dog\n  Animal <|-- Dog",
  state: "stateDiagram-v2\n  [*] --> Idle\n  Idle --> Running: start\n  Running --> [*]: stop",
  pie: "pie title Share\n  \"A\" : 55\n  \"B\" : 45",
  bar: "xychart-beta\n  title \"Sales\"\n  x-axis [jan, feb, mar]\n  y-axis \"Units\" 0 --> 100\n  bar [30, 60, 90]",
};

const MARKDOWN = [
  "# Heading One",
  "",
  "Body **bold** and *italic* and a [link](https://example.com) plus `inline code`.",
  "",
  "## Heading Two",
  "",
  "### Heading Three",
  "",
  "- alpha",
  "- beta",
  "- [x] done task",
  "- [ ] open task",
  "",
  "1. first",
  "2. second",
  "",
  "> quoted wisdom",
  "",
  "| Col A | Col B |",
  "| ----- | ----- |",
  "| a1    | b1    |",
  "| a2    | b2    |",
  "",
  "```ts",
  "const x: number = 42;",
  "```",
  "",
  "---",
  "",
  ...Object.entries(DIAGRAMS).flatMap(([name, src]) => ["```mermaid", src, "```", ""]),
  // Invalid mermaid → amber error fallback.
  "```mermaid",
  "flowchart TD",
  "  A --> ]]broken[[",
  "```",
].join("\n");

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    fail++;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const userDataDir = mkdtempSync(join(tmpdir(), "askmymd-chrome-"));
function cleanup() {
  try {
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // Windows can hold the dir briefly after close; harmless leftover temp dir.
  }
}

async function main() {
  const browser = await puppeteer.launch({
    headless: true,
    channel: "chrome",
    userDataDir,
    args: ["--no-sandbox", "--disable-gpu", "--window-size=1280,900"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    const consoleErrors = [];
    page.on("pageerror", (e) => consoleErrors.push(String(e)));
    await page.goto(BASE, { waitUntil: "networkidle0", timeout: 30000 });

    await page.waitForSelector("textarea", { timeout: 15000 });
    await page.evaluate((md) => {
      const ta = document.querySelector("textarea");
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value"
      ).set;
      setter.call(ta, md);
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    }, MARKDOWN);

    // All diagrams settled (8 done + 1 error fallback).
    await page.waitForFunction(
      () =>
        document.querySelectorAll('.askmymd-mermaid[data-state="done"] svg').length >= 8 &&
        document.querySelectorAll(".askmymd-mermaid-error").length === 1,
      { timeout: 60000, polling: 500 }
    );

    const s = await page.evaluate(() => {
      const q = (sel) => document.querySelector(sel);
      const cs = (el) => (el ? getComputedStyle(el) : null);
      const pick = (style, keys) =>
        style ? Object.fromEntries(keys.map((k) => [k, style[k]])) : null;
      const container = q(".preview-container");
      const h1 = q(".preview-container h1");
      const h2 = q(".preview-container h2");
      const p = q(".preview-container p");
      const blockquote = q(".preview-container blockquote");
      const th = q(".preview-container th");
      const evenRow = q(".preview-container tbody tr:nth-child(2)");
      const a = q(".preview-container a");
      const strong = q(".preview-container strong");
      const pre = q(".preview-container pre");
      const inlineCode = q(".preview-container p code");
      const preCode = q(".preview-container pre code");
      const checked = q('.preview-container li:has(> input[type="checkbox"]:checked)');
      const checkbox = q('.preview-container li input[type="checkbox"]');
      const card = q(".askmymd-mermaid[data-state='done']");
      const svg = card?.querySelector("svg");
      const textProbe = card?.querySelector("svg text");
      const errCard = q(".askmymd-mermaid-error");
      const cardRect = card?.getBoundingClientRect();
      const svgRect = svg?.getBoundingClientRect();
      return {
        containerPadding: pick(cs(container), ["paddingTop"]),
        h1: pick(cs(h1), ["fontSize", "color", "borderBottomWidth", "borderBottomStyle"]),
        h2fontSize: cs(h2)?.fontSize,
        p: pick(cs(p), ["color", "lineHeight"]),
        blockquote: pick(cs(blockquote), ["borderLeftWidth", "borderLeftStyle", "borderLeftColor"]),
        th: pick(cs(th), ["backgroundColor", "fontWeight"]),
        evenRowBg: cs(evenRow)?.backgroundColor,
        aColor: cs(a)?.color,
        strongColor: cs(strong)?.color,
        pre: pick(cs(pre), ["borderTopWidth", "borderTopStyle", "backgroundColor"]),
        inlineCodeBg: cs(inlineCode)?.backgroundColor,
        preCodeColor: cs(preCode)?.color,
        checkedDecoration: cs(checked)?.textDecorationLine,
        checkedListStyle: cs(checked)?.listStyleType,
        accentColor: cs(checkbox)?.accentColor,
        cards: document.querySelectorAll('.askmymd-mermaid[data-state="done"]').length,
        errors: document.querySelectorAll(".askmymd-mermaid-error").length,
        cardStyle: pick(cs(card), ["backgroundColor", "maxHeight", "overflowY", "paddingTop", "marginTop", "display"]),
        cardTitle: card?.getAttribute("title") ?? null,
        hintEl: !!q(".askmymd-mermaid-hint"),
        textFill: textProbe ? getComputedStyle(textProbe).fill : null,
        svgFits: !!(cardRect && svgRect && svgRect.width <= cardRect.width + 1 && svgRect.height <= cardRect.height + 1),
        errCaption: errCard?.querySelector("figcaption")?.textContent,
        errSrc: errCard?.querySelector("pre")?.textContent,
        errBorder: cs(errCard)?.borderTopColor,
      };
    });

    // --- 1. Markdown typography (github-markdown-css + our overrides) ---
    check("h1 40px bold white + 2px bottom border", s.h1.fontSize === "40px" && s.h1.borderBottomWidth === "2px" && s.h1.borderBottomStyle === "solid", JSON.stringify(s.h1));
    check("h1 text is slate-50", s.h1.color === "rgb(241, 245, 249)", `got ${s.h1.color}`);
    check("h2 32px", s.h2fontSize === "32px", `got ${s.h2fontSize}`);
    check("body text slate-300, leading 1.8", s.p.color === "rgb(203, 213, 225)" && s.p.lineHeight === "28.8px", JSON.stringify(s.p));
    check("blockquote emerald 4px bar", s.blockquote.borderLeftWidth === "4px" && s.blockquote.borderLeftColor === "rgb(16, 185, 129)", JSON.stringify(s.blockquote));
    check("th semibold 600 (GitHub dark)", s.th.backgroundColor === "rgba(0, 0, 0, 0)" && s.th.fontWeight === "600", JSON.stringify(s.th));
    check("even row zebra from github-dark (#151b23)", s.evenRowBg === "rgb(21, 27, 35)", `got ${s.evenRowBg}`);
    check("links emerald", s.aColor === "rgb(16, 185, 129)", `got ${s.aColor}`);
    check("strong slate-50", s.strongColor === "rgb(241, 245, 249)", `got ${s.strongColor}`);
    check("pre is bordered dark card", s.pre.borderTopWidth === "1px" && s.pre.backgroundColor === "rgb(15, 23, 42)", JSON.stringify(s.pre));
    check("inline code chip on slate-800", s.inlineCodeBg === "rgb(30, 41, 59)", `got ${s.inlineCodeBg}`);
    check("block code plain slate-300 (no highlighter)", s.preCodeColor === "rgb(203, 213, 225)", `got ${s.preCodeColor}`);
    check("checked task struck + unmarked", s.checkedDecoration === "line-through" && s.checkedListStyle === "none", `decor=${s.checkedDecoration}, style=${s.checkedListStyle}`);
    check("checkbox emerald accent", s.accentColor === "rgb(16, 185, 129)", `got ${s.accentColor}`);
    check("container p-8, scrolls", s.containerPadding.paddingTop === "32px", `got ${s.containerPadding?.paddingTop}`);

    // --- 2. Mermaid: fixed containers, light text, no chrome ---
    check("8 diagrams rendered", s.cards === 8, `got ${s.cards}`);
    check("1 error fallback", s.errors === 1, `got ${s.errors}`);
    check("container: slate-800 bg, max-h 600, scrolls, centered", s.cardStyle.backgroundColor === "rgb(30, 41, 59)" && s.cardStyle.maxHeight === "600px" && s.cardStyle.overflowY === "auto" && s.cardStyle.display === "flex", JSON.stringify(s.cardStyle));
    check("container padding 24px + margin 24px", s.cardStyle.paddingTop === "24px" && s.cardStyle.marginTop === "24px", JSON.stringify(s.cardStyle));
    check("diagram text is light (slate-200 #e2e8f0)", s.textFill === "rgb(226, 232, 240)", `got ${s.textFill}`);
    check("svg fits container", s.svgFits, "svg overflows card");
    check("no tooltip/hint chrome", !s.hintEl && s.cardTitle === null, `hint=${s.hintEl}, title=${s.cardTitle}`);
    check("error card: caption + source preserved", s.errCaption === "Mermaid diagram failed to render" && (s.errSrc || "").includes("broken"), JSON.stringify({ caption: s.errCaption, src: (s.errSrc || "").slice(0, 40) }));
    check("error card is amber", (s.errBorder || "").startsWith("rgba(245, 158, 11"), `got ${s.errBorder}`);

    // --- 3. Full re-render on content change; nothing stale survives ---
    await page.evaluate(() => {
      const ta = document.querySelector("textarea");
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value"
      ).set;
      setter.call(ta, "# Replaced");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.waitForFunction(
      () =>
        document.querySelectorAll(".askmymd-mermaid, .askmymd-mermaid-error").length === 0 &&
        document.querySelector(".preview-container h1")?.textContent === "Replaced",
      { timeout: 15000, polling: 200 }
    );
    const after = await page.evaluate(() => ({
      svgs: document.querySelectorAll(".askmymd-mermaid svg").length,
      h1: document.querySelector(".preview-container h1")?.textContent,
    }));
    check("content change clears diagrams, re-renders markdown", after.svgs === 0 && after.h1 === "Replaced", JSON.stringify(after));

    // --- 4. Empty input empties the preview ---
    await page.evaluate(() => {
      const ta = document.querySelector("textarea");
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value"
      ).set;
      setter.call(ta, "");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await new Promise((r) => setTimeout(r, 300));
    const empty = await page.evaluate(() => document.querySelector(".preview-container")?.innerHTML);
    check("empty input → empty preview", empty === "", `got ${JSON.stringify((empty || "").slice(0, 60))}`);

    check("no page JS errors so far", consoleErrors.length === 0, consoleErrors.join(" | ").slice(0, 200));

    // --- 5. Light mode: typography + diagrams flip with the toggle ---
    // The empty-input test above cleared the document — refill it so
    // there are diagrams to observe during the toggle.
    await page.evaluate((md) => {
      const ta = document.querySelector("textarea");
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value"
      ).set;
      setter.call(ta, md);
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    }, MARKDOWN);
    await page.waitForFunction(
      () => document.querySelectorAll('.askmymd-mermaid[data-state="done"] svg').length >= 8,
      { timeout: 60000, polling: 300 }
    );

    await page.click("button[aria-label='Switch preview to light mode']");
    // Diagrams must re-render with the light palette before we assert.
    await page.waitForFunction(
      () =>
        document.querySelector(".preview-container")?.classList.contains("light") &&
        document.querySelectorAll('.askmymd-mermaid[data-state="done"] svg').length >= 8,
      { timeout: 30000, polling: 300 }
    );

    const light = await page.evaluate(() => {
      const q = (sel) => document.querySelector(sel);
      const cs = (el) => (el ? getComputedStyle(el) : null);
      const container = q(".preview-container");
      const h1 = q(".preview-container h1");
      const p = q(".preview-container p");
      const th = q(".preview-container th");
      const evenRow = q(".preview-container tbody tr:nth-child(2)");
      const a = q(".preview-container a");
      const card = q(".askmymd-mermaid[data-state='done']");
      const textProbe = card?.querySelector("svg text");
      const cardRect = card?.getBoundingClientRect();
      const svgRect = card?.querySelector("svg")?.getBoundingClientRect();
      return {
        containerBg: cs(container)?.backgroundColor,
        containerColor: cs(container)?.color,
        h1Color: cs(h1)?.color,
        h1Border: cs(h1)?.borderBottomColor,
        pColor: cs(p)?.color,
        thBg: cs(th)?.backgroundColor,
        evenRowBg: cs(evenRow)?.backgroundColor,
        aColor: cs(a)?.color,
        cardBg: cs(card)?.backgroundColor,
        textFill: textProbe ? getComputedStyle(textProbe).fill : null,
        svgFits: !!(cardRect && svgRect && svgRect.width <= cardRect.width + 1 && svgRect.height <= cardRect.height + 1),
      };
    });

    check("light: white surface + gray-800 text", light.containerBg === "rgb(255, 255, 255)" && light.containerColor === "rgb(31, 41, 55)", JSON.stringify({ bg: light.containerBg, color: light.containerColor }));
    check("light: black headings", light.h1Color === "rgb(0, 0, 0)", `got ${light.h1Color}`);
    check("light: h1 gray-300 border (no dark border)", light.h1Border === "rgb(209, 213, 219)", `got ${light.h1Border}`);
    check("light: body gray-700", light.pColor === "rgb(55, 65, 81)", `got ${light.pColor}`);
    check("light: th gray-100 bg (github-dark overridden)", light.thBg === "rgb(243, 244, 246)", `got ${light.thBg}`);
    check("light: zebra gray-50 (github-dark overridden)", light.evenRowBg === "rgb(249, 250, 251)", `got ${light.evenRowBg}`);
    check("light: links emerald-600", light.aColor === "rgb(5, 150, 105)", `got ${light.aColor}`);
    check("light: diagram card gray-50", light.cardBg === "rgb(249, 250, 251)", `got ${light.cardBg}`);
    check("light: diagram text gray-800 (dark theme over)", light.textFill === "rgb(31, 41, 55)", `got ${light.textFill}`);
    check("light: svg fits card", light.svgFits, "svg overflows card");

    // Toggle back to dark; diagrams must flip back too.
    await page.click("button[aria-label='Switch preview to dark mode']");
    await page.waitForFunction(
      () =>
        document.querySelector(".preview-container")?.classList.contains("dark") &&
        getComputedStyle(document.querySelector(".preview-container svg text, .preview-container .askmymd-mermaid svg text")).fill === "rgb(226, 232, 240)",
      { timeout: 30000, polling: 300 }
    );
    check("toggle back: dark class + light diagram text again", true);

    // --- 6. Theme persists across reload ---
    await page.click("button[aria-label='Switch preview to light mode']");
    await page.waitForFunction(
      () => localStorage.getItem("askmymd.theme") === "light",
      { timeout: 10000, polling: 200 }
    );
    await page.reload({ waitUntil: "networkidle0" });
    await page.waitForSelector("textarea", { timeout: 15000 });
    const persisted = await page.evaluate(() => ({
      isLight: document.querySelector(".preview-container")?.classList.contains("light"),
      stored: localStorage.getItem("askmymd.theme"),
    }));
    check("theme survives reload (light restored)", persisted.isLight === true && persisted.stored === "light", JSON.stringify(persisted));

    // Leave dark as the stored default for the next run.
    await page.evaluate(() => {
      localStorage.setItem("askmymd.theme", "dark");
    });

    check("no page JS errors", consoleErrors.length === 0, consoleErrors.join(" | ").slice(0, 200));

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail === 0 ? 0 : 1;
  } finally {
    await browser.close();
    cleanup();
  }
}

main().catch((err) => {
  console.error("E2E error:", err);
  cleanup();
  process.exitCode = 1;
});
