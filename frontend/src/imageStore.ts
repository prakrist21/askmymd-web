/**
 * In-memory image store for local uploads.
 * Keeps markdown small (short placeholder) while preview resolves to base64.
 * Persisted separately from markdown so main document stays fast to edit.
 */

const IMAGE_STORE_KEY = "askmymd.images";

type ImageMap = Record<string, string>;

let store: ImageMap = {};

// Load from localStorage on module init (best-effort)
try {
  const raw = localStorage.getItem(IMAGE_STORE_KEY);
  if (raw) {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      store = parsed as ImageMap;
    }
  }
} catch {
  // ignore corrupt
}

function persist() {
  try {
    localStorage.setItem(IMAGE_STORE_KEY, JSON.stringify(store));
  } catch {
    // quota exceeded — best-effort, let caller handle warning
  }
}

export function generateImageId(): string {
  // short unique id, e.g. img-a1b2c3
  return `img-${Math.random().toString(36).slice(2, 8)}${Math.random().toString(36).slice(2, 4)}`;
}

export function setImage(id: string, dataUrl: string) {
  store[id] = dataUrl;
  persist();
}

export function getImage(id: string): string | undefined {
  return store[id];
}

export function hasImage(id: string): boolean {
  return id in store;
}

export function getImageStore(): ImageMap {
  return store;
}

export function clearImageStore() {
  store = {};
  try {
    localStorage.removeItem(IMAGE_STORE_KEY);
  } catch {}
}

export function loadImageStore(): ImageMap {
  try {
    const raw = localStorage.getItem(IMAGE_STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        store = parsed as ImageMap;
        return store;
      }
    }
  } catch {}
  return store;
}

// For testing / manual
export const _IMAGE_STORE_KEY = IMAGE_STORE_KEY;
