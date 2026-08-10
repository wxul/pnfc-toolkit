import { LazyStore } from "@tauri-apps/plugin-store";
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

const STORE_KEY = "tags";
const LEGACY_LOCAL_STORAGE_KEY = "pnfc-toolkit:saved-tags";

// See `savedCards.ts` for why this is `app_data_dir()`-backed plugin-store rather than
// `localStorage`.
const store = new LazyStore("saved-tags.json");

let migrated: Promise<void> | null = null;

/** One-time move of data saved by older versions (pre-plugin-store) out of `localStorage` and
 * into the store file, so upgrading doesn't make existing saves disappear. */
function ensureMigrated(): Promise<void> {
  if (!migrated) {
    migrated = (async () => {
      if (await store.has(STORE_KEY)) return;
      if (typeof localStorage === "undefined") return;
      const raw = localStorage.getItem(LEGACY_LOCAL_STORAGE_KEY);
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          await store.set(STORE_KEY, parsed);
          await store.save();
        }
      } catch {
        // Unparseable legacy data isn't worth failing startup over — just leave the store empty.
      }
      localStorage.removeItem(LEGACY_LOCAL_STORAGE_KEY);
    })();
  }
  return migrated;
}

export async function loadSavedTags(): Promise<SavedTag[]> {
  await ensureMigrated();
  return (await store.get<SavedTag[]>(STORE_KEY)) ?? [];
}

async function writeSavedTags(tags: SavedTag[]): Promise<void> {
  await store.set(STORE_KEY, tags);
  await store.save();
}

/** Newest first — each save is a new history entry, re-saving the same tag doesn't overwrite an
 * earlier snapshot of it. */
export async function saveTag(entry: Omit<SavedTag, "id" | "savedAt">): Promise<SavedTag> {
  const saved: SavedTag = { ...entry, id: crypto.randomUUID(), savedAt: Date.now() };
  await writeSavedTags([saved, ...(await loadSavedTags())]);
  return saved;
}

export async function deleteSavedTag(id: string): Promise<void> {
  await writeSavedTags((await loadSavedTags()).filter((t) => t.id !== id));
}
