import { save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import type { MemoryDump, NdefRecordInfo } from "./pn532Types";

/** The subset of a card's data that's actually meaningful in a plain-text export — shared
 * between the live read page (which also has ATQA/SAK/model) and the saved-data list (which
 * only kept the NDEF snapshot, see `SavedCard`). */
export interface ExportableCard {
  uid: string;
  cardType?: string;
  sensRes?: string;
  selRes?: string;
  ndefMessageHex?: string;
  ndefRecords: NdefRecordInfo[];
}

function recordToLines(r: NdefRecordInfo): string[] {
  const lines = [`Record ${r.index}:`, `  TNF: ${r.tnf}`, `  Type: "${r.type_name}"`];
  if (r.uri) lines.push(`  URI: ${r.uri}`);
  lines.push(`  Payload (hex): ${r.payload_hex}`);
  if (r.payload_text) lines.push(`  Payload (text): ${r.payload_text}`);
  return lines;
}

export function cardToText(card: ExportableCard): string {
  const lines = [`UID: ${card.uid}`];
  if (card.cardType) lines.push(`Card type: ${card.cardType}`);
  if (card.sensRes) lines.push(`ATQA: 0x${card.sensRes}`);
  if (card.selRes) lines.push(`SAK: 0x${card.selRes}`);
  lines.push("");

  if (card.ndefRecords.length === 0) {
    lines.push("No NDEF records.");
  } else {
    for (const r of card.ndefRecords) {
      lines.push(...recordToLines(r), "");
    }
  }

  if (card.ndefMessageHex) {
    lines.push(`NDEF message (hex): ${card.ndefMessageHex}`);
  }

  return lines.join("\n");
}

/** Opens a native "Save As" dialog defaulted to a .txt file, then writes the card's formatted
 * NDEF data to whatever path was picked. Returns `false` without writing anything if the user
 * cancels the dialog. */
export async function exportCardAsText(card: ExportableCard): Promise<boolean> {
  const path = await save({
    defaultPath: `pnfc-toolkit_${card.uid}.txt`,
    filters: [{ name: "Text", extensions: ["txt"] }],
  });
  if (!path) return false;
  await invoke("write_text_file", { path, content: cardToText(card) });
  return true;
}

/** Opens a native "Save As" dialog defaulted to a .bin file, then writes the tag's complete raw
 * memory (every page, in order, exactly as read — including pages that failed to read, filled
 * with zeros so byte offsets still line up) to whatever path was picked. This is the "just the
 * bytes, no metadata" format used by tools like libnfc/mfoc's raw MIFARE dumps — usable for
 * flashing back onto a same-model blank tag with a different tool, not just for this app. Returns
 * `false` without writing anything if the user cancels the dialog, or if `dump.pages` is empty
 * (nothing to export — Classic cards don't have a page dump). */
export async function exportCardAsRawBinary(uid: string, dump: MemoryDump): Promise<boolean> {
  if (dump.pages.length === 0) return false;
  const path = await save({
    defaultPath: `pnfc-toolkit_${uid}.bin`,
    filters: [{ name: "Raw memory dump", extensions: ["bin"] }],
  });
  if (!path) return false;
  const bytes: number[] = [];
  for (const p of dump.pages) {
    const hex = p.hex === "????????" ? "00000000" : p.hex;
    for (let i = 0; i < hex.length; i += 2) {
      bytes.push(parseInt(hex.slice(i, i + 2), 16));
    }
  }
  await invoke("write_binary_file", { path, content: bytes });
  return true;
}
