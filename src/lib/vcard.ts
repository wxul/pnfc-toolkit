export interface VCardFields {
  familyName?: string;
  givenName?: string;
  nickname?: string;
  org?: string;
  title?: string;
  role?: string;
  phone?: string;
  email?: string;
  url?: string;
  adrStreet?: string;
  adrCity?: string;
  adrState?: string;
  adrPostalCode?: string;
  adrCountry?: string;
  label?: string;
  note?: string;
  photo?: string;
  logo?: string;
  bday?: string;
  anniversary?: string;
  categories?: string;
}

// ANNIVERSARY is a vCard 4.0 (RFC 6350) property that doesn't exist in 3.0 (RFC 2426), so this
// is pinned to 4.0 — mainstream phone contacts apps all handle 4.0 fine these days.
const VCARD_VERSION = "4.0";

function escapeVCardValue(v: string): string {
  return v
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

function formatRev(date: Date): string {
  // vCard REV requires the compact YYYYMMDDTHHMMSSZ format, without - or : separators.
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function unescapeVCardValue(v: string): string {
  return v.replace(/\\n/g, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}

/** Splits a vCard structured value (like N or ADR) on unescaped ";" — a plain `.split(";")`
 * would also break on an intentionally-escaped "\;" inside a field. */
function splitVCardStructured(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "\\" && i + 1 < value.length) {
      current += value[i] + value[i + 1];
      i++;
    } else if (value[i] === ";") {
      parts.push(current);
      current = "";
    } else {
      current += value[i];
    }
  }
  parts.push(current);
  return parts;
}

/** The inverse of `buildVCard`, for loading a previously-read vCard back into editable fields
 * (see "write from saved data"). Best-effort, not a full RFC 6350 parser — handles exactly the
 * property set `buildVCard` emits, plus tolerates a `;PARAM=...` suffix on the property name
 * (e.g. `TEL;TYPE=CELL:`) by just ignoring the parameters. A vCard from some other app that uses
 * properties this doesn't recognize just has those fields come back empty rather than erroring
 * out — there's always the raw record view to fall back on. */
export function parseVCard(text: string): VCardFields {
  const fields: VCardFields = {};
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const sep = rawLine.indexOf(":");
    if (sep === -1) continue;
    const key = rawLine.slice(0, sep).split(";")[0].trim().toUpperCase();
    const value = rawLine.slice(sep + 1);

    switch (key) {
      case "N": {
        const [family, given] = splitVCardStructured(value).map(unescapeVCardValue);
        if (family) fields.familyName = family;
        if (given) fields.givenName = given;
        break;
      }
      case "ADR": {
        const [, , street, city, state, postalCode, country] =
          splitVCardStructured(value).map(unescapeVCardValue);
        if (street) fields.adrStreet = street;
        if (city) fields.adrCity = city;
        if (state) fields.adrState = state;
        if (postalCode) fields.adrPostalCode = postalCode;
        if (country) fields.adrCountry = country;
        break;
      }
      case "NICKNAME":
        fields.nickname = unescapeVCardValue(value);
        break;
      case "ORG":
        fields.org = unescapeVCardValue(value);
        break;
      case "TITLE":
        fields.title = unescapeVCardValue(value);
        break;
      case "ROLE":
        fields.role = unescapeVCardValue(value);
        break;
      case "TEL":
        fields.phone = unescapeVCardValue(value);
        break;
      case "EMAIL":
        fields.email = unescapeVCardValue(value);
        break;
      case "URL":
        fields.url = unescapeVCardValue(value);
        break;
      case "LABEL":
        fields.label = unescapeVCardValue(value);
        break;
      case "NOTE":
        fields.note = unescapeVCardValue(value);
        break;
      // PHOTO/LOGO/BDAY/ANNIVERSARY aren't escaped on the way out (see buildVCard), so they
      // aren't unescaped on the way back in either.
      case "PHOTO":
        fields.photo = value;
        break;
      case "LOGO":
        fields.logo = value;
        break;
      case "BDAY":
        fields.bday = value;
        break;
      case "ANNIVERSARY":
        fields.anniversary = value;
        break;
      case "CATEGORIES":
        fields.categories = unescapeVCardValue(value);
        break;
      default:
        break;
    }
  }
  return fields;
}

export function isVCardFilled(f: VCardFields): boolean {
  return !!(f.familyName?.trim() || f.givenName?.trim());
}

export function buildVCard(f: VCardFields): string {
  const family = f.familyName?.trim() ?? "";
  const given = f.givenName?.trim() ?? "";
  const fn = [given, family].filter(Boolean).join(" ") || family || given;

  const lines = ["BEGIN:VCARD", `VERSION:${VCARD_VERSION}`];
  lines.push(`N:${escapeVCardValue(family)};${escapeVCardValue(given)};;;`);
  lines.push(`FN:${escapeVCardValue(fn)}`);
  if (f.nickname) lines.push(`NICKNAME:${escapeVCardValue(f.nickname)}`);
  if (f.org) lines.push(`ORG:${escapeVCardValue(f.org)}`);
  if (f.title) lines.push(`TITLE:${escapeVCardValue(f.title)}`);
  if (f.role) lines.push(`ROLE:${escapeVCardValue(f.role)}`);
  if (f.phone) lines.push(`TEL:${escapeVCardValue(f.phone)}`);
  if (f.email) lines.push(`EMAIL:${escapeVCardValue(f.email)}`);
  if (f.url) lines.push(`URL:${escapeVCardValue(f.url)}`);

  const hasAdr = [f.adrStreet, f.adrCity, f.adrState, f.adrPostalCode, f.adrCountry].some((v) =>
    v?.trim(),
  );
  if (hasAdr) {
    // ADR structure: PO box;extended address;street;city;state/province;postal code;country
    // — the first two fields are rarely used, left blank.
    const adr = [
      "",
      "",
      f.adrStreet ?? "",
      f.adrCity ?? "",
      f.adrState ?? "",
      f.adrPostalCode ?? "",
      f.adrCountry ?? "",
    ];
    lines.push(`ADR:${adr.map(escapeVCardValue).join(";")}`);
  }
  if (f.label) lines.push(`LABEL:${escapeVCardValue(f.label)}`);
  if (f.note) lines.push(`NOTE:${escapeVCardValue(f.note)}`);
  // PHOTO/LOGO only accept a URL — vCard also supports embedded Base64 image data, but there's
  // no file picker here, and having the user paste Base64 by hand (error-prone, and it would
  // bloat this record considerably) is worse than just treating it as a URL.
  if (f.photo) lines.push(`PHOTO:${f.photo}`);
  if (f.logo) lines.push(`LOGO:${f.logo}`);
  if (f.bday) lines.push(`BDAY:${f.bday}`);
  if (f.anniversary) lines.push(`ANNIVERSARY:${f.anniversary}`);
  if (f.categories) lines.push(`CATEGORIES:${escapeVCardValue(f.categories)}`);
  lines.push(`REV:${formatRev(new Date())}`);
  lines.push("END:VCARD");

  return lines.join("\r\n");
}
