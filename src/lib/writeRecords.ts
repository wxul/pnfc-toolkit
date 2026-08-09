import type { TranslationKey } from "./i18n";
import type { NdefRecordInfo } from "./pn532Types";
import { buildVCard, isVCardFilled, parseVCard, type VCardFields } from "./vcard";

export type RecordKind = "url" | "text" | "tel" | "sms" | "mailto" | "geo" | "vcard" | "wifi";

export interface RecordDraft {
  id: number;
  kind: RecordKind;
  fields: Record<string, string>;
}

export const KIND_LABEL_KEYS: Record<RecordKind, TranslationKey> = {
  url: "write.kindUrl",
  text: "write.kindText",
  tel: "write.kindTel",
  sms: "write.kindSms",
  mailto: "write.kindMailto",
  geo: "write.kindGeo",
  vcard: "write.kindVcard",
  wifi: "write.kindWifi",
};

let nextDraftId = 1;

export function newDraft(kind: RecordKind = "url", fields: Record<string, string> = {}): RecordDraft {
  return { id: nextDraftId++, kind, fields };
}

export function buildContent(kind: RecordKind, fields: Record<string, string>): string {
  switch (kind) {
    case "geo":
      return `${fields.lat ?? ""},${fields.lng ?? ""}`;
    case "vcard":
      // "raw" mode is the escape hatch for anything the structured form can't represent (e.g.
      // vCard 3.0's repeated TEL/EMAIL lines with TYPE= parameters) — the edited text is used
      // verbatim instead of being rebuilt from the individual fields.
      return fields.mode === "raw" ? (fields.raw ?? "") : buildVCard(fields as VCardFields);
    case "wifi":
      return `${fields.ssid ?? ""}\n${fields.password ?? ""}`;
    default:
      return fields.value ?? "";
  }
}

export function isDraftFilled(kind: RecordKind, fields: Record<string, string>): boolean {
  switch (kind) {
    case "geo":
      return !!fields.lat?.trim() && !!fields.lng?.trim();
    case "vcard":
      return fields.mode === "raw" ? !!fields.raw?.trim() : isVCardFilled(fields as VCardFields);
    case "wifi":
      return !!fields.ssid?.trim();
    default:
      return !!fields.value?.trim();
  }
}

function hexToBytes(hex: string): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
}

/** A Text record's payload is [language-code length byte][language code][actual text] (see
 * `text_record` in ndef.rs) — `payload_text` on the parsed record is the *whole* payload decoded
 * as UTF-8, language-code prefix and all, so it can't be used as-is here. */
function decodeTextRecordPayload(payloadHex: string): string {
  const bytes = hexToBytes(payloadHex);
  const langLen = bytes[0] ?? 0;
  return new TextDecoder().decode(new Uint8Array(bytes.slice(1 + langLen)));
}

/** Reverses `wifi_record` in ndef.rs: a WSC Credential TLV (attr 0x100E) wrapping AuthType/
 * EncType/SSID(0x1045)/NetworkKey(0x1027) sub-TLVs, each `[attr:u16 BE][len:u16 BE][value]`.
 * AuthType/EncType are ignored on the way back in — the write side always forces WPA2-PSK/AES,
 * and the editor only has SSID/password fields to put them into anyway. */
function decodeWifiRecordPayload(payloadHex: string): { ssid: string; password: string } | null {
  const bytes = hexToBytes(payloadHex);
  if (bytes.length < 4) return null;
  const credentialLen = (bytes[2] << 8) | bytes[3];
  const credential = bytes.slice(4, 4 + credentialLen);

  let ssid: string | null = null;
  let password = "";
  let i = 0;
  while (i + 4 <= credential.length) {
    const attr = (credential[i] << 8) | credential[i + 1];
    const len = (credential[i + 2] << 8) | credential[i + 3];
    const value = credential.slice(i + 4, i + 4 + len);
    if (attr === 0x1045) ssid = new TextDecoder().decode(new Uint8Array(value));
    if (attr === 0x1027) password = new TextDecoder().decode(new Uint8Array(value));
    i += 4 + len;
  }
  return ssid == null ? null : { ssid, password };
}

/** Turns one already-parsed NDEF record back into an editable draft — the inverse of
 * `buildContent`/`record_for` (ndef.rs), used when loading a saved read into the write page.
 * Record kinds this app doesn't specifically recognize (some other app's NDEF record, or a type
 * this app has no editor for) fall back to a "text" draft carrying whatever readable content
 * could be recovered, rather than being silently dropped. */
function recordToDraft(r: NdefRecordInfo): RecordDraft {
  if (r.uri != null) {
    if (r.uri.startsWith("tel:")) return newDraft("tel", { value: r.uri.slice(4) });
    if (r.uri.startsWith("sms:")) return newDraft("sms", { value: r.uri.slice(4) });
    if (r.uri.startsWith("mailto:")) return newDraft("mailto", { value: r.uri.slice(7) });
    if (r.uri.startsWith("geo:")) {
      const [lat, lng] = r.uri.slice(4).split(",");
      return newDraft("geo", { lat: lat ?? "", lng: lng ?? "" });
    }
    return newDraft("url", { value: r.uri });
  }

  if (r.tnf === 0x02 && r.type_name === "text/vcard") {
    const text = r.payload_text ?? new TextDecoder().decode(new Uint8Array(hexToBytes(r.payload_hex)));
    // Defaults to raw-text mode: the structured form only covers one each of phone/email/etc.,
    // so a vCard with anything beyond that (repeated TEL/EMAIL, TYPE= parameters, properties
    // this app has no field for) would silently lose data if parsed into the structured fields
    // and never touched again. Raw mode instead round-trips the original text byte-for-byte;
    // the structured fields are still populated underneath (best-effort, via `parseVCard`) in
    // case the user switches to the form view.
    return newDraft("vcard", { ...(parseVCard(text) as Record<string, string>), raw: text, mode: "raw" });
  }

  if (r.tnf === 0x02 && r.type_name === "application/vnd.wfa.wsc") {
    const wifi = decodeWifiRecordPayload(r.payload_hex);
    if (wifi) return newDraft("wifi", wifi);
  }

  if (r.tnf === 0x01 && r.type_name === "T") {
    return newDraft("text", { value: decodeTextRecordPayload(r.payload_hex) });
  }

  // Unrecognized record type — keep whatever text is readable instead of dropping it.
  return newDraft("text", { value: r.payload_text ?? `[hex] ${r.payload_hex}` });
}

export function recordsToDrafts(records: NdefRecordInfo[]): RecordDraft[] {
  const drafts = records.map(recordToDraft);
  return drafts.length > 0 ? drafts : [newDraft()];
}
