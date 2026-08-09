import type { MemoryDump } from "./pn532Types";

/** A user-saved snapshot of a full NTAG/Ultralight read — unlike `SavedCard` (which only keeps
 * the formatted NDEF data), this keeps the complete `MemoryDump` (every page, plus the
 * signature/counter/tearing data from `dump.security`), which is what lets a saved entry be
 * re-exported later as a Flipper `.nfc` file or a raw `.bin` dump, not just as text. Classic
 * cards aren't supported here — this app doesn't have a structured full-page dump for them (see
 * `ReadCardPage`, which only offers "Save tag" on the NTAG/Ultralight branch). */
export interface SavedTag {
  id: string;
  savedAt: number;
  uid: string;
  sensRes: string;
  selRes: string;
  dump: MemoryDump;
}

const STORAGE_KEY = "pnfc-toolkit:saved-tags";

export function loadSavedTags(): SavedTag[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeSavedTags(tags: SavedTag[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tags));
}

/** Newest first — each save is a new history entry, re-saving the same tag doesn't overwrite an
 * earlier snapshot of it. */
export function saveTag(entry: Omit<SavedTag, "id" | "savedAt">): SavedTag {
  const saved: SavedTag = { ...entry, id: crypto.randomUUID(), savedAt: Date.now() };
  writeSavedTags([saved, ...loadSavedTags()]);
  return saved;
}

export function deleteSavedTag(id: string): void {
  writeSavedTags(loadSavedTags().filter((t) => t.id !== id));
}
