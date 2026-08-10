import { LazyStore } from "@tauri-apps/plugin-store";
import type { NdefRecordInfo } from "./pn532Types";

/** A user-saved snapshot of a card's formatted NDEF data — deliberately only this, not the rest
 * of a read (raw pages, capability container, model info, password state, ...); if that's ever
 * needed again the card can just be read fresh. */
export interface SavedCard {
  id: string;
  savedAt: number;
  uid: string;
  ndefMessageHex?: string;
  ndefRecords: NdefRecordInfo[];
}

const STORE_KEY = "cards";
const LEGACY_LOCAL_STORAGE_KEY = "pnfc-toolkit:saved-cards";

// Stored via `app_data_dir()` (keyed by the app's identifier), not the WebView's `localStorage` —
// on Windows, `localStorage` lives next to the exe, so a portable build re-extracted to a new
// folder (or a fresh NSIS install elsewhere, e.g. from the updater flow) would silently lose
// access to it.
const store = new LazyStore("saved-cards.json");

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

export async function loadSavedCards(): Promise<SavedCard[]> {
  await ensureMigrated();
  return (await store.get<SavedCard[]>(STORE_KEY)) ?? [];
}

async function writeSavedCards(cards: SavedCard[]): Promise<void> {
  await store.set(STORE_KEY, cards);
  await store.save();
}

/** Newest first — each save is a new history entry, re-saving the same card doesn't overwrite an
 * earlier snapshot of it. */
export async function saveCard(entry: Omit<SavedCard, "id" | "savedAt">): Promise<SavedCard> {
  const saved: SavedCard = { ...entry, id: crypto.randomUUID(), savedAt: Date.now() };
  await writeSavedCards([saved, ...(await loadSavedCards())]);
  return saved;
}

export async function deleteSavedCard(id: string): Promise<void> {
  await writeSavedCards((await loadSavedCards()).filter((c) => c.id !== id));
}
