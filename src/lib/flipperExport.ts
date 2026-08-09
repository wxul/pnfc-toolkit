import { save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import type { MemoryDump } from "./pn532Types";

/** Chip models this app can identify, mapped to the exact "NTAG/Ultralight type" string
 * Flipper Zero's own firmware writes for each — confirmed against
 * `lib/nfc/protocols/mf_ultralight/mf_ultralight.c`'s `mf_ultralight_features` table, not
 * guessed. Anything not in this table (including a chip GET_VERSION couldn't identify at all)
 * can't be exported in this format. */
function flipperUltralightType(chipModel: string): string | null {
  if (chipModel === "NTAG213") return "NTAG213";
  if (chipModel === "NTAG215") return "NTAG215";
  if (chipModel === "NTAG216") return "NTAG216";
  if (chipModel.includes("MF0UL11")) return "Mifare Ultralight 11";
  if (chipModel.includes("MF0UL21")) return "Mifare Ultralight 21";
  return null;
}

function spacedHex(hex: string): string {
  return (hex.match(/.{1,2}/g) ?? []).join(" ").toUpperCase();
}

/** Whether this dump has everything Flipper Zero's own `.nfc` loader hard-requires to be
 * *present* in the file: a recognized chip type, a complete page read (no failed/skipped
 * pages), and a signature. Counter/tearing are NOT required here even though the file format
 * needs those lines present too — `buildFlipperNfc` fills them with the same "0"/default value
 * Flipper's own firmware saves when its live counter/tearing read fails (which happens for real
 * on cards whose chip type is nominally counter-capable but whose actual silicon isn't — see the
 * poller behavior this mirrors: a failed counter/tearing read doesn't abort Flipper's own scan,
 * only a failed *signature* read does). */
export function canExportAsFlipperNfc(dump: MemoryDump): boolean {
  return (
    dump.chip_model != null &&
    flipperUltralightType(dump.chip_model) != null &&
    dump.security?.signature_hex != null &&
    dump.pages.length > 0 &&
    dump.pages.every((p) => p.hex !== "????????")
  );
}

/** Builds a Flipper Zero–compatible `.nfc` save file. Field names/order/requiredness were
 * confirmed against Flipper's own firmware source (`lib/nfc/protocols/{iso14443_3a,
 * mf_ultralight}/*.c`) rather than guessed — its loader hard-fails the whole load if Signature/
 * Mifare version/Counter/Tearing are absent, so this only produces a file when
 * `canExportAsFlipperNfc` is true. Counter/tearing indices 0 and 1 are always written as 0 (not
 * attempted) because NTAG21x/Ultralight EV1 only implement a single counter, at index 2; index 2
 * itself falls back to the same "0"/"00" default when this chip didn't actually support
 * READ_CNT/CHECK_TEARING_EVENT (see `canExportAsFlipperNfc`'s doc comment for why that's not
 * required for export — it matches Flipper's own save behavior for such a card, not a shortcut).
 */
export function buildFlipperNfc(
  uid: string,
  sensRes: string,
  selRes: string,
  dump: MemoryDump,
): string {
  const chipModel = dump.chip_model!;
  const ultralightType = flipperUltralightType(chipModel)!;
  const security = dump.security!;
  const counter = security.counter ?? 0;
  const tearingFlag = (security.tearing_flag ?? 0).toString(16).toUpperCase().padStart(2, "0");

  // Flipper stores ATQA byte-swapped from our display order for its own display convention.
  const atqaBytes = sensRes.match(/.{1,2}/g) ?? [];
  const atqaSwapped = atqaBytes.length === 2 ? [atqaBytes[1], atqaBytes[0]].join("") : sensRes;

  const lines = [
    "Filetype: Flipper NFC device",
    "Version: 4",
    "Device type: NTAG/Ultralight",
    `UID: ${spacedHex(uid)}`,
    `ATQA: ${spacedHex(atqaSwapped)}`,
    `SAK: ${spacedHex(selRes)}`,
    "Data format version: 2",
    `NTAG/Ultralight type: ${ultralightType}`,
    `Signature: ${spacedHex(security.signature_hex!)}`,
    `Mifare version: ${spacedHex(security.version_hex)}`,
    "Counter 0: 0",
    "Tearing 0: 00",
    "Counter 1: 0",
    "Tearing 1: 00",
    `Counter 2: ${counter}`,
    `Tearing 2: ${tearingFlag}`,
    `Pages total: ${dump.pages.length}`,
    `Pages read: ${dump.pages.length}`,
    ...dump.pages.map((p) => `Page ${p.page}: ${spacedHex(p.hex)}`),
    "Failed authentication attempts: 0",
  ];

  return lines.join("\n") + "\n";
}

/** Opens a native "Save As" dialog defaulted to a .nfc file, then writes the Flipper-format
 * dump to whatever path was picked. Returns `false` without writing anything if the user cancels
 * the dialog, or if `canExportAsFlipperNfc(dump)` is false (checked by the caller). */
export async function exportAsFlipperNfc(
  uid: string,
  sensRes: string,
  selRes: string,
  dump: MemoryDump,
): Promise<boolean> {
  const path = await save({
    defaultPath: `pnfc-toolkit_${uid}.nfc`,
    filters: [{ name: "Flipper NFC device", extensions: ["nfc"] }],
  });
  if (!path) return false;
  await invoke("write_text_file", { path, content: buildFlipperNfc(uid, sensRes, selRes, dump) });
  return true;
}
