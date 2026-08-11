//! Capability Container + NDEF TLV + NDEF message parsing for Type 2 Tags. The formats here
//! all come from NFC Forum's public specs (Type 2 Tag Operation / NDEF / RTD-URI) — not
//! guessed. The URI prefix table was cross-checked against real NDEF message bytes
//! (`D1 01 23 55 04 ...` = a URI record, prefix code 0x04 = "https://") and matches exactly
//! what another NFC reader app on a phone decoded from the same tag.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct CapabilityContainer {
    pub version: String,
    /// Available NDEF capacity in bytes (the CC's MLEN field * 8).
    pub capacity_bytes: u32,
    pub writable: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct NdefRecordInfo {
    pub index: u32,
    pub tnf: u8,
    pub type_name: String,
    pub payload_hex: String,
    pub payload_text: Option<String>,
    /// Only present for well-known Type="U" (URI records), with the prefix code already
    /// expanded into the full string.
    pub uri: Option<String>,
}

/// page3 is exactly the 4 Capability Container bytes: [NDEF Magic, Version, MLEN, Access].
/// If the first byte isn't 0xE1, this card was never initialized in NFC Forum format — it's
/// not an NDEF tag.
pub fn parse_capability_container(page3: &[u8]) -> Option<CapabilityContainer> {
    if page3.len() < 4 || page3[0] != 0xE1 {
        return None;
    }
    let version = format!("{}.{}", page3[1] >> 4, page3[1] & 0x0F);
    let capacity_bytes = page3[2] as u32 * 8;
    // Access byte: high nibble is read permission, low nibble is write permission; 0000 means
    // allowed, any other value means restricted/forbidden.
    let writable = (page3[3] & 0x0F) == 0x00;
    Some(CapabilityContainer {
        version,
        capacity_bytes,
        writable,
    })
}

fn read_tlv_length(data: &[u8], i: usize) -> Option<(usize, usize)> {
    if data.get(i) == Some(&0xFF) {
        let len = u16::from_be_bytes([*data.get(i + 1)?, *data.get(i + 2)?]) as usize;
        Some((len, i + 3))
    } else {
        Some((*data.get(i)? as usize, i + 1))
    }
}

/// Scan the raw bytes starting at page4 for a type-0x03 TLV (NDEF Message) and return the raw
/// NDEF message bytes it wraps. TLV structure: [Type][Length][Value]; 0x00 is padding, skip 1
/// byte; 0xFE is the terminator; Length is normally 1 byte, but becomes 3 bytes (0xFF followed
/// by a 2-byte big-endian length) once it needs to be >= 0xFF.
pub fn find_ndef_message(data: &[u8]) -> Option<Vec<u8>> {
    let mut i = 0;
    while i < data.len() {
        match data[i] {
            0x00 => i += 1,
            0xFE => break,
            0x03 => {
                let (len, value_start) = read_tlv_length(data, i + 1)?;
                return data.get(value_start..value_start.checked_add(len)?).map(<[u8]>::to_vec);
            }
            _ => {
                let (len, value_start) = read_tlv_length(data, i + 1)?;
                i = value_start.checked_add(len)?;
            }
        }
    }
    None
}

const URI_PREFIXES: [&str; 36] = [
    "",
    "http://www.",
    "https://www.",
    "http://",
    "https://",
    "tel:",
    "mailto:",
    "ftp://anonymous:anonymous@",
    "ftp://ftp.",
    "ftps://",
    "sftp://",
    "smb://",
    "nfs://",
    "ftp://",
    "dav://",
    "news:",
    "telnet://",
    "imap:",
    "rtsp://",
    "urn:",
    "pop:",
    "sip:",
    "sips:",
    "tftp:",
    "btspp://",
    "btl2cap://",
    "btgoep://",
    "tcpobex://",
    "irdaobex://",
    "file://",
    "urn:epc:id:",
    "urn:epc:tag:",
    "urn:epc:pat:",
    "urn:epc:raw:",
    "urn:epc:",
    "urn:nfc:",
];

fn expand_uri(payload: &[u8]) -> Option<String> {
    let (&code, rest) = payload.split_first()?;
    let prefix = URI_PREFIXES.get(code as usize).copied().unwrap_or("");
    Some(format!("{prefix}{}", String::from_utf8_lossy(rest)))
}

/// Parse each record in an NDEF message. Record header layout (per the NFC Forum NDEF spec):
/// bit7 MB, bit6 ME, bit5 CF, bit4 SR (short record — Payload Length is 1 byte instead of 4),
/// bit3 IL (whether an ID field is present), bits 2-0 TNF.
pub fn parse_ndef_message(data: &[u8]) -> Vec<NdefRecordInfo> {
    let mut records = Vec::new();
    let mut i = 0;
    let mut index = 0u32;

    while i < data.len() {
        let header = data[i];
        let me = header & 0x40 != 0;
        let sr = header & 0x10 != 0;
        let il = header & 0x08 != 0;
        let tnf = header & 0x07;
        i += 1;

        let Some(&type_len) = data.get(i) else { break };
        i += 1;

        let payload_len = if sr {
            let Some(&len) = data.get(i) else { break };
            i += 1;
            len as usize
        } else {
            let Some(bytes) = data.get(i..i + 4) else { break };
            i += 4;
            u32::from_be_bytes(bytes.try_into().unwrap()) as usize
        };

        let id_len = if il {
            let Some(&len) = data.get(i) else { break };
            i += 1;
            len as usize
        } else {
            0
        };

        let Some(type_bytes) = data.get(i..i + type_len as usize) else { break };
        i += type_len as usize;

        i += id_len; // Skip the ID content — it isn't shown.

        let Some(payload) = data.get(i..i + payload_len) else { break };
        i += payload_len;

        let type_name = String::from_utf8_lossy(type_bytes).to_string();
        let uri = if tnf == 0x01 && type_name == "U" {
            expand_uri(payload)
        } else {
            None
        };

        records.push(NdefRecordInfo {
            index,
            tnf,
            type_name,
            payload_hex: hex::encode(payload).to_uppercase(),
            payload_text: std::str::from_utf8(payload).ok().map(str::to_string),
            uri,
        });
        index += 1;

        // ME (Message End) marks the last record — anything after it (e.g. leftover zero
        // padding within a TLV whose declared length is larger than the actual message, as
        // written by some third-party tools/tags) isn't part of this message and must not be
        // parsed as further records.
        if me {
            break;
        }
    }

    records
}

/// The UID's first byte is the vendor code from the NFC Forum registry. Only NXP (0x04) has
/// been confirmed here so far — other codes are left blank rather than guessed without
/// confidence.
pub fn manufacturer_name(first_uid_byte: u8) -> Option<String> {
    match first_uid_byte {
        0x04 => Some("NXP Semiconductors".to_string()),
        _ => None,
    }
}

/// Pick whichever prefix in URI_PREFIXES matches and leaves the shortest remainder; if nothing
/// matches, fall back to 0x00 (no abbreviation, write the full URI as-is into the payload),
/// matching real-world device behavior.
fn shrink_uri(uri: &str) -> (u8, &str) {
    let mut best: Option<(u8, &str)> = None;
    for (code, prefix) in URI_PREFIXES.iter().enumerate().skip(1) {
        if let Some(rest) = uri.strip_prefix(prefix) {
            let is_better = best.is_none_or(|(_, best_rest)| rest.len() < best_rest.len());
            if is_better {
                best = Some((code as u8, rest));
            }
        }
    }
    best.unwrap_or((0x00, uri))
}

/// A record not yet packed into a message: just TNF/Type/Payload. MB/ME depend on the
/// record's position within the whole message (whether it's first/last), which is only known
/// once the message is assembled, so a standalone record spec doesn't carry those two flags.
pub struct RecordSpec {
    tnf: u8,
    type_bytes: Vec<u8>,
    payload: Vec<u8>,
}

fn encode_record(mb: bool, me: bool, spec: &RecordSpec) -> Vec<u8> {
    // CF=0 (not chunked), IL=0 (no ID field); SR is decided by whether the payload fits in 1
    // byte or needs 4.
    let short_record = spec.payload.len() <= 0xFF;
    let mut header = spec.tnf;
    if mb {
        header |= 0x80;
    }
    if me {
        header |= 0x40;
    }
    if short_record {
        header |= 0x10;
    }

    let mut out = vec![header, spec.type_bytes.len() as u8];
    if short_record {
        out.push(spec.payload.len() as u8);
    } else {
        out.extend_from_slice(&(spec.payload.len() as u32).to_be_bytes());
    }
    out.extend_from_slice(&spec.type_bytes);
    out.extend_from_slice(&spec.payload);
    out
}

/// Pack multiple records into one complete NDEF message: the first record gets MB, the last
/// gets ME (with a single record, both flags land on that one record — same rule, single-record
/// case). An empty list just produces an empty Vec; it's up to the caller to decide whether
/// that counts as an error.
pub fn build_message(records: &[RecordSpec]) -> Vec<u8> {
    let mut out = Vec::new();
    let last = records.len().saturating_sub(1);
    for (i, spec) in records.iter().enumerate() {
        out.extend(encode_record(i == 0, i == last, spec));
    }
    out
}

/// A URI record (TNF=well-known, Type="U"). The exact inverse of [`expand_uri`]: use an
/// abbreviation code when a standard prefix matches, otherwise 0x00 (no abbreviation).
pub fn uri_record(uri: &str) -> RecordSpec {
    let (code, rest) = shrink_uri(uri);
    let mut payload = vec![code];
    payload.extend_from_slice(rest.as_bytes());
    RecordSpec {
        tnf: 0x01,
        type_bytes: b"U".to_vec(),
        payload,
    }
}

/// A text record (TNF=well-known, Type="T"). Payload layout: [status byte (bit7=0 means
/// UTF-8, low 6 bits are the language code length)][language code][actual text]; the language
/// code is fixed at "en".
pub fn text_record(text: &str) -> RecordSpec {
    const LANG: &[u8] = b"en";
    let mut payload = vec![LANG.len() as u8];
    payload.extend_from_slice(LANG);
    payload.extend_from_slice(text.as_bytes());
    RecordSpec {
        tnf: 0x01,
        type_bytes: b"T".to_vec(),
        payload,
    }
}

/// A MIME record (TNF=0x02); the payload is the raw text as-is. Used for cases like vCard,
/// where the "type" is a MIME type string and the content is plain text.
fn mime_text_record(mime_type: &str, text: &str) -> RecordSpec {
    RecordSpec {
        tnf: 0x02,
        type_bytes: mime_type.as_bytes().to_vec(),
        payload: text.as_bytes().to_vec(),
    }
}

/// A vCard 3.0 business card, with MIME type "text/vcard". The `vcard_text` passed in should
/// already be the complete `BEGIN:VCARD...END:VCARD` text — vCard is plain text by nature, so
/// assembling the string is left to the frontend UI (gluing together form fields into vCard
/// text is simpler there than defining a pile of structs on the Rust side).
pub fn vcard_record(vcard_text: &str) -> RecordSpec {
    mime_text_record("text/vcard", vcard_text)
}

fn wsc_tlv(attr_id: u16, value: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + value.len());
    out.extend_from_slice(&attr_id.to_be_bytes());
    out.extend_from_slice(&(value.len() as u16).to_be_bytes());
    out.extend_from_slice(value);
    out
}

/// WPS AuthType/EncryptionType flag values (WSC 2.0 spec) for the handful of security modes
/// exposed in the write UI — everything else in the spec (WPA/WPA2 mixed mode, enterprise auth,
/// ...) is left out rather than guessed at without a device to confirm against.
fn wps_security_flags(security: &str) -> (u16, u16) {
    const WPS_AUTH_OPEN: u16 = 0x0001;
    const WPS_AUTH_WPAPSK: u16 = 0x0002;
    const WPS_AUTH_SHARED: u16 = 0x0004; // WEP
    const WPS_AUTH_WPA2PSK: u16 = 0x0020;
    const WPS_ENCR_NONE: u16 = 0x0001;
    const WPS_ENCR_WEP: u16 = 0x0002;
    const WPS_ENCR_TKIP: u16 = 0x0004;
    const WPS_ENCR_AES: u16 = 0x0008;

    match security {
        "open" => (WPS_AUTH_OPEN, WPS_ENCR_NONE),
        "wep" => (WPS_AUTH_SHARED, WPS_ENCR_WEP),
        "wpa" => (WPS_AUTH_WPAPSK, WPS_ENCR_TKIP),
        // "wpa2" and anything unrecognized (e.g. an older saved draft with no security field)
        // fall back to the previous fixed behavior.
        _ => (WPS_AUTH_WPA2PSK, WPS_ENCR_AES),
    }
}

/// A Wi-Fi Simple Configuration record (MIME type "application/vnd.wfa.wsc"). The attribute IDs
/// and the overall Credential wrapper structure match wpa_supplicant's wps_defs.h reference
/// implementation, and also match real captured bytes from ndeflib's test cases — not guessed:
/// Credential=0x100E wraps AuthType=0x1003 / EncType=0x100F / SSID=0x1045 / NetworkKey=0x1027.
/// The MAC address and network index fields are optional and skipped here — saves effort and
/// doesn't affect whether phones recognize it.
pub fn wifi_record(ssid: &str, password: &str, security: &str) -> RecordSpec {
    const ATTR_CREDENTIAL: u16 = 0x100E;
    const ATTR_AUTH_TYPE: u16 = 0x1003;
    const ATTR_ENCR_TYPE: u16 = 0x100F;
    const ATTR_NETWORK_KEY: u16 = 0x1027;
    const ATTR_SSID: u16 = 0x1045;

    let (auth_type, enc_type) = wps_security_flags(security);

    let mut credential = Vec::new();
    credential.extend(wsc_tlv(ATTR_AUTH_TYPE, &auth_type.to_be_bytes()));
    credential.extend(wsc_tlv(ATTR_ENCR_TYPE, &enc_type.to_be_bytes()));
    credential.extend(wsc_tlv(ATTR_SSID, ssid.as_bytes()));
    credential.extend(wsc_tlv(ATTR_NETWORK_KEY, password.as_bytes()));

    RecordSpec {
        tnf: 0x02,
        type_bytes: b"application/vnd.wfa.wsc".to_vec(),
        payload: wsc_tlv(ATTR_CREDENTIAL, &credential),
    }
}

/// A fully user-specified record — the escape hatch for whatever the named kinds above don't
/// cover (a record type this app has no dedicated editor for, or one that doesn't exist yet).
/// Unlike every other builder here, there's no validation that `tnf`/`type_str`/`payload`
/// actually form something meaningful together (e.g. TNF=Empty with a non-empty type, or
/// TNF=Well-Known Type="U" with a payload that isn't a valid URI record body) — this is the
/// "you know what you're doing" path, so it just writes exactly what it's given.
pub fn custom_record(tnf: u8, type_str: &str, payload: Vec<u8>) -> Result<RecordSpec, String> {
    if tnf > 0x06 {
        return Err(format!("Invalid TNF {tnf:#04x}: must be 0x00-0x06"));
    }
    Ok(RecordSpec {
        tnf,
        type_bytes: type_str.as_bytes().to_vec(),
        payload,
    })
}

/// Build a record from a type name and some content. tel/sms/mailto/geo are all essentially
/// URI records with an extra scheme prefix, so they just reuse [`uri_record`] instead of
/// getting their own implementations. wifi needs an SSID, a password, and a security mode —
/// rather than define a separate request struct for every kind, the frontend joins those three
/// fields as "ssid\npassword\nsecurity" and this splits them back apart; a normal SSID/password
/// won't actually contain a newline.
pub fn record_for(kind: &str, content: &str) -> Result<RecordSpec, String> {
    match kind {
        "url" => Ok(uri_record(content)),
        "text" => Ok(text_record(content)),
        "tel" => Ok(uri_record(&format!("tel:{content}"))),
        "sms" => Ok(uri_record(&format!("sms:{content}"))),
        "mailto" => Ok(uri_record(&format!("mailto:{content}"))),
        "geo" => Ok(uri_record(&format!("geo:{content}"))),
        "vcard" => Ok(vcard_record(content)),
        "wifi" => {
            let mut parts = content.splitn(3, '\n');
            let ssid = parts.next().unwrap_or("");
            let password = parts.next().unwrap_or("");
            let security = parts.next().unwrap_or("wpa2");
            Ok(wifi_record(ssid, password, security))
        }
        "raw" => {
            // "tnf\ntype\npayload_hex" — the frontend's raw-record editor always sends the
            // payload as hex (even when the user typed plain text, it's UTF-8-encoded to hex
            // first) so there's no ambiguity about what bytes a literal "\n" in the payload
            // would mean; type_str, not being hex, is sent as-is and can't itself contain a
            // newline (it's a single-line input in the UI).
            let mut parts = content.splitn(3, '\n');
            let tnf_str = parts.next().unwrap_or("");
            let type_str = parts.next().unwrap_or("");
            let payload_hex = parts.next().unwrap_or("");
            let tnf: u8 = tnf_str
                .trim()
                .parse()
                .map_err(|_| format!("Invalid TNF: {tnf_str}"))?;
            let payload = hex::decode(payload_hex.trim())
                .map_err(|e| format!("Invalid payload hex: {e}"))?;
            custom_record(tnf, type_str, payload)
        }
        other => Err(format!("Unknown write type: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_and_parses_uri_round_trip() {
        let message = build_message(&[uri_record("https://orders.everacel.com/vcard/eaozeyux")]);
        // Matches raw bytes captured from a real device exactly: D1 01 23 55 04
        // "orders.everacel.com/vcard/eaozeyux"
        assert_eq!(message[0], 0xD1);
        assert_eq!(&message[..5], [0xD1, 0x01, 0x23, 0x55, 0x04]);

        let records = parse_ndef_message(&message);
        assert_eq!(records.len(), 1);
        assert_eq!(
            records[0].uri.as_deref(),
            Some("https://orders.everacel.com/vcard/eaozeyux")
        );
    }

    #[test]
    fn builds_and_parses_text_round_trip() {
        let message = build_message(&[text_record("hello")]);
        let records = parse_ndef_message(&message);
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].type_name, "T");
        assert_eq!(records[0].payload_text.as_deref(), Some("\u{2}enhello"));
    }

    #[test]
    fn builds_multi_record_message_with_correct_mb_me() {
        let message = build_message(&[uri_record("https://a.example"), text_record("hi")]);
        let records = parse_ndef_message(&message);
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].uri.as_deref(), Some("https://a.example"));
        assert_eq!(records[1].type_name, "T");
    }

    #[test]
    fn stops_at_message_end_and_ignores_trailing_padding() {
        // A single real record (ME=1) followed by trailing zero bytes — as if the NDEF TLV's
        // declared length were padded past the actual message, e.g. by a third-party writer
        // reserving a larger fixed block than the message needs.
        let mut message = build_message(&[text_record("hi")]);
        message.extend_from_slice(&[0u8; 12]);

        let records = parse_ndef_message(&message);
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].type_name, "T");
    }

    #[test]
    fn wifi_record_matches_reference_attribute_layout() {
        let spec = wifi_record("abcdefghij", "1234567890", "wpa2");
        // Cross-checked against wpa_supplicant's wps_defs.h and real captured-packet
        // structure from ndeflib's test cases: Credential(0x100E) wraps four sub-attributes,
        // AuthType/EncType/SSID/NetworkKey.
        assert_eq!(spec.type_bytes, b"application/vnd.wfa.wsc");
        assert_eq!(&spec.payload[0..2], &0x100E_u16.to_be_bytes());
        assert!(spec.payload.windows(2).any(|w| w == 0x1003_u16.to_be_bytes()));
        assert!(spec.payload.windows(2).any(|w| w == 0x100F_u16.to_be_bytes()));
        assert!(spec.payload.windows(2).any(|w| w == 0x1045_u16.to_be_bytes()));
        assert!(spec.payload.windows(2).any(|w| w == 0x1027_u16.to_be_bytes()));
    }

    #[test]
    fn wifi_record_security_modes_map_to_expected_wps_flags() {
        assert_eq!(wps_security_flags("open"), (0x0001, 0x0001));
        assert_eq!(wps_security_flags("wep"), (0x0004, 0x0002));
        assert_eq!(wps_security_flags("wpa"), (0x0002, 0x0004));
        assert_eq!(wps_security_flags("wpa2"), (0x0020, 0x0008));
        assert_eq!(wps_security_flags("anything-else"), (0x0020, 0x0008));
    }

    #[test]
    fn custom_record_writes_exactly_what_it_is_given() {
        let spec = custom_record(0x04, "example.com:widget", vec![0xDE, 0xAD, 0xBE, 0xEF]).unwrap();
        assert_eq!(spec.tnf, 0x04);
        assert_eq!(spec.type_bytes, b"example.com:widget");
        assert_eq!(spec.payload, vec![0xDE, 0xAD, 0xBE, 0xEF]);
    }

    #[test]
    fn custom_record_rejects_tnf_outside_the_valid_range() {
        assert!(custom_record(0x07, "x", vec![]).is_err());
    }

    #[test]
    fn record_for_raw_round_trips_through_the_message() {
        let spec = record_for("raw", "1\nT\n48656C6C6F").unwrap();
        assert_eq!(spec.tnf, 0x01);
        assert_eq!(spec.type_bytes, b"T");
        let message = build_message(&[spec]);
        let records = parse_ndef_message(&message);
        assert_eq!(records[0].payload_hex, "48656C6C6F");
    }
}
