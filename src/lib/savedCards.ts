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

const STORAGE_KEY = "pnfc-toolkit:saved-cards";

export function loadSavedCards(): SavedCard[] {
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

function writeSavedCards(cards: SavedCard[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cards));
}

/** Newest first — each save is a new history entry, re-saving the same card doesn't overwrite an
 * earlier snapshot of it. */
export function saveCard(entry: Omit<SavedCard, "id" | "savedAt">): SavedCard {
  const saved: SavedCard = { ...entry, id: crypto.randomUUID(), savedAt: Date.now() };
  writeSavedCards([saved, ...loadSavedCards()]);
  return saved;
}

export function deleteSavedCard(id: string): void {
  writeSavedCards(loadSavedCards().filter((c) => c.id !== id));
}
