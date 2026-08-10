export interface Pn532Info {
  port_name: string;
  ic: number;
  version: number;
  revision: number;
  support: number;
  friendly_name?: string;
}

export interface SerialPortSummary {
  port_name: string;
  is_usb: boolean;
  vid?: number;
  pid?: number;
  manufacturer?: string;
  product?: string;
  serial_number?: string;
  friendly_name?: string;
}

export interface CardInfo {
  uid: string;
  sens_res: string;
  sel_res: string;
  card_type: string;
  chip_model?: string;
  memory_size?: string;
}

export interface MemoryPage {
  page: number;
  hex: string;
  label?: string;
}

export interface CapabilityContainer {
  version: string;
  capacity_bytes: number;
  writable: boolean;
}

export interface NdefRecordInfo {
  index: number;
  tnf: number;
  type_name: string;
  payload_hex: string;
  payload_text?: string;
  uri?: string;
}

export interface PasswordProtection {
  enabled: boolean;
  auth0: number;
}

export interface NtagSecurityData {
  version_hex: string;
  signature_hex?: string;
  counter?: number;
  tearing_flag?: number;
}

export interface MemoryDump {
  uid: string;
  card_type: string;
  chip_model?: string;
  /** When chip_model is empty (GET_VERSION didn't identify it), this falls back to a guess
   * based on the CC's capacity byte — display-only. */
  chip_model_guess?: string;
  memory_size?: string;
  pages: MemoryPage[];
  truncated_by_nak: boolean;
  manufacturer?: string;
  capability_container?: CapabilityContainer;
  ndef_message_hex?: string;
  ndef_records: NdefRecordInfo[];
  password_protection?: PasswordProtection;
  security?: NtagSecurityData;
}

export interface ClassicBlock {
  block: number;
  hex: string;
  is_trailer: boolean;
}

export interface ClassicSectorInfo {
  sector: number;
  first_block: number;
  block_count: number;
  key?: string;
  key_type?: string;
  blocks: ClassicBlock[];
}

export interface ClassicCopyResult {
  target_uid: string;
  uid_cloned: boolean;
  sectors_written: number[];
  sectors_failed: number[];
}

export type CardFamily = "ntag" | "classic" | "unsupported";

/** SAK (SEL_RES) -> which of the two tag families this app actually implements anything for.
 * "unsupported" doesn't mean the PN532 hardware itself can't talk to the card (it may well
 * support ISO14443-4 smart cards, FeliCa, etc.) — it means this app's software hasn't
 * implemented handling for that family, whatever the reader chip is capable of. */
export function cardFamily(selRes: string): CardFamily {
  if (selRes.toUpperCase() === "00") return "ntag";
  if ((parseInt(selRes, 16) & 0x08) !== 0) return "classic";
  return "unsupported";
}

/** SAK -> sector count, kept in sync with `classic_sector_count` on the Rust side. */
export function classicSectorCount(selRes: string): number {
  switch (selRes.toUpperCase()) {
    case "09":
      return 5; // MIFARE Mini
    case "18":
      return 40; // MIFARE Classic 4K
    default:
      return 16; // MIFARE Classic 1K
  }
}

/** SAK -> total capacity in bytes (sector count * blocks per sector * 16 bytes) — a fixed
 * value, known without reading the card. */
export function classicCapacityBytes(selRes: string): number {
  switch (selRes.toUpperCase()) {
    case "09":
      return 320; // MIFARE Mini: 5 * 4 * 16
    case "18":
      return 4096; // MIFARE Classic 4K
    default:
      return 1024; // MIFARE Classic 1K
  }
}

/** The UID's first byte is the vendor code; only NXP (0x04) is confirmed so far, matching
 * `ndef::manufacturer_name` on the Rust side — anything else is left as `undefined` rather
 * than guessed. */
export function manufacturerFromUid(uid: string): string | undefined {
  return uid.slice(0, 2).toUpperCase() === "04" ? "NXP Semiconductors" : undefined;
}

/** NTAG passwords are uniformly represented as an 8-digit hex string (4 bytes), matching the
 * format `parse_password_hex` expects on the Rust side; both the read and write pages need to
 * validate this, so it's shared here. */
export function isValidPasswordHex(s: string): boolean {
  return /^[0-9a-fA-F]{8}$/.test(s.trim());
}

/** UTF-8 encodes the text, then truncates to the first 4 bytes (or zero-pads up to 4 if
 * shorter) — NTAG's write password is always exactly 4 bytes, there's no other way to fit an
 * arbitrary text password into it. Used everywhere a password field offers a "text" mode
 * alongside raw hex, so text entered on one page maps to the same bytes on any other. */
export function textToHexPassword(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const padded = new Uint8Array(4);
  padded.set(bytes.subarray(0, 4));
  return Array.from(padded)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}
