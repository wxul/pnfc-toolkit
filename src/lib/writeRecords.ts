import type { TranslationKey } from "./i18n";
import type { NdefRecordInfo } from "./pn532Types";
import { DEFAULT_SOCIAL_PLATFORM, matchSocialUrl, socialPlatform } from "./socialPlatforms";
import { buildVCard, isVCardFilled, parseVCard, type VCardFields } from "./vcard";

export type RecordKind =
  | "url"
  | "text"
  | "tel"
  | "sms"
  | "mailto"
  | "geo"
  | "vcard"
  | "wifi"
  | "social"
  | "raw";

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
  social: "write.kindSocial",
  raw: "write.kindRaw",
};

/** The "social" kind is only a frontend affordance (a platform picker on top of a plain URL) —
 * the backend has no concept of it, so records get sent as one of the kinds it does know about,
 * based on the *content* `buildContent` produced for it: most platforms always build a real
 * `https://...` URL, sent as an ordinary "url" kind. WeChat is the exception — it has no public
 * username → profile URL mapping (see the comment on `wechat` in socialPlatforms.ts), so typing
 * a bare WeChat ID produces schemeless plain text instead of a link. Written as a "url" kind
 * anyway, that text would go into a URI record most phones can't do anything with on tap and
 * arguably shouldn't have looked like a link record in the first place; sent as "text" instead,
 * it's an ordinary NDEF Text record that phones do show tap → so the ID is at least readable. */
export function backendKind(kind: RecordKind, content: string): string {
  if (kind !== "social") return kind;
  return /^[a-z][a-z0-9+.-]*:/i.test(content) ? "url" : "text";
}

let nextDraftId = 1;

export function newDraft(kind: RecordKind = "url", fields: Record<string, string> = {}): RecordDraft {
  return { id: nextDraftId++, kind, fields };
}

export function buildContent(kind: RecordKind, fields: Record<string, string>): string {
  switch (kind) {
    case "geo":
      return `${fields.lat ?? ""},${fields.lng ?? ""}`;
    case "sms": {
      const to = fields.to ?? "";
      const body = fields.body?.trim();
      return body ? `${to}?body=${encodeURIComponent(body)}` : to;
    }
    case "mailto": {
      const to = fields.to ?? "";
      const params: string[] = [];
      if (fields.subject?.trim()) params.push(`subject=${encodeURIComponent(fields.subject.trim())}`);
      if (fields.body?.trim()) params.push(`body=${encodeURIComponent(fields.body.trim())}`);
      return params.length > 0 ? `${to}?${params.join("&")}` : to;
    }
    case "vcard":
      // "raw" mode is the escape hatch for anything the structured form can't represent (e.g.
      // vCard 3.0's repeated TEL/EMAIL lines with TYPE= parameters) — the edited text is used
      // verbatim instead of being rebuilt from the individual fields.
      return fields.mode === "raw" ? (fields.raw ?? "") : buildVCard(fields as VCardFields);
    case "wifi": {
      const security = fields.security ?? "wpa2";
      const password = security === "open" ? "" : (fields.password ?? "");
      return `${fields.ssid ?? ""}\n${password}\n${security}`;
    }
    case "social":
      return socialPlatform(fields.platform ?? DEFAULT_SOCIAL_PLATFORM).buildUrl(fields.handle ?? "");
    case "raw": {
      const tnf = fields.tnf ?? "1";
      const type = fields.type ?? "";
      const payloadHex =
        fields.payloadMode === "hex"
          ? (fields.payloadHex ?? "").trim().toUpperCase()
          : textToHex(fields.payloadText ?? "");
      return `${tnf}\n${type}\n${payloadHex}`;
    }
    default:
      return fields.value ?? "";
  }
}

export function isDraftFilled(kind: RecordKind, fields: Record<string, string>): boolean {
  switch (kind) {
    case "geo":
      return !!fields.lat?.trim() && !!fields.lng?.trim();
    case "sms":
    case "mailto":
      return !!fields.to?.trim();
    case "vcard":
      return fields.mode === "raw" ? !!fields.raw?.trim() : isVCardFilled(fields as VCardFields);
    case "wifi":
      return (
        !!fields.ssid?.trim() && (fields.security === "open" || !!fields.password?.trim())
      );
    case "social":
      return !!fields.handle?.trim();
    case "raw":
      return fields.payloadMode === "hex"
        ? isValidHex(fields.payloadHex ?? "")
        : !!fields.payloadText?.trim();
    default:
      return !!fields.value?.trim();
  }
}

function hexToBytes(hex: string): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
}

/** UTF-8 encodes the text with no truncation/padding (unlike `textToHexPassword`, which is
 * pinned to NTAG's fixed 4-byte password field) — used by the raw-record editor's text/hex
 * payload toggle, where the payload can be any length. */
function textToHex(text: string): string {
  return Array.from(new TextEncoder().encode(text))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

/** A non-empty, even-length run of hex digits — validates the raw-record editor's hex-mode
 * payload input before it's sent to the backend (which would otherwise reject it with a less
 * actionable "Invalid payload hex" error at write time). */
export function isValidHex(s: string): boolean {
  const trimmed = s.trim();
  return trimmed !== "" && /^([0-9a-fA-F]{2})*$/.test(trimmed);
}

/** A Text record's payload is [language-code length byte][language code][actual text] (see
 * `text_record` in ndef.rs) — `payload_text` on the parsed record is the *whole* payload decoded
 * as UTF-8, language-code prefix and all, so it can't be used as-is here. */
function decodeTextRecordPayload(payloadHex: string): string {
  const bytes = hexToBytes(payloadHex);
  const langLen = bytes[0] ?? 0;
  return new TextDecoder().decode(new Uint8Array(bytes.slice(1 + langLen)));
}

/** Maps a WPS AuthType flag value back to one of the security modes the write UI offers — the
 * inverse of `wps_security_flags` in ndef.rs. Anything not among those four exact values (e.g.
 * WPA/WPA2 mixed-mode flags, enterprise auth) falls back to "wpa2" rather than guessing. */
function securityFromAuthType(authType: number | null): string {
  switch (authType) {
    case 0x0001:
      return "open";
    case 0x0004:
      return "wep";
    case 0x0002:
      return "wpa";
    default:
      return "wpa2";
  }
}

/** Reverses `wifi_record` in ndef.rs: a WSC Credential TLV (attr 0x100E) wrapping AuthType/
 * EncType/SSID(0x1045)/NetworkKey(0x1027) sub-TLVs, each `[attr:u16 BE][len:u16 BE][value]`. */
function decodeWifiRecordPayload(
  payloadHex: string,
): { ssid: string; password: string; security: string } | null {
  const bytes = hexToBytes(payloadHex);
  if (bytes.length < 4) return null;
  const credentialLen = (bytes[2] << 8) | bytes[3];
  const credential = bytes.slice(4, 4 + credentialLen);

  let ssid: string | null = null;
  let password = "";
  let authType: number | null = null;
  let i = 0;
  while (i + 4 <= credential.length) {
    const attr = (credential[i] << 8) | credential[i + 1];
    const len = (credential[i + 2] << 8) | credential[i + 3];
    const value = credential.slice(i + 4, i + 4 + len);
    if (attr === 0x1045) ssid = new TextDecoder().decode(new Uint8Array(value));
    if (attr === 0x1027) password = new TextDecoder().decode(new Uint8Array(value));
    if (attr === 0x1003 && len >= 2) authType = (value[0] << 8) | value[1];
    i += 4 + len;
  }
  return ssid == null ? null : { ssid, password, security: securityFromAuthType(authType) };
}

/** Turns one already-parsed NDEF record back into an editable draft — the inverse of
 * `buildContent`/`record_for` (ndef.rs), used when loading a saved read into the write page.
 * Record kinds this app doesn't specifically recognize (some other app's NDEF record, or a type
 * this app has no editor for) fall back to a "raw" draft carrying the exact TNF/type/payload,
 * rather than being silently dropped or lossily flattened into decoded text. */
function recordToDraft(r: NdefRecordInfo): RecordDraft {
  if (r.uri != null) {
    if (r.uri.startsWith("tel:")) return newDraft("tel", { value: r.uri.slice(4) });
    if (r.uri.startsWith("sms:")) {
      const rest = r.uri.slice(4);
      const qIndex = rest.indexOf("?");
      if (qIndex === -1) return newDraft("sms", { to: rest });
      const body = new URLSearchParams(rest.slice(qIndex + 1)).get("body") ?? "";
      return newDraft("sms", { to: rest.slice(0, qIndex), body });
    }
    if (r.uri.startsWith("mailto:")) {
      const rest = r.uri.slice(7);
      const qIndex = rest.indexOf("?");
      if (qIndex === -1) return newDraft("mailto", { to: rest });
      const params = new URLSearchParams(rest.slice(qIndex + 1));
      return newDraft("mailto", {
        to: rest.slice(0, qIndex),
        subject: params.get("subject") ?? "",
        body: params.get("body") ?? "",
      });
    }
    if (r.uri.startsWith("geo:")) {
      const [lat, lng] = r.uri.slice(4).split(",");
      return newDraft("geo", { lat: lat ?? "", lng: lng ?? "" });
    }
    const social = matchSocialUrl(r.uri);
    if (social) return newDraft("social", social);
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

  // Unrecognized record type — preserve it exactly instead of dropping it or lossily decoding
  // it into text (which would go back out with a totally different TNF/type on next write).
  return newDraft("raw", {
    tnf: String(r.tnf),
    type: r.type_name,
    payloadMode: "hex",
    payloadHex: r.payload_hex,
  });
}

export function recordsToDrafts(records: NdefRecordInfo[]): RecordDraft[] {
  const drafts = records.map(recordToDraft);
  return drafts.length > 0 ? drafts : [newDraft()];
}
