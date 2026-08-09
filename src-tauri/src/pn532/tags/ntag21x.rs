//! NTAG21x / MIFARE Ultralight protocol logic: GET_VERSION-based model detection, page read/
//! write, NDEF writing, and write-password protection. Everything here only depends on
//! `pn532::session`'s generic "select a target, exchange bytes with it, retry" primitives — none
//! of it is specific to the PN532 beyond that (see the module doc on `pn532::tags`).

use crate::pn532::error::Pn532Error;
use crate::pn532::ndef::{self, CapabilityContainer, NdefRecordInfo};
use crate::pn532::protocol::{CMD_IN_COMMUNICATE_THRU, CMD_IN_DATA_EXCHANGE};
use crate::pn532::session::{OpenConnection, SelectedTarget, SharedSession};
use serde::{Deserialize, Serialize};
use serialport::SerialPort;

/// Type 2 Tag (Ultralight/NTAG family) commands, all passed through to the card via
/// InDataExchange.
///
/// GET_VERSION happens to share its byte value with MIFARE Classic's "authenticate with Key A"
/// (see `mifare_classic::MIFARE_CMD_AUTH_A`) — on genuine NXP PN532 firmware that's harmless,
/// since InDataExchange just relays bytes to whatever's currently selected. Some clone firmware,
/// though, special-cases 0x60/0x61 as a MIFARE-auth shortcut and expects the full
/// block+key+UID parameter shape to follow; sent to a Type 2 Tag with GET_VERSION's much
/// shorter parameter shape instead, that shows up as `protocol::PN532_ERROR_FRAME_BODY`
/// (a `0x7F` error frame) rather than a real reply — see the comment there.
const NTAG_CMD_GET_VERSION: u8 = 0x60;
const NTAG_CMD_READ: u8 = 0x30;
const NTAG_CMD_WRITE: u8 = 0xA2;
/// Password verification: on success the card replies with a 2-byte PACK, on a wrong password
/// the card just NAKs (which shows up in InDataExchange as a non-0x00 status byte) — same
/// failure-detection pattern as every other read/write.
const NTAG_CMD_PWD_AUTH: u8 = 0x1B;
/// Originality signature / one-way counter / tearing-flag commands — only implemented by
/// NTAG21x and Mifare Ultralight EV1 (original Ultralight, NTAG203, and Ultralight C don't
/// support any of these three and just NAK); used for the read page's extra info section and to
/// build a Flipper Zero–compatible `.nfc` export, which requires all of them.
const NTAG_CMD_READ_SIG: u8 = 0x3C;
const NTAG_CMD_READ_CNT: u8 = 0x39;
const NTAG_CMD_CHECK_TEARING_EVENT: u8 = 0x3E;

/// One READ returns 4 pages (16 bytes). Safety cap: when the model is unknown (GET_VERSION
/// failed), the only way to tell reading is done is to hit a NAK, so this hard-caps the page
/// count to guard against an infinite loop if the card misbehaves.
const MAX_DUMP_PAGES: u16 = 256;

/// Parse the 8 bytes returned by GET_VERSION: [Header, VendorID, ProductType, Subtype,
/// MajorVer, MinorVer, StorageSize, ProtocolType]. The model is looked up from the
/// (ProductType, StorageSize) pair against a table sourced from the NXP datasheet; a
/// combination that isn't in the table honestly returns `None` rather than guessing.
fn decode_ntag_version(version: &[u8]) -> (Option<String>, Option<String>) {
    let (Some(&product_type), Some(&storage_size)) = (version.get(2), version.get(6)) else {
        return (None, None);
    };

    match (product_type, storage_size) {
        (0x04, 0x0F) => (Some("NTAG213".into()), Some("144-byte user memory".into())),
        (0x04, 0x11) => (Some("NTAG215".into()), Some("504-byte user memory".into())),
        (0x04, 0x13) => (Some("NTAG216".into()), Some("888-byte user memory".into())),
        (0x03, 0x0B) => (
            Some("Mifare Ultralight EV1 (MF0UL11)".into()),
            Some("48-byte user memory".into()),
        ),
        (0x03, 0x0E) => (
            Some("Mifare Ultralight EV1 (MF0UL21)".into()),
            Some("128-byte user memory".into()),
        ),
        _ => (None, None),
    }
}

/// The NTAG21x family's total page count is fixed once the model is known, and is used to
/// bound the dump when the model is identified — more accurate than "read until NAK", because
/// the Type 2 Tag READ command wraps back around to the start once you're near the end and
/// keeps filling 4 pages, which makes relying on a NAK to detect the end unreliable for these
/// models.
fn total_pages_for(chip_model: &Option<String>) -> Option<u16> {
    match chip_model.as_deref() {
        Some("NTAG213") => Some(45),
        Some("NTAG215") => Some(135),
        Some("NTAG216") => Some(231),
        Some(s) if s.contains("MF0UL11") => Some(20),
        Some(s) if s.contains("MF0UL21") => Some(41),
        _ => None,
    }
}

/// The NTAG21x family always stores its config (AUTH0/ACCESS/PWD/PACK) in the last 4 pages —
/// the page number is a fixed offset from the total page count.
fn ntag_config_page_label(page: u16, total_pages: u16) -> Option<&'static str> {
    if page + 4 != total_pages {
        return None;
    }
    match total_pages - page {
        4 => Some("Config (MIRROR/AUTH0)"),
        3 => Some("Config (ACCESS)"),
        2 => Some("Password (PWD)"),
        1 => Some("Password check (PACK)"),
        _ => None,
    }
}

/// Attach a simple semantic label to a page, purely so the dump is easier to read — doesn't
/// affect the read itself.
fn label_for_page(page: u16, total_pages: Option<u16>) -> Option<&'static str> {
    match page {
        0 | 1 => Some("UID"),
        2 => Some("Internal bytes + lock bytes"),
        3 => Some("Capability Container"),
        _ => total_pages.and_then(|total| ntag_config_page_label(page, total)),
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct PasswordProtection {
    pub enabled: bool,
    /// The raw AUTH0 value — content from this page onward requires the password. 0xFF means
    /// this value is out of range for the tag's actual page count, i.e. protection isn't
    /// enabled.
    pub auth0: u8,
}

/// Locating the config page only works if the exact total page count is known (i.e.
/// GET_VERSION identified the model) — the last 4 pages are always the config block, and AUTH0
/// is the 4th byte of that (MIRROR/AUTH0) page. And that page must have actually been read
/// before this can be trusted.
fn read_password_protection(raw: &[u8], known_total: Option<u16>) -> Option<PasswordProtection> {
    let total = known_total?;
    let cfg0_page = total.checked_sub(4)?;
    let offset = cfg0_page as usize * 4;
    if raw.len() < offset + 4 {
        return None; // Didn't read that far (e.g. cut short by truncated_by_nak) — can't draw a conclusion.
    }
    let auth0 = raw[offset + 3];
    Some(PasswordProtection {
        enabled: auth0 != 0xFF,
        auth0,
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct MemoryPage {
    pub page: u16,
    pub hex: String,
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MemoryDump {
    pub uid: String,
    pub card_type: String,
    pub chip_model: Option<String>,
    /// When `chip_model` is `None` (GET_VERSION didn't identify it), this falls back to a
    /// guess based on the CC's declared capacity byte — display-only, it doesn't mean the chip
    /// itself confirmed this identity. Always `None` whenever `chip_model` has a value.
    pub chip_model_guess: Option<String>,
    pub memory_size: Option<String>,
    pub pages: Vec<MemoryPage>,
    /// Whether the read hit a failure partway through: when the model is unknown this means
    /// "stopped early, there may be more unread pages" (the last few pages might also just be
    /// duplicate data from wrapping back to the start); when the model is known it means "a few
    /// individual pages failed to read and were skipped" (those pages show up in `pages` with
    /// hex "????????", the rest were read in full). The frontend needs to show these two cases
    /// differently.
    pub truncated_by_nak: bool,
    /// The vendor looked up from the UID's first byte, e.g. "NXP Semiconductors".
    pub manufacturer: Option<String>,
    /// The Capability Container parsed from page3; absent means this card was never
    /// initialized in NDEF format.
    pub capability_container: Option<CapabilityContainer>,
    /// The raw NDEF message bytes wrapped in the TLV (hex), `None` if none was found.
    pub ndef_message_hex: Option<String>,
    pub ndef_records: Vec<NdefRecordInfo>,
    /// Only available once the exact model is identified (i.e. the total page count is known,
    /// so the config page can be located); `None` here means "couldn't determine", not
    /// "disabled".
    pub password_protection: Option<PasswordProtection>,
    /// Signature/counter/tearing-flag data — `None` whenever GET_VERSION itself didn't succeed
    /// (see `NtagSecurityData`'s doc comment for why a successful GET_VERSION doesn't guarantee
    /// these are readable too).
    pub security: Option<NtagSecurityData>,
}

/// GET_VERSION is only supported by the Ultralight/NTAG family (original Ultralight excepted)
/// — Classic cards don't recognize this command; if the card doesn't know it, this just fails
/// quietly, only losing the model detail. There's a small retry here — an occasional flaky
/// antenna hiccup shouldn't get a genuine NTAG misclassified as "model unknown" (especially now
/// that the password-protection feature directly depends on model detection: a misclassification
/// there goes from "missing model detail" to "the whole feature is unusable").
///
/// Sent via `InCommunicateThru`, not `InDataExchange` — the latter takes a leading target-number
/// byte and, on at least some PN532 firmware, auto-detects a leading 0x60/0x61 as a MIFARE
/// Classic "authenticate with Key A/B" shortcut and expects a full block+key+UID parameter set
/// to follow (see `PN532_ERROR_FRAME_BODY` in protocol.rs). GET_VERSION happens to share that
/// same leading byte but with a completely different, much shorter parameter shape, which was
/// getting misidentified as a malformed auth request and rejected outright.
/// `InCommunicateThru` instead relays bytes to the sole currently-selected target completely
/// untouched (and doesn't take a target-number parameter, since it doesn't support addressing
/// one target among several).
fn probe_ntag_version(
    port: &mut dyn SerialPort,
    _target_number: u8,
    sak: u8,
) -> (Option<String>, Option<String>, Option<[u8; 8]>) {
    if sak != 0x00 {
        return (None, None, None);
    }
    match crate::pn532::session::send_with_retry(port, CMD_IN_COMMUNICATE_THRU, &[NTAG_CMD_GET_VERSION], 2) {
        Ok(resp) if resp.first() == Some(&0x00) => {
            let (model, memory_size) = decode_ntag_version(&resp[1..]);
            // Got a real reply, but it didn't match any entry in the model table — log the raw
            // bytes so a misdiagnosed card (unsupported command vs. genuinely unrecognized
            // response) is visible in the Logs tab instead of silently collapsing into "unknown".
            if model.is_none() {
                log::debug!(
                    "GET_VERSION succeeded but didn't match any known model, raw reply: {}",
                    hex::encode(&resp)
                );
            }
            let version_bytes = resp.get(1..9).and_then(|b| b.try_into().ok());
            (model, memory_size, version_bytes)
        }
        // A well-formed InDataExchange reply, but with a non-zero status byte — the PN532 itself
        // considers this exchange to have failed (e.g. the target never answered within its
        // retry window), as opposed to a corrupted/unreadable frame.
        Ok(resp) => {
            log::debug!(
                "GET_VERSION exchange returned a non-success status, raw reply: {}",
                hex::encode(&resp)
            );
            (None, None, None)
        }
        Err(e) => {
            log::debug!("GET_VERSION exchange failed: {e}");
            (None, None, None)
        }
    }
}

/// Send a Type 2 Tag command via `InCommunicateThru` and unwrap a successful status byte — same
/// hardware-quirk reasoning as `probe_ntag_version`/`pwd_auth` above (this hardware mishandles
/// less-common Type 2 Tag commands via `InDataExchange`). Used for the three security-data reads
/// below, all of which are uncommon enough to hit the same issue.
fn ntag_communicate_thru(port: &mut dyn SerialPort, params: &[u8]) -> Result<Vec<u8>, Pn532Error> {
    let resp = crate::pn532::session::send_with_retry(port, CMD_IN_COMMUNICATE_THRU, params, 2)?;
    if resp.first() != Some(&0x00) {
        return Err(Pn532Error::InvalidFrame(
            "Command rejected or unsupported by this tag".into(),
        ));
    }
    Ok(resp[1..].to_vec())
}

#[derive(Debug, Clone, Serialize)]
pub struct NtagSecurityData {
    /// Raw 8-byte GET_VERSION reply, hex-encoded — kept alongside the already-decoded
    /// `chip_model` because Flipper Zero's own `.nfc` file format wants these exact bytes back
    /// verbatim (its "Mifare version" field), not a re-derived guess.
    pub version_hex: String,
    /// 32-byte NXP originality signature, hex-encoded; `None` if this chip doesn't implement
    /// READ_SIG or the read failed.
    pub signature_hex: Option<String>,
    /// The one-way NFC counter's current value. NTAG21x and Ultralight EV1 only implement a
    /// single counter, at index 2 (indices 0/1 always NAK on real hardware and aren't even
    /// attempted — this matches what Flipper Zero's own firmware does for these chips); `None`
    /// if this chip doesn't implement READ_CNT or the read failed.
    pub counter: Option<u32>,
    /// The tearing flag for that same counter (0xBD means no tearing event was ever detected);
    /// `None` under the same conditions as `counter`.
    pub tearing_flag: Option<u8>,
}

/// Only meaningful for a chip GET_VERSION already identified — `version` is that same successful
/// reply, passed in rather than re-fetched. Each of the three reads fails independently and
/// gracefully (`None`) rather than aborting the whole read; a chip that doesn't support any of
/// them (original Ultralight, NTAG203, Ultralight C) just ends up with all three `None`, same
/// spirit as `chip_model` itself.
fn read_ntag_security_data(port: &mut dyn SerialPort, version: [u8; 8]) -> NtagSecurityData {
    let signature_hex = match ntag_communicate_thru(port, &[NTAG_CMD_READ_SIG, 0x00]) {
        Ok(r) if r.len() >= 32 => Some(hex::encode(&r[..32]).to_uppercase()),
        Ok(r) => {
            log::debug!("READ_SIG succeeded but reply was too short: {}", hex::encode(&r));
            None
        }
        Err(e) => {
            log::debug!("READ_SIG failed: {e}");
            None
        }
    };

    let counter = match ntag_communicate_thru(port, &[NTAG_CMD_READ_CNT, 0x02]) {
        Ok(r) if r.len() >= 3 => Some(u32::from_le_bytes([r[0], r[1], r[2], 0])),
        Ok(r) => {
            log::debug!("READ_CNT succeeded but reply was too short: {}", hex::encode(&r));
            None
        }
        Err(e) => {
            log::debug!("READ_CNT failed: {e}");
            None
        }
    };

    let tearing_flag = match ntag_communicate_thru(port, &[NTAG_CMD_CHECK_TEARING_EVENT, 0x02]) {
        Ok(r) => match r.first() {
            Some(&b) => Some(b),
            None => {
                log::debug!("CHECK_TEARING_EVENT succeeded but reply was empty");
                None
            }
        },
        Err(e) => {
            log::debug!("CHECK_TEARING_EVENT failed: {e}");
            None
        }
    };

    NtagSecurityData {
        version_hex: hex::encode(version).to_uppercase(),
        signature_hex,
        counter,
        tearing_flag,
    }
}

/// Read the card's complete raw memory (currently only the Ultralight/NTAG family is
/// supported; Mifare Classic needs per-sector key authentication first, which isn't implemented
/// here yet). No card returns `Ok(None)`; if a card is present but isn't Ultralight/NTAG,
/// `pages` is empty while `card_type`/`uid` are still valid.
pub fn dump_memory(session: &SharedSession) -> Result<Option<MemoryDump>, Pn532Error> {
    let mut guard = session.lock().expect("pn532 session mutex poisoned");
    let conn = guard.as_mut().ok_or(Pn532Error::NotConnected)?;

    let Some(target) = crate::pn532::session::select_target(&mut *conn.port)? else {
        return Ok(None);
    };
    let (chip_model, memory_size, version_bytes) =
        probe_ntag_version(&mut *conn.port, target.target_number, target.sak);

    let mut pages = Vec::new();
    let mut raw = Vec::new();
    let mut truncated_by_nak = false;
    let known_total = total_pages_for(&chip_model);
    if target.sak == 0x00 {
        let mut page: u16 = 0;
        loop {
            if let Some(total) = known_total {
                if page >= total {
                    break;
                }
            }
            if page >= MAX_DUMP_PAGES {
                break;
            }

            // This used to just `break` on the first failure, cutting the whole dump short —
            // but if the model has already been identified (so the exact total page count is
            // known), a single group temporarily failing to read doesn't mean the end was
            // reached at all, it just means that particular response was flaky; retry a few
            // times, and if it still doesn't work, skip those pages and keep reading onward —
            // the whole dump shouldn't be thrown away just because one group of pages failed.
            // Only treat a failure as "reached the end" when the model is unknown (no total
            // page count, no other way to tell).
            let result = crate::pn532::session::send_with_retry(
                &mut *conn.port,
                CMD_IN_DATA_EXCHANGE,
                &[target.target_number, NTAG_CMD_READ, page as u8],
                3,
            );
            let resp = match result {
                Ok(r) if r.first() == Some(&0x00) && r.len() >= 17 => r,
                _ => {
                    truncated_by_nak = true;
                    let Some(total) = known_total else {
                        break; // Model unknown, no way to tell — treat it as having reached the end.
                    };
                    // Model known: mark these pages as "read failed" placeholders, still
                    // occupying their byte positions (otherwise later pages' offsets would be
                    // thrown off, and CC/NDEF parsing would fall apart).
                    for i in 0..4u16 {
                        let this_page = page + i;
                        if this_page >= total {
                            break;
                        }
                        pages.push(MemoryPage {
                            page: this_page,
                            hex: "????????".to_string(),
                            label: Some("Read failed, skipped".to_string()),
                        });
                        raw.extend_from_slice(&[0u8; 4]);
                    }
                    page += 4;
                    continue;
                }
            };

            let chunk = &resp[1..17]; // 4 pages * 4 bytes
            for (i, bytes) in chunk.chunks_exact(4).enumerate() {
                let this_page = page + i as u16;
                if let Some(total) = known_total {
                    if this_page >= total {
                        break;
                    }
                }
                pages.push(MemoryPage {
                    page: this_page,
                    hex: hex::encode(bytes).to_uppercase(),
                    label: label_for_page(this_page, known_total).map(str::to_string),
                });
                raw.extend_from_slice(bytes);
            }
            page += 4;
        }
    }

    // page3 (byte offset 12..16) is the Capability Container; the NDEF message (if any) is
    // found by scanning for a TLV starting at page4 (byte offset 16). Both of these are pure
    // local byte parsing, no further card communication needed.
    let capability_container = raw.get(12..16).and_then(ndef::parse_capability_container);
    let ndef_message = raw.get(16..).and_then(ndef::find_ndef_message);
    let ndef_records = ndef_message
        .as_deref()
        .map(ndef::parse_ndef_message)
        .unwrap_or_default();
    let ndef_message_hex = ndef_message.map(|m| hex::encode(&m).to_uppercase());
    let manufacturer = target.uid.first().copied().and_then(ndef::manufacturer_name);
    let password_protection = read_password_protection(&raw, known_total);
    // When GET_VERSION can't identify the model (some compatible/clone chips just don't
    // support this NXP proprietary extended command at all — observed in practice:
    // READ/WRITE work fine, but GET_VERSION is consistently flagged as a communication error
    // by the PN532), fall back to guessing from the capacity byte the CC declares — NTAG21x
    // tags written with a factory/standard NDEF writer use a fixed capacity byte, so the guess
    // is usually right, but it's still a guess, and can't be used to locate the config page for
    // password protection (that needs the exact total page count — guessing wrong there risks
    // writing over a data page that shouldn't be touched, mistaking it for a config page). It's
    // only used to give the "model" line something more informative than "unknown".
    let chip_model_guess = if chip_model.is_none() {
        capability_container
            .as_ref()
            .and_then(|cc| guess_chip_model_from_cc_capacity(cc.capacity_bytes))
    } else {
        None
    };
    let security = version_bytes.map(|v| read_ntag_security_data(&mut *conn.port, v));

    Ok(Some(MemoryDump {
        uid: hex::encode(&target.uid).to_uppercase(),
        card_type: crate::pn532::session::classify_card(target.sak),
        chip_model,
        chip_model_guess,
        memory_size,
        pages,
        truncated_by_nak,
        manufacturer,
        capability_container,
        ndef_message_hex,
        ndef_records,
        password_protection,
        security,
    }))
}

/// Guess a possible model from the writable capacity byte declared in the CC — this matches
/// the fixed capacity values NXP's standard writers use when writing NDEF onto blank factory
/// tags. Display-only, see the comment at the call site above.
///
/// The 144-byte case deliberately doesn't just say "NTAG213": MIFARE Ultralight C's user memory
/// is also exactly 144 bytes with the same CC value, so the capacity byte alone can't
/// distinguish the two models (and they use completely different password/authentication
/// schemes — Ultralight C uses mutual 3DES authentication, nothing like NTAG21x's PWD_AUTH) —
/// this shouldn't make that call on the user's behalf. 496/872 bytes have no known
/// same-capacity ambiguity.
///
/// NTAG215/216 deliberately don't use the "504"/"888" byte figures `decode_ntag_version` reports
/// for GET_VERSION's StorageSize — those describe the chip's total raw user memory, a few pages
/// larger than what the CC actually declares as NDEF-usable (real NTAG215 CC bytes, confirmed
/// against an actual factory-written tag's page3, are `E1 10 3E 00` — MLEN 0x3E = 496, not the
/// 0x3F/504 this used to say here; NTAG216 is the same story, 0x6D = 872 not 0x6F/888). A handful
/// of pages near the end of the physical memory (dynamic lock bytes etc.) are real, readable/
/// writable pages that just aren't covered by the CC's declared capacity.
fn guess_chip_model_from_cc_capacity(capacity_bytes: u32) -> Option<String> {
    match capacity_bytes {
        144 => Some("NTAG213 or MIFARE Ultralight C".into()),
        496 => Some("NTAG215".into()),
        872 => Some("NTAG216".into()),
        _ => None,
    }
}

/// The inverse of [`guess_chip_model_from_cc_capacity`]: the standard NDEF-writable capacity
/// (CC MLEN * 8) this codebase writes into a freshly-formatted Capability Container for a given
/// identified chip model. Same values NXP's own factory NDEF writers use, which is also why
/// they round-trip exactly through `guess_chip_model_from_cc_capacity` above — see that
/// function's doc comment for why NTAG215/216 aren't 504/888 here.
fn ndef_capacity_for_chip_model(chip_model: &str) -> Option<u32> {
    match chip_model {
        "NTAG213" => Some(144),
        "NTAG215" => Some(496),
        "NTAG216" => Some(872),
        s if s.contains("MF0UL11") => Some(48),
        s if s.contains("MF0UL21") => Some(128),
        _ => None,
    }
}

/// Passwords are uniformly represented as an 8-digit hex string (4 bytes) — the frontend
/// generates/displays passwords in this format, this function is only responsible for
/// parsing/validating it.
fn parse_password_hex(s: &str) -> Result<[u8; 4], Pn532Error> {
    let bytes = hex::decode(s)
        .map_err(|_| Pn532Error::InvalidFrame("Invalid password format; expected 8 hex digits".into()))?;
    bytes
        .try_into()
        .map_err(|_| Pn532Error::InvalidFrame("Password must be exactly 4 bytes (8 hex digits)".into()))
}

/// Send PWD_AUTH to verify the password, returning whether it passed. On a wrong password the
/// card just NAKs, with no distinction between "wrong password" and "communication error" — the
/// effect is the same either way: this verification didn't pass.
///
/// Sent via `InCommunicateThru`, not `InDataExchange`, and wrapped in a retry — same fix as
/// `probe_ntag_version`, for the same underlying reason: a raw frame capture showed PWD_AUTH
/// (`0x1B`) sent via `InDataExchange` getting rejected outright with the `0x7F` error frame,
/// with no NAK from the tag involved at all — the exchange never actually reached it. That
/// capture also showed GET_VERSION (`0x60`) succeeding cleanly via `InCommunicateThru` moments
/// earlier on the same connection, so this isn't the `0x60`/`0x61` MIFARE-auth-shortcut collision
/// specifically (`0x1B` doesn't collide with any MIFARE Classic opcode) — it looks like this
/// board's `InDataExchange` only reliably relays a narrow set of commands (plain MIFARE-style
/// READ/WRITE) and mishandles less common Type 2 Tag commands more broadly, not just the ones
/// that happen to share a byte value with a MIFARE opcode. `InCommunicateThru` avoids that either
/// way, having already been confirmed to relay `0x60` correctly where `InDataExchange` didn't.
fn pwd_auth(
    port: &mut dyn SerialPort,
    _target_number: u8,
    password: [u8; 4],
) -> Result<bool, Pn532Error> {
    let mut params = vec![NTAG_CMD_PWD_AUTH];
    params.extend_from_slice(&password);
    let resp = crate::pn532::session::send_with_retry(port, CMD_IN_COMMUNICATE_THRU, &params, 2)?;
    Ok(resp.first() == Some(&0x00))
}

/// The NTAG21x family always keeps config in the last 4 pages, at a fixed offset from the
/// total page count: CFG0(MIRROR/AUTH0), CFG1(ACCESS), PWD, PACK, in that order. Same offset
/// scheme as [`ntag_config_page_label`].
fn ntag_config_pages(total_pages: u16) -> Option<(u8, u8, u8, u8)> {
    let cfg0 = total_pages.checked_sub(4)?;
    if cfg0 > u8::MAX as u16 {
        return None; // Page number exceeding u8 shouldn't happen in theory (NTAG216 only has 231 pages total) — checked just to be safe.
    }
    let cfg0 = cfg0 as u8;
    Some((cfg0, cfg0 + 1, cfg0 + 2, cfg0 + 3))
}

fn ntag_write_page(
    port: &mut dyn SerialPort,
    target_number: u8,
    page: u8,
    bytes: [u8; 4],
) -> Result<(), Pn532Error> {
    let mut params = vec![target_number, NTAG_CMD_WRITE, page];
    params.extend_from_slice(&bytes);
    let resp = crate::pn532::session::send_with_retry(port, CMD_IN_DATA_EXCHANGE, &params, 3)?;
    if resp.first() != Some(&0x00) {
        return Err(Pn532Error::InvalidFrame(format!("Failed to write page {page}")));
    }
    Ok(())
}

fn ntag_read_page(
    port: &mut dyn SerialPort,
    target_number: u8,
    page: u8,
) -> Result<[u8; 4], Pn532Error> {
    let resp = crate::pn532::session::send_with_retry(port, CMD_IN_DATA_EXCHANGE, &[target_number, NTAG_CMD_READ, page], 3)?;
    if resp.first() != Some(&0x00) || resp.len() < 5 {
        return Err(Pn532Error::InvalidFrame(format!("Failed to read page {page}")));
    }
    Ok([resp[1], resp[2], resp[3], resp[4]])
}

/// The select-card + verify-model/UID steps get reused across several password-protection
/// operations, so they're factored out here. Returns the selected target plus the four config
/// page numbers (CFG0, CFG1, PWD, PACK).
fn select_ntag_for_password_op(
    conn: &mut OpenConnection,
    expected_uid: &str,
) -> Result<(SelectedTarget, (u8, u8, u8, u8)), Pn532Error> {
    let Some(target) = crate::pn532::session::select_target(&mut *conn.port)? else {
        return Err(Pn532Error::NoCardPresent);
    };
    if target.sak != 0x00 {
        return Err(Pn532Error::InvalidFrame(
            "The current card isn't an Ultralight/NTAG type; password protection isn't supported".into(),
        ));
    }
    let actual = hex::encode(&target.uid).to_uppercase();
    if actual != expected_uid.to_uppercase() {
        return Err(Pn532Error::InvalidFrame(format!(
            "The card was swapped (expected to operate on {expected_uid}, but detected {actual}) — operation cancelled"
        )));
    }

    let (chip_model, _, _) = probe_ntag_version(&mut *conn.port, target.target_number, target.sak);
    let total = total_pages_for(&chip_model).ok_or_else(|| {
        Pn532Error::InvalidFrame("Couldn't identify this tag's exact model; password protection isn't supported yet".into())
    })?;
    let cfg_pages = ntag_config_pages(total).ok_or_else(|| {
        Pn532Error::InvalidFrame("This tag's page count is outside the expected range; password protection isn't supported yet".into())
    })?;

    Ok((target, cfg_pages))
}

/// Set or change the write password on an NTAG/Ultralight card: starting from page4 (the
/// first user-data page), writes require password verification, reads are unaffected (the
/// ACCESS PROT bit is always written as 0). Calling this on a card that already has password
/// protection enabled (i.e. changing the password) must be given the correct
/// `current_password` first.
///
/// PWD_AUTH's own reported pass/fail isn't treated as the source of truth for whether
/// `current_password` was right — the first write below is: a wrong password leaves the card
/// un-authenticated, so writing PWD then fails on its own (the tag rejects writes to a page it's
/// still protecting), which is a more reliable signal than trusting PWD_AUTH's status byte in
/// isolation, given this hardware's exchange status for less-common commands has already turned
/// out to be unreliable once (see `pwd_auth`'s doc comment).
///
/// The write order is fixed as PWD → PACK → ACCESS → AUTH0, and can't be reordered: once
/// AUTH0 takes effect, the config pages themselves also fall under protection — writing AUTH0
/// first would make the remaining steps fail because they'd suddenly "need a password",
/// effectively locking the operation out of its own card.
pub fn set_ntag_password(
    session: &SharedSession,
    expected_uid: &str,
    current_password: Option<&str>,
    new_password: &str,
) -> Result<(), Pn532Error> {
    let current = current_password.map(parse_password_hex).transpose()?;
    let new_pwd = parse_password_hex(new_password)?;

    let mut guard = session.lock().expect("pn532 session mutex poisoned");
    let conn = guard.as_mut().ok_or(Pn532Error::NotConnected)?;
    let (target, (cfg0_page, cfg1_page, pwd_page, pack_page)) =
        select_ntag_for_password_op(conn, expected_uid)?;

    if let Some(current) = current {
        pwd_auth(&mut *conn.port, target.target_number, current)?;
    }

    ntag_write_page(&mut *conn.port, target.target_number, pwd_page, new_pwd).map_err(|e| {
        if current.is_some() {
            Pn532Error::InvalidFrame(
                "Failed to write the new password — the current password may be incorrect".into(),
            )
        } else {
            e
        }
    })?;
    // PACK is only used to carry a check value when the card responds to PWD_AUTH; filling it
    // with 0 is fine, no need for the user to care about it.
    ntag_write_page(&mut *conn.port, target.target_number, pack_page, [0, 0, 0, 0])?;

    // Only change the PROT bit of the ACCESS byte (bit7, cleared = protect writes only, not
    // reads); leave the other bits (AUTHLIM etc.) alone, don't touch any existing config there.
    let mut cfg1 = ntag_read_page(&mut *conn.port, target.target_number, cfg1_page)?;
    cfg1[0] &= 0x7F;
    ntag_write_page(&mut *conn.port, target.target_number, cfg1_page, cfg1)?;

    // AUTH0 is the 4th byte of the CFG0 page, written last: 4 means protection starts from the
    // first user-data page, i.e. covers all writable content.
    let mut cfg0 = ntag_read_page(&mut *conn.port, target.target_number, cfg0_page)?;
    cfg0[3] = 4;
    ntag_write_page(&mut *conn.port, target.target_number, cfg0_page, cfg0)?;

    Ok(())
}

/// Remove write-password protection from an NTAG/Ultralight card: once the current password
/// checks out, write AUTH0 back to 0xFF (out of the page-count range, i.e. effectively disabled
/// for every page); PWD/PACK/ACCESS are left untouched.
///
/// PWD_AUTH's own reported pass/fail isn't checked here — see the comment on `set_ntag_password`
/// for why: the write below is the real signal. A wrong password leaves the card
/// un-authenticated, and the write to the (still write-protected) CFG0 page then fails on its
/// own, without needing to trust an intermediate status byte in isolation.
pub fn clear_ntag_password(
    session: &SharedSession,
    expected_uid: &str,
    current_password: &str,
) -> Result<(), Pn532Error> {
    let current = parse_password_hex(current_password)?;

    let mut guard = session.lock().expect("pn532 session mutex poisoned");
    let conn = guard.as_mut().ok_or(Pn532Error::NotConnected)?;
    let (target, (cfg0_page, ..)) = select_ntag_for_password_op(conn, expected_uid)?;

    pwd_auth(&mut *conn.port, target.target_number, current)?;

    let mut cfg0 = ntag_read_page(&mut *conn.port, target.target_number, cfg0_page)?;
    cfg0[3] = 0xFF;
    ntag_write_page(&mut *conn.port, target.target_number, cfg0_page, cfg0).map_err(|_| {
        Pn532Error::InvalidFrame(
            "Failed to remove password protection — the current password may be incorrect".into(),
        )
    })?;

    Ok(())
}

/// Read just one page (CFG0) to check the current password-protection state, instead of a full
/// card read like [`dump_memory`] — the "write" page just wants to know "does this need a
/// password" before actually writing, it doesn't need the rest of the card's content. No card,
/// a non-Ultralight/NTAG card, or an unidentifiable model (can't locate the config page) all
/// return `Ok(None)` — treated the same as "couldn't determine", and the frontend handles that
/// as "no password needed" — if a password actually was required, not supplying one will simply
/// hit a page-write NAK inside `write_ndef`, it won't actually corrupt any data.
pub fn read_ntag_password_status(
    session: &SharedSession,
) -> Result<Option<PasswordProtection>, Pn532Error> {
    let mut guard = session.lock().expect("pn532 session mutex poisoned");
    let conn = guard.as_mut().ok_or(Pn532Error::NotConnected)?;

    let Some(target) = crate::pn532::session::select_target(&mut *conn.port)? else {
        return Ok(None);
    };
    if target.sak != 0x00 {
        return Ok(None);
    }
    let (chip_model, _, _) = probe_ntag_version(&mut *conn.port, target.target_number, target.sak);
    let Some(total) = total_pages_for(&chip_model) else {
        return Ok(None);
    };
    let Some((cfg0_page, ..)) = ntag_config_pages(total) else {
        return Ok(None);
    };
    let cfg0 = ntag_read_page(&mut *conn.port, target.target_number, cfg0_page)?;
    Ok(Some(PasswordProtection {
        enabled: cfg0[3] != 0xFF,
        auth0: cfg0[3],
    }))
}

#[derive(Debug, Clone, Deserialize)]
pub struct NdefRecordRequest {
    pub kind: String,
    pub content: String,
}

/// Write one or more NDEF records ("url"/"text"/"tel"/"sms"/"mailto"/"geo"/"vcard"/"wifi") to
/// an Ultralight/NTAG card. Multiple records get packed into a single NDEF message, not
/// written as several separate messages — that's the standard way NDEF works: a tag should
/// only ever have one message, which can hold multiple records.
///
/// `expected_uid` is the card UID the frontend was showing at the moment "write" was clicked
/// — if the caller passes this, the target gets reselected and its UID re-checked against it
/// right before actually writing. There's a time gap between the user clicking "write" and this
/// function actually running, during which the card could have been swapped out (e.g. to take a
/// quick look at another card) — if it no longer matches, this aborts immediately instead of
/// writing content onto a card the user never intended to write to.
///
/// Only writes to a tag that already has a Capability Container — no CC means this tag was
/// never formatted, and formatting isn't implemented yet, so this errors out rather than
/// guessing and writing a CC on the tag's behalf. This overwrites whatever was already at page4
/// onward (including any Lock Control TLV or similar metadata that might have been there),
/// keeping only the CC itself.
///
/// `password` must be provided if this card has write-password protection enabled (see
/// [`set_ntag_password`]) — a PWD_AUTH is done before writing, and a mismatch aborts
/// immediately without touching any page; a card without protection doesn't need it passed.
pub fn write_ndef(
    session: &SharedSession,
    records: &[NdefRecordRequest],
    expected_uid: Option<&str>,
    password: Option<&str>,
) -> Result<(), Pn532Error> {
    if records.is_empty() {
        return Err(Pn532Error::InvalidFrame("Nothing to write".into()));
    }
    let specs = records
        .iter()
        .map(|r| ndef::record_for(&r.kind, &r.content))
        .collect::<Result<Vec<_>, _>>()
        .map_err(Pn532Error::InvalidFrame)?;
    let message = ndef::build_message(&specs);
    let pwd = password.map(parse_password_hex).transpose()?;

    let mut guard = session.lock().expect("pn532 session mutex poisoned");
    let conn = guard.as_mut().ok_or(Pn532Error::NotConnected)?;

    let Some(target) = crate::pn532::session::select_target(&mut *conn.port)? else {
        return Err(Pn532Error::NoCardPresent);
    };
    if target.sak != 0x00 {
        return Err(Pn532Error::InvalidFrame(
            "The current card isn't an Ultralight/NTAG type; this write method isn't supported yet".into(),
        ));
    }
    if let Some(expected) = expected_uid {
        let actual = hex::encode(&target.uid).to_uppercase();
        if actual != expected.to_uppercase() {
            return Err(Pn532Error::InvalidFrame(format!(
                "The card was swapped (expected to write to {expected}, but detected {actual}) — write cancelled"
            )));
        }
    }
    if let Some(pwd) = pwd {
        if !pwd_auth(&mut *conn.port, target.target_number, pwd)? {
            return Err(Pn532Error::InvalidFrame("Password is incorrect; write not started".into()));
        }
    }

    write_ndef_message_to_target(&mut *conn.port, &target, &message)
}

/// Wrap `message` in its NDEF TLV, check it fits the target's declared CC capacity, pad to a
/// whole number of pages, and write it starting at page4 — the shared tail of [`write_ndef`] and
/// [`copy_ntag_card`], which only differ in how they arrive at the message bytes (built fresh
/// from typed records vs. copied verbatim from another card's dump) and in their own
/// selection/UID/password preambles before this point. Requires the target to already have a
/// Capability Container — no CC means this tag was never formatted, and this errors out rather
/// than guessing and writing one on the tag's behalf (see `format_ntag` for that).
fn write_ndef_message_to_target(
    port: &mut dyn SerialPort,
    target: &SelectedTarget,
    message: &[u8],
) -> Result<(), Pn532Error> {
    // Reading from page0 conveniently also reads back page3 (the Capability Container).
    let read_resp = crate::pn532::session::send_with_retry(
        port,
        CMD_IN_DATA_EXCHANGE,
        &[target.target_number, NTAG_CMD_READ, 0],
        3,
    )?;
    if read_resp.first() != Some(&0x00) || read_resp.len() < 17 {
        return Err(Pn532Error::InvalidFrame(
            "Failed to read the Capability Container".into(),
        ));
    }
    let cc = ndef::parse_capability_container(&read_resp[13..17]).ok_or_else(|| {
        Pn532Error::InvalidFrame(
            "This tag doesn't have a Capability Container yet (not formatted); direct writing isn't supported yet".into(),
        )
    })?;

    let mut tlv = vec![0x03u8];
    if message.len() < 255 {
        tlv.push(message.len() as u8);
    } else {
        tlv.push(0xFF);
        tlv.extend_from_slice(&(message.len() as u16).to_be_bytes());
    }
    tlv.extend_from_slice(message);
    tlv.push(0xFE); // Terminator TLV

    if tlv.len() > cc.capacity_bytes as usize {
        return Err(Pn532Error::InvalidFrame(format!(
            "Content too large: needs {} bytes, tag can hold {} bytes",
            tlv.len(),
            cc.capacity_bytes
        )));
    }

    let mut padded = tlv;
    while padded.len() % 4 != 0 {
        padded.push(0x00);
    }

    for (i, page_bytes) in padded.chunks_exact(4).enumerate() {
        let page = 4u8.wrapping_add(i as u8);
        let mut params = vec![target.target_number, NTAG_CMD_WRITE, page];
        params.extend_from_slice(page_bytes);
        let resp = crate::pn532::session::send_with_retry(port, CMD_IN_DATA_EXCHANGE, &params, 3)?;
        if resp.first() != Some(&0x00) {
            return Err(Pn532Error::InvalidFrame(format!("Failed to write page {page}")));
        }
    }

    Ok(())
}

/// Copy another NTAG/Ultralight card's NDEF content onto whatever card is currently on the
/// reader — the NTAG counterpart to `mifare_classic::copy_classic_card`. `source_message_hex` is
/// the raw NDEF message bytes (hex-encoded) previously read from the source card via
/// `dump_memory`, written onto the target byte-for-byte rather than being re-parsed into typed
/// records and rebuilt — that avoids a lossy round-trip through `ndef::record_for`'s limited
/// vocabulary of record kinds for any record type this app doesn't have a dedicated writer for.
///
/// Unlike `write_ndef`, this doesn't take a fixed `expected_uid` to re-check against — the whole
/// point of "copy" is that the target keeps being whatever card the user places next, including
/// several in a row. What it does guard against is the target being the *source* card itself
/// (still sitting there, or placed back down) — copying it onto itself would silently look like
/// success while doing nothing useful, so that's rejected instead, the same guard
/// `copy_classic_card` uses. Deliberately doesn't require the target's exact chip model to match
/// the source's (e.g. copying an NTAG213 dump onto an NTAG215) — only that it's some
/// NTAG/Ultralight card with enough declared capacity for the content, checked inside
/// `write_ndef_message_to_target`.
///
/// `password` follows the same contract as `write_ndef`: only needed if the target currently has
/// write-password protection enabled.
pub fn copy_ntag_card(
    session: &SharedSession,
    source_uid: &str,
    source_message_hex: &str,
    password: Option<&str>,
) -> Result<(), Pn532Error> {
    let message = hex::decode(source_message_hex)
        .map_err(|_| Pn532Error::InvalidFrame("Invalid source NDEF data".into()))?;
    let pwd = password.map(parse_password_hex).transpose()?;

    let mut guard = session.lock().expect("pn532 session mutex poisoned");
    let conn = guard.as_mut().ok_or(Pn532Error::NotConnected)?;

    let Some(target) = crate::pn532::session::select_target(&mut *conn.port)? else {
        return Err(Pn532Error::NoCardPresent);
    };
    if target.sak != 0x00 {
        return Err(Pn532Error::InvalidFrame(
            "The target card isn't an Ultralight/NTAG type; copying isn't supported for it".into(),
        ));
    }
    let target_uid = hex::encode(&target.uid).to_uppercase();
    if target_uid == source_uid.to_uppercase() {
        return Err(Pn532Error::InvalidFrame(
            "The card detected is still the source card itself (same UID) — swap in the target card and try again".into(),
        ));
    }
    if let Some(pwd) = pwd {
        if !pwd_auth(&mut *conn.port, target.target_number, pwd)? {
            return Err(Pn532Error::InvalidFrame("Password is incorrect; copy not started".into()));
        }
    }

    write_ndef_message_to_target(&mut *conn.port, &target, &message)
}

/// Select the current target, optionally re-check its UID, and (if a password was given) run
/// PWD_AUTH — the selection/UID-guard/password preamble shared by [`format_ntag`] and
/// [`erase_ntag`], which otherwise only differ in what they write past this point. Returns the
/// selected target on success.
fn select_ntag_for_erase_or_format<'a>(
    conn: &'a mut OpenConnection,
    expected_uid: Option<&str>,
    password: Option<[u8; 4]>,
    verb: &str,
) -> Result<SelectedTarget, Pn532Error> {
    let Some(target) = crate::pn532::session::select_target(&mut *conn.port)? else {
        return Err(Pn532Error::NoCardPresent);
    };
    if target.sak != 0x00 {
        return Err(Pn532Error::InvalidFrame(format!(
            "The current card isn't an Ultralight/NTAG type; {verb} isn't supported for it"
        )));
    }
    if let Some(expected) = expected_uid {
        let actual = hex::encode(&target.uid).to_uppercase();
        if actual != expected.to_uppercase() {
            return Err(Pn532Error::InvalidFrame(format!(
                "The card was swapped (expected to {verb} {expected}, but detected {actual}) — {verb} cancelled"
            )));
        }
    }
    if let Some(pwd) = password {
        if !pwd_auth(&mut *conn.port, target.target_number, pwd)? {
            return Err(Pn532Error::InvalidFrame(format!(
                "Password is incorrect; {verb} not started"
            )));
        }
    }
    Ok(target)
}

/// Overwrite the entire NDEF-usable data area (page4 onward, sized by the CC's declared
/// capacity) with an empty NDEF message: `03 00 FE` (type=NDEF Message, length=0, terminator) at
/// the very front, zeros everywhere else. Just rewriting page4 alone would already make any
/// standards-compliant NDEF reader see the tag as empty (a zero-length message means "stop
/// here"), but it would leave the old content's bytes physically sitting on the later pages —
/// invisible to NDEF parsing, but still showing up in a raw memory dump, which doesn't stop at
/// the TLV terminator. Zeroing the whole declared area makes "erase"/"format" actually clear the
/// data, matching what a raw dump shows, not just the pointer to it.
fn zero_ndef_area(
    port: &mut dyn SerialPort,
    target_number: u8,
    capacity_bytes: u32,
) -> Result<(), Pn532Error> {
    let mut area = vec![0u8; capacity_bytes as usize];
    area[0] = 0x03;
    area[1] = 0x00;
    area[2] = 0xFE;
    for (i, page_bytes) in area.chunks_exact(4).enumerate() {
        let page = 4u8.wrapping_add(i as u8);
        ntag_write_page(port, target_number, page, page_bytes.try_into().unwrap())?;
    }
    Ok(())
}

/// Format a blank (or previously-written) Ultralight/NTAG card into NFC Forum Type 2 Tag / NDEF
/// format: writes a fresh Capability Container (page3), sized for the detected chip model, then
/// zeros the whole NDEF data area that CC declares (see [`zero_ndef_area`]). Unlike
/// [`write_ndef`]/[`erase_ntag`], this doesn't require an existing CC — that's the whole point,
/// it's how a never-formatted tag gets one in the first place — but it does require the exact
/// chip model to be identified via GET_VERSION, since the correct CC capacity byte depends on it
/// and there's no safe generic default to fall back to.
///
/// `password` follows the same contract as `write_ndef`: only needed if the card currently has
/// write-password protection enabled, since page3 onward falls under that protection like any
/// other write.
pub fn format_ntag(
    session: &SharedSession,
    expected_uid: Option<&str>,
    password: Option<&str>,
) -> Result<(), Pn532Error> {
    let pwd = password.map(parse_password_hex).transpose()?;

    let mut guard = session.lock().expect("pn532 session mutex poisoned");
    let conn = guard.as_mut().ok_or(Pn532Error::NotConnected)?;
    let target = select_ntag_for_erase_or_format(conn, expected_uid, pwd, "format")?;

    let (chip_model, _, _) = probe_ntag_version(&mut *conn.port, target.target_number, target.sak);
    let chip_model = chip_model.ok_or_else(|| {
        Pn532Error::InvalidFrame(
            "Couldn't identify this tag's exact model; formatting isn't supported yet".into(),
        )
    })?;
    let capacity_bytes = ndef_capacity_for_chip_model(&chip_model).ok_or_else(|| {
        Pn532Error::InvalidFrame(
            "This chip model's NDEF capacity isn't known; formatting isn't supported yet".into(),
        )
    })?;

    let cc = [0xE1u8, 0x10, (capacity_bytes / 8) as u8, 0x00];
    ntag_write_page(&mut *conn.port, target.target_number, 3, cc)?;
    zero_ndef_area(&mut *conn.port, target.target_number, capacity_bytes)?;

    Ok(())
}

/// Clear an already-formatted Ultralight/NTAG card's NDEF content, leaving the Capability
/// Container (and thus the tag's NDEF-formatted status) untouched: zeros the whole NDEF data
/// area the existing CC declares (see [`zero_ndef_area`]), without touching page3 itself.
/// Requires an existing CC, same precondition as [`write_ndef`] — a tag that was never formatted
/// has nothing to erase; it should be formatted instead.
pub fn erase_ntag(
    session: &SharedSession,
    expected_uid: Option<&str>,
    password: Option<&str>,
) -> Result<(), Pn532Error> {
    let pwd = password.map(parse_password_hex).transpose()?;

    let mut guard = session.lock().expect("pn532 session mutex poisoned");
    let conn = guard.as_mut().ok_or(Pn532Error::NotConnected)?;
    let target = select_ntag_for_erase_or_format(conn, expected_uid, pwd, "erase")?;

    let cc_page = ntag_read_page(&mut *conn.port, target.target_number, 3)?;
    let cc = ndef::parse_capability_container(&cc_page).ok_or_else(|| {
        Pn532Error::InvalidFrame(
            "This tag doesn't have a Capability Container yet (not formatted); nothing to erase".into(),
        )
    })?;

    zero_ndef_area(&mut *conn.port, target.target_number, cc.capacity_bytes)?;

    Ok(())
}
