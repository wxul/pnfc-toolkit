use crate::pn532::error::Pn532Error;
use crate::pn532::probe::Pn532Info;
use crate::pn532::protocol::{
    self, CMD_GET_FIRMWARE_VERSION, CMD_IN_LIST_PASSIVE_TARGET, CMD_RF_CONFIGURATION,
    CMD_SAM_CONFIGURATION,
};
use serde::Serialize;
use serialport::SerialPort;
use std::sync::{Arc, Mutex};
use std::time::Duration;

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
    /// `pub(crate)`, not private — the tag-family modules (`pn532::tags::*`) need direct access
    /// to drive the port themselves via `select_target`/`send_with_retry` below, since all the
    /// actual NTAG21x/MIFARE Classic protocol logic lives there now, not in this module.
    pub(crate) port: Box<dyn SerialPort>,
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
///
/// `pub(crate)` so `pn532::tags::ntag21x::dump_memory` can reuse it for `MemoryDump::card_type`
/// instead of duplicating this classification.
pub(crate) fn classify_card(sak: u8) -> String {
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

/// `pub(crate)`, along with its fields — the tag-family modules need to read `target_number`/
/// `uid`/`sak` (and occasionally `sens_res`) once they've selected a card themselves.
pub(crate) struct SelectedTarget {
    pub(crate) target_number: u8,
    pub(crate) uid: Vec<u8>,
    #[allow(dead_code)] // Read by CardInfo construction in `read_card`, not by every caller.
    pub(crate) sens_res: [u8; 2],
    pub(crate) sak: u8,
}

/// Send one InListPassiveTarget. No card isn't an error, it returns `Ok(None)`. `pub(crate)` —
/// this is the generic ISO14443-3A "pick a target" step, shared by every tag-family operation
/// in `pn532::tags`, not just this module's own `read_card`.
pub(crate) fn select_target(port: &mut dyn SerialPort) -> Result<Option<SelectedTarget>, Pn532Error> {
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

/// Send one InListPassiveTarget to probe whether a card is currently on the antenna. No card
/// isn't an error, it returns `Ok(None)`.
///
/// Deliberately doesn't check GET_VERSION here: this function is polled by the frontend every
/// 500ms, and if a card is slow or unresponsive to GET_VERSION, every single poll would burn
/// close to the timeout limit on it, and polling would fall behind the rate requests pile up
/// at, backing up every other command on this connection (including "disconnect") behind it.
/// The model is non-realtime info and it's enough for `pn532::tags::ntag21x::dump_memory` to
/// look it up once when a new card is detected.
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

/// The InDataExchange/InCommunicateThru round trip with a card occasionally fails once due to
/// unstable coupling or transient interference (not the kind that reproduces every time) —
/// retry a few times on the key single-step operations before giving up, instead of erroring out
/// on the first hiccup.
///
/// Retries on two different kinds of failure: a hard communication error from `send_command`
/// (corrupted/misaligned frame — see `protocol::send_command`), and a well-formed reply whose
/// exchange status byte isn't `0x00` (the frame itself is fine, but the target didn't answer in
/// time). The second case used to return immediately after the very first attempt without
/// actually using the rest of the retry budget — every caller here already re-checks
/// `resp.first() == Some(&0x00)` on the result regardless, so this was silently only ever trying
/// once for that failure mode. In practice that let one transient hiccup abort a multi-step
/// operation partway through (e.g. a password change: PWD and PACK already rewritten, then a
/// single flaky read of the AUTH0 config page aborts the whole thing) instead of quietly
/// recovering on a second try like the hard-error case already did.
///
/// `pub(crate)` — shared by every tag-family operation in `pn532::tags`, not just this module.
pub(crate) fn send_with_retry(
    port: &mut dyn SerialPort,
    cmd: u8,
    params: &[u8],
    attempts: u32,
) -> Result<Vec<u8>, Pn532Error> {
    let mut last = None;
    for _ in 0..attempts {
        match protocol::send_command(port, cmd, params) {
            Ok(resp) if resp.first() == Some(&0x00) => return Ok(resp),
            Ok(resp) => last = Some(Ok(resp)),
            Err(e) => last = Some(Err(e)),
        }
    }
    last.expect("attempts is always >= 1")
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

    let resp = protocol::send_command(&mut *conn.port, protocol::CMD_IN_DATA_EXCHANGE, &params)?;
    Ok(hex::encode(&resp).to_uppercase())
}
