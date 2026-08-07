use crate::pn532::error::Pn532Error;
use crate::pn532::ndef::{self, CapabilityContainer, NdefRecordInfo};
use crate::pn532::probe::Pn532Info;
use crate::pn532::protocol::{
    self, CMD_GET_FIRMWARE_VERSION, CMD_IN_DATA_EXCHANGE, CMD_IN_LIST_PASSIVE_TARGET,
    CMD_RF_CONFIGURATION, CMD_SAM_CONFIGURATION,
};
use serde::{Deserialize, Serialize};
use serialport::SerialPort;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Type 2 Tag (Ultralight/NTAG family) commands, all passed through to the card via
/// InDataExchange.
const NTAG_CMD_GET_VERSION: u8 = 0x60;
const NTAG_CMD_READ: u8 = 0x30;
const NTAG_CMD_WRITE: u8 = 0xA2;
/// Password verification: on success the card replies with a 2-byte PACK, on a wrong password
/// the card just NAKs (which shows up in InDataExchange as a non-0x00 status byte) — same
/// failure-detection pattern as every other read/write.
const NTAG_CMD_PWD_AUTH: u8 = 0x1B;

/// MIFARE Classic authenticate/read-block commands. READ shares the same byte value as Type 2
/// Tag's READ (0x30), but the semantics differ: here one call returns exactly 1 block (16
/// bytes), not 4 pages.
const MIFARE_CMD_AUTH_A: u8 = 0x60;
const MIFARE_CMD_AUTH_B: u8 = 0x61;
const MIFARE_CMD_READ: u8 = 0x30;
/// Not the same byte as NTAG's WRITE — Classic writes a block with 0xA0, NTAG writes a page
/// with 0xA2.
const MIFARE_CMD_WRITE: u8 = 0xA0;

/// Publicly known MIFARE Classic factory/common default keys (the same dictionary shipped with
/// libnfc, Proxmark3, MFOC, etc). Most cards that never had their keys changed will already
/// pass on the very first one, FFFFFFFFFFFF.
const DEFAULT_KEYS: &[[u8; 6]] = &[
    [0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF],
    [0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5],
    [0xD3, 0xF7, 0xD3, 0xF7, 0xD3, 0xF7],
    [0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
    [0xB0, 0xB1, 0xB2, 0xB3, 0xB4, 0xB5],
    [0x4B, 0x0B, 0x20, 0x10, 0x7C, 0xCB],
    [0x71, 0x4C, 0x5C, 0x88, 0x6E, 0x97],
    [0x58, 0x7E, 0xE5, 0xF9, 0x35, 0x0F],
    [0xA0, 0x47, 0x8C, 0xC3, 0x90, 0x91],
    [0x53, 0x3C, 0xB6, 0xC7, 0x23, 0xF6],
    [0x8F, 0xD0, 0xA4, 0xF2, 0x56, 0xE9],
];

/// Total sector count follows the SAK: 1K=16 sectors, 4K=40 sectors, Mini=5 sectors. 4K/Mini
/// hardware hasn't actually been tested — these two are computed from the publicly documented
/// sector layout, correctness on real hardware isn't guaranteed.
fn classic_sector_count(sak: u8) -> u8 {
    match sak {
        0x09 => 5,  // MIFARE Mini
        0x18 => 40, // MIFARE Classic 4K
        _ => 16,    // MIFARE Classic 1K (0x08) and other compatible cards with bit3 set
    }
}

/// The first 32 sectors have 4 blocks each; from sector 32 onward it's 16 blocks each (only 4K
/// cards ever reach this range).
fn classic_blocks_in_sector(sector: u8) -> u8 {
    if sector < 32 {
        4
    } else {
        16
    }
}

fn classic_first_block_of_sector(sector: u8) -> u8 {
    if sector < 32 {
        sector * 4
    } else {
        32 * 4 + (sector - 32) * 16
    }
}

/// One READ returns 4 pages (16 bytes). Safety cap: when the model is unknown (GET_VERSION
/// failed), the only way to tell reading is done is to hit a NAK, so this hard-caps the page
/// count to guard against an infinite loop if the card misbehaves.
const MAX_DUMP_PAGES: u16 = 256;

/// The currently open connection, wrapped in `Arc<Mutex<..>>` as Tauri managed state, so an
/// async command can clone out a `'static` handle to hand off to `spawn_blocking` without
/// holding a borrow on some Tauri State for the whole life of the connection.
pub type SharedSession = Arc<Mutex<Option<OpenConnection>>>;

/// Some Windows USB-to-serial drivers' timeouts aren't fully reliable — `read_exact` can
/// genuinely wedge and never return, and whichever blocking thread is holding it then holds the
/// inner `SharedSession` lock forever. If "disconnect" went through that same lock, it would
/// wedge right along with it — the root cause of users hitting "operation timed out" and then
/// not even being able to disconnect afterward.
///
/// This outer shell exists to avoid exactly that: the outer lock on `SessionSlot` only ever
/// protects "which `SharedSession` is current right now" — it never does real serial I/O inside
/// the lock, so it can never wedge. Disconnecting just points the outer shell at a brand new,
/// empty `SharedSession`, regardless of whether the old one is wedged — if some stuck thread is
/// still holding that old `Arc`, let it keep holding it (that thread and its serial handle just
/// leak there; there's no safe way to forcibly interrupt a blocked syscall anyway), but at least
/// the rest of the app immediately becomes usable again, and the user can reconnect without
/// restarting the whole program.
pub type SessionSlot = Arc<Mutex<SharedSession>>;

/// Clone out the "current" `SharedSession` from the shell (just an `Arc` refcount bump,
/// instantaneous, never dragged down by a possibly-wedged inner connection).
pub fn current_session(slot: &SessionSlot) -> SharedSession {
    slot.lock().expect("session slot mutex poisoned").clone()
}

pub struct OpenConnection {
    pub port_name: String,
    /// A GetFirmwareVersion fetched fresh, at connect time, over this already-open port. It's
    /// the same command and same data as the info shown in the "device" page's scan-result
    /// picker, except this copy is guaranteed to be present — whether or not this particular
    /// connection actually came from that picker (e.g. a connection restored right after an
    /// app restart).
    pub firmware: Pn532Info,
    port: Box<dyn SerialPort>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CardInfo {
    pub uid: String,
    pub sens_res: String,
    pub sel_res: String,
    /// A card-type description derived from the SAK, e.g. "Mifare Classic 1K".
    pub card_type: String,
    /// Only present for the Ultralight/NTAG family, and only once GET_VERSION succeeds, e.g.
    /// "NTAG215".
    pub chip_model: Option<String>,
    /// Same conditions as above — the matching user-memory-size description.
    pub memory_size: Option<String>,
}

/// Roughly classify the card type from its SAK (SEL_RES). These values are well-established
/// codes in the ISO14443-3/Mifare ecosystem, not guessed: 0x08/0x18 are Mifare Classic 1K/4K,
/// bit5 (0x20) set means ISO14443-4 compliant (smart-card class, e.g. DESFire/JCOP), and
/// SAK=0x00 is the Mifare Ultralight/NTAG family of Type 2 Tags.
fn classify_card(sak: u8) -> String {
    if sak & 0x08 != 0 {
        match sak {
            0x08 => "MIFARE Classic 1K".to_string(),
            0x18 => "MIFARE Classic 4K".to_string(),
            0x09 => "MIFARE Mini".to_string(),
            _ => format!("MIFARE Classic compatible (SAK=0x{sak:02X})"),
        }
    } else if sak & 0x20 != 0 {
        format!("ISO14443-4 compatible smart card (SAK=0x{sak:02X})")
    } else if sak == 0x00 {
        "MIFARE Ultralight / NTAG family".to_string()
    } else {
        format!("Unknown type (SAK=0x{sak:02X})")
    }
}

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
}

// Card-related commands (InListPassiveTarget/InDataExchange) have to wait for the PN532 to
// finish a full round of RF communication before responding, which takes much longer than a
// pure host command (like GetFirmwareVersion during probing). Setting the timeout too short
// means giving up prematurely on a response that was still legitimately in flight — see the
// comment on clearing the input buffer in protocol.rs.
const CONNECT_TIMEOUT: Duration = Duration::from_millis(1000);

/// Open the serial port and immediately send SAMConfiguration to enter normal mode; on success
/// this swaps in a **brand new** `SharedSession` (not a reused one) — regardless of whether the
/// old connection was healthy or wedged, it's simply discarded, and the new connection starts
/// from a clean state instead of risking getting dragged down by a thread the old connection
/// may have left stuck.
pub fn connect(slot: &SessionSlot, port_name: &str, baud_rate: u32) -> Result<(), Pn532Error> {
    let mut port = serialport::new(port_name, baud_rate)
        .timeout(CONNECT_TIMEOUT)
        .open()?;

    // Right after a cold boot or waking from low-power, the first command occasionally just
    // gets swallowed by the PN532 (it arrives before the wake-up has actually finished) — one
    // failure doesn't mean it's genuinely unreachable, so retry once before giving up.
    // Mode=0x01(normal), Timeout=0x14(20*50ms), IRQ=0x01
    let first_attempt = protocol::wake_up(&mut *port)
        .and_then(|()| protocol::send_command(&mut *port, CMD_SAM_CONFIGURATION, &[0x01, 0x14, 0x01]));
    if first_attempt.is_err() {
        protocol::wake_up(&mut *port)?;
        protocol::send_command(&mut *port, CMD_SAM_CONFIGURATION, &[0x01, 0x14, 0x01])?;
    }

    // Explicitly pin down InListPassiveTarget's retry count (CfgItem=0x05 MaxRetries:
    // [MxRtyATR, MxRtyPSL, MxRtyPassiveActivation]) instead of relying on the PN532's factory
    // default — different batches/clone boards don't agree on a default retry policy, and some
    // default to retrying indefinitely. This app polls InListPassiveTarget every 500ms and
    // expects an immediate NbTg=0 when there's no card, so MxRtyPassiveActivation has to be
    // pinned to 0x01 (try once, return immediately) — can't just hope every board happens to
    // ship with that default.
    protocol::send_command(&mut *port, CMD_RF_CONFIGURATION, &[0x05, 0xFF, 0x01, 0x01])?;

    // The "device" page's connected state needs to show the PN532's own info (chip/firmware
    // version), not just info about a USB-to-serial chip like the CH340 — that comes from the
    // OS querying the serial descriptor, and has nothing to do with whether what's actually
    // behind the port is a PN532, let alone which version. Ask once here while the port is
    // already open, so this doesn't depend on "was there a scan before this connect" — a
    // connection restored right after an app restart gets it just the same.
    let fw = protocol::send_command(&mut *port, CMD_GET_FIRMWARE_VERSION, &[])?;
    if fw.len() < 4 {
        return Err(Pn532Error::InvalidFrame(
            "firmware version response too short".into(),
        ));
    }
    let firmware = Pn532Info {
        port_name: port_name.to_string(),
        ic: fw[0],
        version: fw[1],
        revision: fw[2],
        support: fw[3],
        friendly_name: None,
    };

    let new_session: SharedSession = Arc::new(Mutex::new(Some(OpenConnection {
        port_name: port_name.to_string(),
        firmware,
        port,
    })));
    let mut guard = slot.lock().expect("session slot mutex poisoned");
    *guard = new_session;
    Ok(())
}

/// Swap the slot for a brand new, empty `SharedSession` without touching the old one — if the
/// old connection was wedged, this still lets "disconnect" succeed instantly instead of
/// wedging right along with it.
pub fn disconnect(slot: &SessionSlot) {
    let mut guard = slot.lock().expect("session slot mutex poisoned");
    *guard = SharedSession::default();
}

pub fn status(slot: &SessionSlot) -> Option<String> {
    let session = current_session(slot);
    let guard = session.lock().expect("pn532 session mutex poisoned");
    guard.as_ref().map(|c| c.port_name.clone())
}

/// The PN532 firmware info fetched fresh at connect time. Pure in-memory read, never touches
/// the serial port, safe to call at any time.
pub fn device_info(slot: &SessionSlot) -> Option<Pn532Info> {
    let session = current_session(slot);
    let guard = session.lock().expect("pn532 session mutex poisoned");
    guard.as_ref().map(|c| c.firmware.clone())
}

struct SelectedTarget {
    target_number: u8,
    uid: Vec<u8>,
    sens_res: [u8; 2],
    sak: u8,
}

/// Send one InListPassiveTarget. No card isn't an error, it returns `Ok(None)`.
fn select_target(port: &mut dyn SerialPort) -> Result<Option<SelectedTarget>, Pn532Error> {
    // MaxTg=1, BrTy=0x00 (106 kbps type A / ISO14443A)
    let data = protocol::send_command(port, CMD_IN_LIST_PASSIVE_TARGET, &[0x01, 0x00])?;

    let nb_targets = *data
        .first()
        .ok_or_else(|| Pn532Error::InvalidFrame("empty InListPassiveTarget response".into()))?;
    if nb_targets == 0 {
        return Ok(None);
    }

    // [NbTg, Tg, SENS_RES(2), SEL_RES, NFCIDLength, NFCID...]
    if data.len() < 6 {
        return Err(Pn532Error::InvalidFrame(
            "InListPassiveTarget response too short".into(),
        ));
    }
    let uid_len = data[5] as usize;
    if data.len() < 6 + uid_len {
        return Err(Pn532Error::InvalidFrame(
            "InListPassiveTarget UID truncated".into(),
        ));
    }

    Ok(Some(SelectedTarget {
        target_number: data[1],
        sens_res: [data[2], data[3]],
        sak: data[4],
        uid: data[6..6 + uid_len].to_vec(),
    }))
}

/// GET_VERSION is only supported by the Ultralight/NTAG family (original Ultralight excepted)
/// — Classic cards don't recognize this command; if the card doesn't know it, this just fails
/// quietly, only losing the model detail. There's a small retry here — an occasional flaky
/// antenna hiccup shouldn't get a genuine NTAG misclassified as "model unknown" (especially now
/// that the password-protection feature directly depends on model detection: a misclassification
/// there goes from "missing model detail" to "the whole feature is unusable").
fn probe_ntag_version(
    port: &mut dyn SerialPort,
    target_number: u8,
    sak: u8,
) -> (Option<String>, Option<String>) {
    if sak != 0x00 {
        return (None, None);
    }
    match send_with_retry(
        port,
        CMD_IN_DATA_EXCHANGE,
        &[target_number, NTAG_CMD_GET_VERSION],
        2,
    ) {
        Ok(resp) if resp.first() == Some(&0x00) => decode_ntag_version(&resp[1..]),
        _ => (None, None),
    }
}

/// Send one InListPassiveTarget to probe whether a card is currently on the antenna. No card
/// isn't an error, it returns `Ok(None)`.
///
/// Deliberately doesn't check GET_VERSION here: this function is polled by the frontend every
/// 500ms, and if a card is slow or unresponsive to GET_VERSION, every single poll would burn
/// close to the timeout limit on it, and polling would fall behind the rate requests pile up
/// at, backing up every other command on this connection (including "disconnect") behind it.
/// The model is non-realtime info and it's enough for [`dump_memory`] to look it up once when a
/// new card is detected.
pub fn read_card(session: &SharedSession) -> Result<Option<CardInfo>, Pn532Error> {
    let mut guard = session.lock().expect("pn532 session mutex poisoned");
    let conn = guard.as_mut().ok_or(Pn532Error::NotConnected)?;

    let Some(target) = select_target(&mut *conn.port)? else {
        return Ok(None);
    };

    Ok(Some(CardInfo {
        uid: hex::encode(&target.uid).to_uppercase(),
        sens_res: hex::encode(target.sens_res).to_uppercase(),
        sel_res: hex::encode([target.sak]).to_uppercase(),
        card_type: classify_card(target.sak),
        chip_model: None,
        memory_size: None,
    }))
}

/// Read the card's complete raw memory (currently only the Ultralight/NTAG family is
/// supported; Mifare Classic needs per-sector key authentication first, which isn't implemented
/// here yet). No card returns `Ok(None)`; if a card is present but isn't Ultralight/NTAG,
/// `pages` is empty while `card_type`/`uid` are still valid.
pub fn dump_memory(session: &SharedSession) -> Result<Option<MemoryDump>, Pn532Error> {
    let mut guard = session.lock().expect("pn532 session mutex poisoned");
    let conn = guard.as_mut().ok_or(Pn532Error::NotConnected)?;

    let Some(target) = select_target(&mut *conn.port)? else {
        return Ok(None);
    };
    let (chip_model, memory_size) =
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
            let result = send_with_retry(
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

    Ok(Some(MemoryDump {
        uid: hex::encode(&target.uid).to_uppercase(),
        card_type: classify_card(target.sak),
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
/// this shouldn't make that call on the user's behalf. 504/888 bytes have no known
/// same-capacity ambiguity.
fn guess_chip_model_from_cc_capacity(capacity_bytes: u32) -> Option<String> {
    match capacity_bytes {
        144 => Some("NTAG213 or MIFARE Ultralight C".into()),
        504 => Some("NTAG215".into()),
        888 => Some("NTAG216".into()),
        _ => None,
    }
}

/// The InDataExchange round trip with a card occasionally fails once due to unstable coupling
/// or transient interference (not the kind that reproduces every time) — retry a few times on
/// the key single-step operations before giving up, instead of erroring out on the first
/// hiccup.
fn send_with_retry(
    port: &mut dyn SerialPort,
    cmd: u8,
    params: &[u8],
    attempts: u32,
) -> Result<Vec<u8>, Pn532Error> {
    let mut last_err = None;
    for _ in 0..attempts {
        match protocol::send_command(port, cmd, params) {
            Ok(resp) => return Ok(resp),
            Err(e) => last_err = Some(e),
        }
    }
    Err(last_err.expect("attempts is always >= 1"))
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
fn pwd_auth(
    port: &mut dyn SerialPort,
    target_number: u8,
    password: [u8; 4],
) -> Result<bool, Pn532Error> {
    let mut params = vec![target_number, NTAG_CMD_PWD_AUTH];
    params.extend_from_slice(&password);
    let resp = protocol::send_command(port, CMD_IN_DATA_EXCHANGE, &params)?;
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
    let resp = send_with_retry(port, CMD_IN_DATA_EXCHANGE, &params, 3)?;
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
    let resp = send_with_retry(port, CMD_IN_DATA_EXCHANGE, &[target_number, NTAG_CMD_READ, page], 3)?;
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
    let Some(target) = select_target(&mut *conn.port)? else {
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

    let (chip_model, _) = probe_ntag_version(&mut *conn.port, target.target_number, target.sak);
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
/// `current_password` first — a failed check aborts immediately without touching any data.
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
        if !pwd_auth(&mut *conn.port, target.target_number, current)? {
            return Err(Pn532Error::InvalidFrame("Current password is incorrect".into()));
        }
    }

    ntag_write_page(&mut *conn.port, target.target_number, pwd_page, new_pwd)?;
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
pub fn clear_ntag_password(
    session: &SharedSession,
    expected_uid: &str,
    current_password: &str,
) -> Result<(), Pn532Error> {
    let current = parse_password_hex(current_password)?;

    let mut guard = session.lock().expect("pn532 session mutex poisoned");
    let conn = guard.as_mut().ok_or(Pn532Error::NotConnected)?;
    let (target, (cfg0_page, ..)) = select_ntag_for_password_op(conn, expected_uid)?;

    if !pwd_auth(&mut *conn.port, target.target_number, current)? {
        return Err(Pn532Error::InvalidFrame("Current password is incorrect".into()));
    }

    let mut cfg0 = ntag_read_page(&mut *conn.port, target.target_number, cfg0_page)?;
    cfg0[3] = 0xFF;
    ntag_write_page(&mut *conn.port, target.target_number, cfg0_page, cfg0)?;

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

    let Some(target) = select_target(&mut *conn.port)? else {
        return Ok(None);
    };
    if target.sak != 0x00 {
        return Ok(None);
    }
    let (chip_model, _) = probe_ntag_version(&mut *conn.port, target.target_number, target.sak);
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

/// Pure debugging tool: select a card once, then send whatever hex bytes the caller provided
/// verbatim as the InDataExchange parameters, and return the response verbatim as hex too — no
/// parsing or "is the response code right" checking of any kind. Used to manually probe whether
/// a card recognizes a given command (e.g. PWD_AUTH `1B`, or Ultralight C's AUTHENTICATE
/// `1A`). Whether it succeeds or fails, the full raw frame is already logged to `pn532::frame`
/// via `protocol::send_command` (visible in the Dev panel's "frame" tab) — this additionally
/// returns the response content directly to the frontend for display, for easy side-by-side
/// comparison.
pub fn send_raw_data_exchange(session: &SharedSession, params_hex: &str) -> Result<String, Pn532Error> {
    let params = hex::decode(params_hex.trim())
        .map_err(|_| Pn532Error::InvalidFrame("Parameters aren't a valid hex string".into()))?;

    let mut guard = session.lock().expect("pn532 session mutex poisoned");
    let conn = guard.as_mut().ok_or(Pn532Error::NotConnected)?;

    if select_target(&mut *conn.port)?.is_none() {
        return Err(Pn532Error::NoCardPresent);
    }

    let resp = protocol::send_command(&mut *conn.port, CMD_IN_DATA_EXCHANGE, &params)?;
    Ok(hex::encode(&resp).to_uppercase())
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

    let Some(target) = select_target(&mut *conn.port)? else {
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

    // Reading from page0 conveniently also reads back page3 (the Capability Container).
    let read_resp = send_with_retry(
        &mut *conn.port,
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
    tlv.extend_from_slice(&message);
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
        let resp = send_with_retry(&mut *conn.port, CMD_IN_DATA_EXCHANGE, &params, 3)?;
        if resp.first() != Some(&0x00) {
            return Err(Pn532Error::InvalidFrame(format!("Failed to write page {page}")));
        }
    }

    Ok(())
}

/// Try to authenticate the sector a given block belongs to, using the supplied key. The PN532
/// handles the Crypto1 handshake itself once it receives this command — all this cares about is
/// what to send and whether the result is 0x00 (success).
fn mifare_authenticate(
    port: &mut dyn SerialPort,
    target_number: u8,
    uid: &[u8],
    block: u8,
    key: &[u8; 6],
    key_type: u8,
) -> Result<bool, Pn532Error> {
    let mut params = vec![target_number, key_type, block];
    params.extend_from_slice(key);
    params.extend_from_slice(uid);
    let resp = protocol::send_command(port, CMD_IN_DATA_EXCHANGE, &params)?;
    Ok(resp.first() == Some(&0x00))
}

#[derive(Debug, Clone, Serialize)]
pub struct ClassicBlock {
    pub block: u8,
    pub hex: String,
    /// The last block in a sector is the "sector trailer", holding Key A/access bits/Key B —
    /// not ordinary data.
    pub is_trailer: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClassicSectorInfo {
    pub sector: u8,
    pub first_block: u8,
    pub block_count: u8,
    /// The key that worked; `None` means authentication failed — doesn't mean the card is
    /// broken, just that the key isn't in the built-in dictionary.
    pub key: Option<String>,
    pub key_type: Option<String>,
    /// Empty when authentication failed; if authentication succeeded but an individual block
    /// failed to read, that block just doesn't show up here (one unreadable block doesn't make
    /// the whole sector unreadable).
    pub blocks: Vec<ClassicBlock>,
}

/// Authenticate and read the contents of one MIFARE Classic sector. Tries Key A then Key B
/// from the built-in dictionary in turn, and uses whichever one works. No card returns
/// `Ok(None)`; a non-Classic card is an error; a sector number beyond this card's actual sector
/// count is also an error. The frontend calls this once per sector and shows results live as
/// they come in, without waiting for all 16 sectors to finish.
pub fn read_classic_sector(
    session: &SharedSession,
    sector: u8,
) -> Result<Option<ClassicSectorInfo>, Pn532Error> {
    let mut guard = session.lock().expect("pn532 session mutex poisoned");
    let conn = guard.as_mut().ok_or(Pn532Error::NotConnected)?;

    let Some(target) = select_target(&mut *conn.port)? else {
        return Ok(None);
    };
    if target.sak & 0x08 == 0 {
        return Err(Pn532Error::InvalidFrame(
            "The current card isn't a MIFARE Classic type; this read method isn't supported yet".into(),
        ));
    }
    let sector_count = classic_sector_count(target.sak);
    if sector >= sector_count {
        return Err(Pn532Error::InvalidFrame(format!(
            "Sector {sector} is out of range (this card has {sector_count} sectors total)"
        )));
    }

    let first_block = classic_first_block_of_sector(sector);
    let block_count = classic_blocks_in_sector(sector);

    let mut found_key: Option<([u8; 6], &'static str)> = None;
    'search: for key in DEFAULT_KEYS {
        for (key_type, key_type_name) in [(MIFARE_CMD_AUTH_A, "A"), (MIFARE_CMD_AUTH_B, "B")] {
            if mifare_authenticate(
                &mut *conn.port,
                target.target_number,
                &target.uid,
                first_block,
                key,
                key_type,
            )? {
                found_key = Some((*key, key_type_name));
                break 'search;
            }
        }
    }

    let Some((key, key_type_name)) = found_key else {
        return Ok(Some(ClassicSectorInfo {
            sector,
            first_block,
            block_count,
            key: None,
            key_type: None,
            blocks: Vec::new(),
        }));
    };

    let mut blocks = Vec::new();
    for offset in 0..block_count {
        let block = first_block + offset;
        let result = send_with_retry(
            &mut *conn.port,
            CMD_IN_DATA_EXCHANGE,
            &[target.target_number, MIFARE_CMD_READ, block],
            2,
        );
        let Ok(resp) = result else { continue };
        if resp.first() != Some(&0x00) || resp.len() < 17 {
            continue; // Skip a block that fails to read instead of invalidating the whole sector over it.
        }
        blocks.push(ClassicBlock {
            block,
            hex: hex::encode(&resp[1..17]).to_uppercase(),
            is_trailer: offset == block_count - 1,
        });
    }

    Ok(Some(ClassicSectorInfo {
        sector,
        first_block,
        block_count,
        key: Some(hex::encode(key).to_uppercase()),
        key_type: Some(key_type_name.to_string()),
        blocks,
    }))
}

fn hex_to_key(s: &str) -> Option<[u8; 6]> {
    hex::decode(s).ok()?.try_into().ok()
}

#[derive(Debug, Clone, Deserialize)]
pub struct ClassicBlockData {
    pub block: u8,
    pub hex: String,
    pub is_trailer: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ClassicSectorData {
    pub sector: u8,
    pub key: String,
    pub key_type: String,
    pub blocks: Vec<ClassicBlockData>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClassicCopyResult {
    pub target_uid: String,
    /// Only succeeds on gen2/CUID-style "magic" cards where block0 can be written directly
    /// after authenticating; a genuine card's block0 is write-protected at the hardware level,
    /// so the write attempt is simply refused by the card — that's expected, not a bug. gen1a
    /// magic cards that need a backdoor unlock command aren't recognized here either, so this
    /// will also be `false` for those.
    pub uid_cloned: bool,
    pub sectors_written: Vec<u8>,
    pub sectors_failed: Vec<u8>,
}

/// Write the data previously read while scanning a source card onto a target card. The UID
/// (block 0) is also given a write attempt as a courtesy, and whether it actually succeeded is
/// reported honestly; each sector's data blocks (excluding the trailer — the target card's
/// existing keys/access bits are left untouched) are written by authenticating the matching
/// sector on the target card with whichever key worked for the source card at scan time — if
/// authentication fails, or the key format is invalid, that sector is skipped without affecting
/// the others.
pub fn copy_classic_card(
    session: &SharedSession,
    source_uid: &str,
    sectors: &[ClassicSectorData],
) -> Result<ClassicCopyResult, Pn532Error> {
    let mut guard = session.lock().expect("pn532 session mutex poisoned");
    let conn = guard.as_mut().ok_or(Pn532Error::NotConnected)?;

    // Only this one card selection is used to confirm the target card's identity (type, UID
    // sanity check); every authentication below reselects the target via `select_target` again,
    // rather than reusing this `target_number` — repeatedly authenticating different sectors
    // within a single card selection isn't reliable enough, the same reasoning as
    // `read_classic_sector` reselecting the card for every sector. This was learned the hard
    // way: authenticating multiple sectors in a row within one card selection was observed in
    // practice to have an earlier authentication poison the later ones, causing everything
    // after it to fail.
    let Some(target) = select_target(&mut *conn.port)? else {
        return Err(Pn532Error::NoCardPresent);
    };
    if target.sak & 0x08 == 0 {
        return Err(Pn532Error::InvalidFrame(
            "The target card isn't a MIFARE Classic type".into(),
        ));
    }
    let target_uid = hex::encode(&target.uid).to_uppercase();
    if target_uid == source_uid.to_uppercase() {
        return Err(Pn532Error::InvalidFrame(
            "The card detected is still the source card itself (same UID) — swap in the target card and try again".into(),
        ));
    }

    // Attempt to clone the UID: reselect the card, try Key A/Key B from the default dictionary
    // in turn to authenticate sector 0, and on success read block0 once, swap the UID/BCC for
    // the source card's, keep the remaining bytes (SAK/ATQA/vendor-custom data) exactly as the
    // target card had them, and write it back.
    let source_uid_bytes = hex::decode(source_uid).unwrap_or_default();
    let mut uid_cloned = false;
    if source_uid_bytes.len() == target.uid.len() {
        if let Some(t) = select_target(&mut *conn.port)? {
            'search: for key in DEFAULT_KEYS {
                for key_type in [MIFARE_CMD_AUTH_A, MIFARE_CMD_AUTH_B] {
                    let authed = mifare_authenticate(
                        &mut *conn.port,
                        t.target_number,
                        &t.uid,
                        0,
                        key,
                        key_type,
                    )?;
                    if !authed {
                        continue;
                    }
                    if let Ok(read_resp) = protocol::send_command(
                        &mut *conn.port,
                        CMD_IN_DATA_EXCHANGE,
                        &[t.target_number, MIFARE_CMD_READ, 0],
                    ) {
                        if read_resp.first() == Some(&0x00) && read_resp.len() >= 17 {
                            let mut block0 = read_resp[1..17].to_vec();
                            block0[..4].copy_from_slice(&source_uid_bytes[..4]);
                            block0[4] =
                                source_uid_bytes[..4].iter().fold(0u8, |a, b| a ^ b);
                            let mut params = vec![t.target_number, MIFARE_CMD_WRITE, 0u8];
                            params.extend_from_slice(&block0);
                            if let Ok(resp) = protocol::send_command(
                                &mut *conn.port,
                                CMD_IN_DATA_EXCHANGE,
                                &params,
                            ) {
                                uid_cloned = resp.first() == Some(&0x00);
                            }
                        }
                    }
                    break 'search;
                }
            }
        }
    }

    let mut sectors_written = Vec::new();
    let mut sectors_failed = Vec::new();
    for sector_data in sectors {
        let Some(key) = hex_to_key(&sector_data.key) else {
            sectors_failed.push(sector_data.sector);
            continue;
        };
        let key_type = if sector_data.key_type == "B" {
            MIFARE_CMD_AUTH_B
        } else {
            MIFARE_CMD_AUTH_A
        };
        let first_block = classic_first_block_of_sector(sector_data.sector);

        // Reselect the card before authenticating each sector — see the comment at the top of
        // this function for why.
        let Some(t) = select_target(&mut *conn.port)? else {
            sectors_failed.push(sector_data.sector);
            continue;
        };
        let authed = mifare_authenticate(
            &mut *conn.port,
            t.target_number,
            &t.uid,
            first_block,
            &key,
            key_type,
        )?;
        if !authed {
            sectors_failed.push(sector_data.sector);
            continue;
        }

        let mut all_ok = true;
        for block_data in &sector_data.blocks {
            if block_data.is_trailer {
                continue; // Don't touch the sector trailer — keep the target card's existing keys/access bits.
            }
            let Ok(bytes) = hex::decode(&block_data.hex) else {
                all_ok = false;
                continue;
            };
            if bytes.len() != 16 {
                all_ok = false;
                continue;
            }
            let mut params = vec![t.target_number, MIFARE_CMD_WRITE, block_data.block];
            params.extend_from_slice(&bytes);
            match send_with_retry(&mut *conn.port, CMD_IN_DATA_EXCHANGE, &params, 2) {
                Ok(resp) if resp.first() == Some(&0x00) => {}
                _ => all_ok = false,
            }
        }

        if all_ok {
            sectors_written.push(sector_data.sector);
        } else {
            sectors_failed.push(sector_data.sector);
        }
    }

    Ok(ClassicCopyResult {
        target_uid,
        uid_cloned,
        sectors_written,
        sectors_failed,
    })
}
