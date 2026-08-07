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
