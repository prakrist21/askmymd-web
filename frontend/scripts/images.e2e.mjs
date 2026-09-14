/**
 * Image upload e2e (headless Chrome): pick file → upload to Postgres →
 * markdown insert at cursor → preview renders via GET endpoint.
 * Requires backend on :8000 and Vite on :5173.
 */
import puppeteer from "puppeteer-core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const BASE = process.env.BASE_URL || "http://localhost:5173";

/** CRC32 for PNG chunks (portable; Node's zlib.crc32 is 22+ only). */
function crc32(buf) {
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Generate a tiny valid 3x2 green PNG so the script needs no binary fixtures. */
function makeTestPng(dir) {
  const path = join(dir, "e2e_test_image.png");
  const chunk = (typ, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(typ), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(3, 0); // width
  ihdr.writeUInt32BE(2, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  const raw = Buffer.concat([
    Buffer.from([0, 0, 255, 0, 0, 0, 255, 0, 0, 255]), // 2 rows of green-ish pixels
  ]);
  const idat = deflateSync(raw);
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  writeFileSync(path, png);
  return path;
}

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

const userDataDir = mkdtempSync(join(tmpdir(), "askmymd-img-e2e-"));
function cleanup() {
  try { rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3 }); } catch {}
}

async function main() {
  const browser = await puppeteer.launch({
    headless: true,
    channel: "chrome",
    userDataDir,
    args: ["--no-sandbox", "--disable-gpu"],
  });
  try {
    const PNG_PATH = makeTestPng(userDataDir);
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    const consoleErrors = [];
    page.on("pageerror", (e) => consoleErrors.push(String(e)));
    await page.goto(BASE, { waitUntil: "networkidle0", timeout: 30000 });
    await page.waitForSelector("textarea", { timeout: 15000 });

    // Fresh identity so we exercise the "no document yet → createDocument first" path.
    await page.evaluate(() => {
      localStorage.removeItem("askmymd.document_id");
      localStorage.setItem("askmymd.markdown_content", "");
      localStorage.setItem("askmymd.prepared", "false");
    });
    await page.reload({ waitUntil: "networkidle0" });
    await page.waitForSelector("textarea", { timeout: 15000 });

    // Seed some text and put the caret at the end.
    await page.type("textarea", "# Image e2e\n\nHello below:");
    await page.evaluate(() => {
      const ta = document.querySelector("textarea");
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    });

    // Open the image modal via the toolbar Image button.
    await page.click('button[aria-label="Image"]');
    await page.waitForSelector('text/Insert image', { timeout: 5000 }).catch(() => {});
    await page.waitForFunction(
      () => document.body.textContent.includes("Upload from device"),
      { timeout: 5000 }
    );
    check("toolbar Image button opens modal (no more 'coming soon')", true);

    // Choice screen → go to the upload branch (where the file input lives).
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll("button")];
      const upload = btns.find((b) => b.textContent.includes("Upload from device"));
      if (upload) upload.click();
    });
    await page.waitForFunction(
      () => !!document.querySelector('input[type="file"][accept="image/*"]'),
      { timeout: 5000 }
    );

    // Upload through the real <input type=file>.
    const fileInput = await page.$('input[type="file"][accept="image/*"]');
    check("file input present in modal", !!fileInput);
    await fileInput.uploadFile(PNG_PATH);
    await page.waitForFunction(
      () => document.querySelectorAll('img[alt="preview"]').length === 1,
      { timeout: 5000 }
    );
    check("chosen image previewed in modal", true);

    // Alt text defaults from the filename; set it explicitly anyway.
    await page.evaluate(() => {
      const inputs = [...document.querySelectorAll(".fixed input")];
      const alt = inputs.find((i) => i.value === "e2e_test_image" || i.value === "alt text" || i.placeholder === "Alt text");
      if (alt) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        setter.call(alt, "e2e image");
        alt.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });

    // Click Insert → uploads to Postgres → inserts markdown reference.
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll("button")];
      const insert = btns.find((b) => b.textContent.trim() === "Insert" && !b.disabled);
      if (insert) insert.click();
    });

    // Wait until the markdown contains the reference and the modal closed.
    await page.waitForFunction(
      () => {
        const ta = document.querySelector("textarea");
        return ta && /!\[[^\]]*\]\(\/documents\/[^/]+\/images\/[a-f0-9]+\)/.test(ta.value);
      },
      { timeout: 20000, polling: 300 }
    );
    const markdown = await page.evaluate(() => document.querySelector("textarea").value);
    const refMatch = markdown.match(/!\[[^\]]*\]\((\/documents\/[^/]+\/images\/[a-f0-9]+)\)/);
    check("short markdown reference inserted at cursor", !!refMatch, markdown.slice(-120));
    check("reference is short (no base64 in markdown)", markdown.length < 300, `len=${markdown.length}`);

    // Wait for the preview <img> to appear and actually load (naturalWidth > 0).
    await page.waitForFunction(
      () => {
        const img = document.querySelector('.preview-container img[src*="/images/"]');
        return img && img.complete && img.naturalWidth > 0;
      },
      { timeout: 20000, polling: 300 }
    );
    const imgInfo = await page.evaluate(() => {
      const img = document.querySelector('.preview-container img[src*="/images/"]');
      return {
        src: img.getAttribute("src"),
        w: img.naturalWidth,
        h: img.naturalHeight,
        isAbsolute: img.src.startsWith("http://localhost:8000/"),
      };
    });
    check("preview renders the image (naturalWidth > 0)", imgInfo.w > 0, JSON.stringify(imgInfo));
    check("relative src resolved against backend base URL", imgInfo.isAbsolute, imgInfo.src);
    check("no amber ImageOff placeholder for the valid image",
      await page.evaluate(() => !document.querySelector('.preview-container span')?.textContent.includes("Image not found")), "");

    // Broken-reference case: point markdown at a nonexistent image id → 404 → placeholder.
    const brokenMd = markdown.replace(/images\/[a-f0-9]+/, "images/deadbeef0000");
    await page.evaluate((md) => {
      const ta = document.querySelector("textarea");
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
      setter.call(ta, md);
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    }, brokenMd);
    await page.waitForFunction(
      () => document.body.textContent.includes("Image not found"),
      { timeout: 15000, polling: 300 }
    );
    check("404 image gets the amber ImageOff placeholder", true);

    // Restore the good markdown → placeholder disappears, image returns.
    await page.evaluate((md) => {
      const ta = document.querySelector("textarea");
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
      setter.call(ta, md);
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    }, markdown);
    await page.waitForFunction(
      () => {
        const img = document.querySelector('.preview-container img[src*="/images/"]');
        const gone = !document.body.textContent.includes("Image not found");
        return gone && img && img.complete && img.naturalWidth > 0;
      },
      { timeout: 15000, polling: 300 }
    );
    check("restoring valid reference removes placeholder and re-renders image", true);
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
