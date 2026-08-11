mod geolocation;
mod pn532;

use pn532::session::{CardInfo, SessionSlot};
use pn532::tags::mifare_classic::{ClassicCopyResult, ClassicSectorData, ClassicSectorInfo};
use pn532::tags::ntag21x::{MemoryDump, NdefRecordRequest, PasswordProtection};
use pn532::{Pn532Info, SerialPortSummary};
use std::time::Duration;

// serialport is synchronous blocking I/O (probing a single port can stall for a few hundred ms,
// and scanning has to walk every port one by one). Marking the command functions `async` is only
// there so Tauri doesn't run them on the main thread; the actual escape from blocking is
// `spawn_blocking`, which hands this synchronous work off to a dedicated blocking thread pool so
// it doesn't stall Tauri's async worker threads or the UI.

/// The serial port's read timeout isn't fully reliable on some Windows USB-to-serial drivers —
/// when the underlying transport wedges, `read_exact` can genuinely never return, and the task
/// spawned via `spawn_blocking` just hangs forever. The frontend's `invoke()` then never resolves
/// or rejects, and the UI is stuck on "reading..." with no error shown. This wraps an independent
/// timeout around the `spawn_blocking` call so the user gets a definite failure instead of an
/// infinite spinner. Note this can only make *this particular call* time out — it can't actually
/// interrupt the blocked thread underneath: if the hardware/driver is truly wedged, that call
/// keeps holding the connection's lock until it returns on its own (which may be never), so this
/// is really just "give the user something to act on", not a real fix — when this happens the
/// usual remedy is still to disconnect and reconnect, or unplug/replug the serial adapter.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(8);

async fn run_blocking<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    match tokio::time::timeout(COMMAND_TIMEOUT, tauri::async_runtime::spawn_blocking(f)).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(join_err)) => Err(join_err.to_string()),
        Err(_) => Err(
            "Operation timed out (no response from the serial port for a while); the hardware \
             may be stuck. Try disconnecting and reconnecting."
                .to_string(),
        ),
    }
}

/// List every serial port on the system (with USB VID/PID etc. where available), for the
/// frontend's port dropdown / initial filtering.
#[tauri::command]
async fn list_serial_ports() -> Result<Vec<SerialPortSummary>, String> {
    run_blocking(pn532::list_serial_ports)
        .await?
        .map_err(|e| e.to_string())
}

/// Open the given serial port and send GetFirmwareVersion to confirm a PN532 is actually behind it.
#[tauri::command]
async fn probe_pn532_port(port_name: String, baud_rate: Option<u32>) -> Result<Pn532Info, String> {
    run_blocking(move || {
        pn532::probe_port(&port_name, baud_rate.unwrap_or(pn532::probe::DEFAULT_BAUD_RATE))
    })
    .await?
    .map_err(|e| e.to_string())
}

/// Probe every serial port in turn and return the ones that responded like a real PN532.
#[tauri::command]
async fn scan_pn532(baud_rate: Option<u32>) -> Result<Vec<Pn532Info>, String> {
    run_blocking(move || {
        pn532::scan_for_pn532(baud_rate.unwrap_or(pn532::probe::DEFAULT_BAUD_RATE))
    })
    .await?
    .map_err(|e| e.to_string())
}

/// Open the port and enter normal mode. On success this swaps in a **brand new**
/// [`SessionSlot`] (not a reused one) — subsequent card commands all read the current session
/// from this slot.
#[tauri::command]
async fn connect_pn532(
    session: tauri::State<'_, SessionSlot>,
    port_name: String,
    baud_rate: Option<u32>,
) -> Result<(), String> {
    let slot = session.inner().clone();
    run_blocking(move || {
        pn532::session::connect(
            &slot,
            &port_name,
            baud_rate.unwrap_or(pn532::probe::DEFAULT_BAUD_RATE),
        )
    })
    .await?
    .map_err(|e| e.to_string())
}

/// Swap the slot for a brand new, empty session — regardless of whether the old one was healthy
/// or wedged, this operation itself must never be able to hang (see the comment on
/// [`pn532::session::SessionSlot`]); disconnect has to guarantee that.
#[tauri::command]
async fn disconnect_pn532(session: tauri::State<'_, SessionSlot>) -> Result<(), String> {
    let slot = session.inner().clone();
    run_blocking(move || pn532::session::disconnect(&slot)).await
}

/// Return the currently connected port name (`None` if not connected), so the frontend can
/// resync its state after a refresh/remount.
#[tauri::command]
async fn pn532_status(session: tauri::State<'_, SessionSlot>) -> Result<Option<String>, String> {
    let slot = session.inner().clone();
    run_blocking(move || pn532::session::status(&slot)).await
}

/// Return the PN532 firmware info (chip/version) fetched once at connect time; `None` if not
/// connected. Pure in-memory read, never touches the serial port, safe to call any time — even
/// while another operation is busy reading/writing a card.
#[tauri::command]
async fn pn532_device_info(session: tauri::State<'_, SessionSlot>) -> Result<Option<Pn532Info>, String> {
    let slot = session.inner().clone();
    run_blocking(move || pn532::session::device_info(&slot)).await
}

/// Probe once for whether a card is sitting on the antenna. No card is not an error, it's
/// `Ok(None)` — the frontend polls this command on a fixed interval.
#[tauri::command]
async fn read_card_uid(session: tauri::State<'_, SessionSlot>) -> Result<Option<CardInfo>, String> {
    let current = pn532::session::current_session(&session);
    run_blocking(move || pn532::session::read_card(&current))
        .await?
        .map_err(|e| e.to_string())
}

/// Read the card's full memory (currently only the Ultralight/NTAG family actually reads pages;
/// Classic isn't implemented here). Much slower than `read_card_uid`, only called once when the
/// user explicitly opens the detail view, not part of the polling loop.
#[tauri::command]
async fn dump_card_memory(
    session: tauri::State<'_, SessionSlot>,
) -> Result<Option<MemoryDump>, String> {
    let current = pn532::session::current_session(&session);
    run_blocking(move || pn532::tags::ntag21x::dump_memory(&current))
        .await?
        .map_err(|e| e.to_string())
}

/// Write one or more NDEF records to an Ultralight/NTAG card (multiple records get packed into a
/// single NDEF message). This overwrites whatever was already at page4 onward, so the frontend
/// must confirm with the user before calling this. If `expected_uid` is provided, the UID gets
/// re-checked right before writing — if the card was swapped out after the user clicked "write",
/// this aborts instead of writing to the wrong card. `password` is only needed if the card has
/// write-password protection enabled.
#[tauri::command]
async fn write_ndef(
    session: tauri::State<'_, SessionSlot>,
    records: Vec<NdefRecordRequest>,
    expected_uid: Option<String>,
    password: Option<String>,
) -> Result<(), String> {
    let current = pn532::session::current_session(&session);
    run_blocking(move || {
        pn532::tags::ntag21x::write_ndef(
            &current,
            &records,
            expected_uid.as_deref(),
            password.as_deref(),
        )
    })
    .await?
    .map_err(|e| e.to_string())
}

/// Copy another NTAG/Ultralight card's NDEF content (as raw hex bytes read via
/// `dump_card_memory`) onto whatever card is currently on the reader. Rejects a target that
/// isn't NTAG/Ultralight, or that's still the source card itself (same UID) — the frontend calls
/// this once per new target card placed while the copy flow is open, same shape as
/// `copy_classic_card`.
#[tauri::command]
async fn copy_ntag_card(
    session: tauri::State<'_, SessionSlot>,
    source_uid: String,
    source_message_hex: String,
    password: Option<String>,
) -> Result<(), String> {
    let current = pn532::session::current_session(&session);
    run_blocking(move || {
        pn532::tags::ntag21x::copy_ntag_card(&current, &source_uid, &source_message_hex, password.as_deref())
    })
    .await?
    .map_err(|e| e.to_string())
}

/// Format a blank (or previously-written) Ultralight/NTAG card into NDEF format: writes a fresh
/// Capability Container sized for the detected chip model, plus an empty NDEF message. Only
/// NTAG21x/MIFARE Ultralight cards with an identifiable model are supported — anything else
/// (MIFARE Classic, an unidentifiable model) surfaces as a normal error for the frontend to show.
#[tauri::command]
async fn format_ntag(
    session: tauri::State<'_, SessionSlot>,
    expected_uid: Option<String>,
    password: Option<String>,
) -> Result<(), String> {
    let current = pn532::session::current_session(&session);
    run_blocking(move || {
        pn532::tags::ntag21x::format_ntag(&current, expected_uid.as_deref(), password.as_deref())
    })
    .await?
    .map_err(|e| e.to_string())
}

/// Erase an already-formatted Ultralight/NTAG card's NDEF content (writes an empty NDEF message),
/// leaving its Capability Container untouched. Fails if the card has no Capability Container yet
/// (i.e. was never formatted) — use `format_ntag` for that case instead.
#[tauri::command]
async fn erase_ntag(
    session: tauri::State<'_, SessionSlot>,
    expected_uid: Option<String>,
    password: Option<String>,
) -> Result<(), String> {
    let current = pn532::session::current_session(&session);
    run_blocking(move || {
        pn532::tags::ntag21x::erase_ntag(&current, expected_uid.as_deref(), password.as_deref())
    })
    .await?
    .map_err(|e| e.to_string())
}

/// Set or change the write-password protection on an Ultralight/NTAG card (protects writes only,
/// reads are unaffected). `current_password` is only needed if the card already has protection
/// enabled (i.e. this is a password change); pass `None` for a first-time setup.
#[tauri::command]
async fn set_ntag_password(
    session: tauri::State<'_, SessionSlot>,
    expected_uid: String,
    current_password: Option<String>,
    new_password: String,
) -> Result<(), String> {
    let current = pn532::session::current_session(&session);
    run_blocking(move || {
        pn532::tags::ntag21x::set_ntag_password(
            &current,
            &expected_uid,
            current_password.as_deref(),
            &new_password,
        )
    })
    .await?
    .map_err(|e| e.to_string())
}

/// Remove write-password protection from an Ultralight/NTAG card; requires the current password.
#[tauri::command]
async fn clear_ntag_password(
    session: tauri::State<'_, SessionSlot>,
    expected_uid: String,
    current_password: String,
) -> Result<(), String> {
    let current = pn532::session::current_session(&session);
    run_blocking(move || {
        pn532::tags::ntag21x::clear_ntag_password(&current, &expected_uid, &current_password)
    })
    .await?
    .map_err(|e| e.to_string())
}

/// Read just one page to check the card's current password-protection state — used by the
/// "write" page to decide whether to prompt for a password before actually writing, much faster
/// than a full card dump.
#[tauri::command]
async fn read_ntag_password_status(
    session: tauri::State<'_, SessionSlot>,
) -> Result<Option<PasswordProtection>, String> {
    let current = pn532::session::current_session(&session);
    run_blocking(move || pn532::tags::ntag21x::read_ntag_password_status(&current))
        .await?
        .map_err(|e| e.to_string())
}

/// Debug-only: select a card once, then send `params_hex` (a hex string) verbatim as the
/// InDataExchange parameters, and return the response verbatim as a hex string too. Only used by
/// the Dev panel, for manually probing whether a card understands a given command (e.g. the
/// password-related PWD_AUTH/AUTHENTICATE).
#[tauri::command]
async fn send_raw_data_exchange(
    session: tauri::State<'_, SessionSlot>,
    params_hex: String,
) -> Result<String, String> {
    let current = pn532::session::current_session(&session);
    run_blocking(move || pn532::session::send_raw_data_exchange(&current, &params_hex))
        .await?
        .map_err(|e| e.to_string())
}

/// Authenticate and read one MIFARE Classic sector (tries Key A/Key B from the built-in default
/// key dictionary in turn). The frontend calls this once per sector number and shows results as
/// they come in, without waiting for every sector to finish.
#[tauri::command]
async fn read_classic_sector(
    session: tauri::State<'_, SessionSlot>,
    sector: u8,
) -> Result<Option<ClassicSectorInfo>, String> {
    let current = pn532::session::current_session(&session);
    run_blocking(move || pn532::tags::mifare_classic::read_classic_sector(&current, sector))
        .await?
        .map_err(|e| e.to_string())
}

/// Write the sector data previously read from a source card onto a target card (also attempts to
/// clone the UID, and reports honestly whether that succeeded). Fails outright if the target
/// card's UID matches the source's — that means the card wasn't actually swapped for a real
/// target.
#[tauri::command]
async fn copy_classic_card(
    session: tauri::State<'_, SessionSlot>,
    source_uid: String,
    sectors: Vec<ClassicSectorData>,
) -> Result<ClassicCopyResult, String> {
    let current = pn532::session::current_session(&session);
    run_blocking(move || pn532::tags::mifare_classic::copy_classic_card(&current, &source_uid, &sectors))
        .await?
        .map_err(|e| e.to_string())
}

/// Write plain text to an arbitrary path (chosen by the user via the frontend's native "Save
/// As" dialog) — used by the export-to-.txt feature on the read/saved-data pages. Bypasses the
/// fs plugin's scope system entirely since the path already went through the user's own explicit
/// choice in a native file dialog, same trust level as any other "Save As".
#[tauri::command]
async fn write_text_file(path: String, content: String) -> Result<(), String> {
    run_blocking(move || std::fs::write(&path, content))
        .await?
        .map_err(|e| e.to_string())
}

/// Same as `write_text_file` but for arbitrary bytes (e.g. a raw memory-dump export) — plain
/// text can't safely carry every possible byte value.
#[tauri::command]
async fn write_binary_file(path: String, content: Vec<u8>) -> Result<(), String> {
    run_blocking(move || std::fs::write(&path, content))
        .await?
        .map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
struct GeoPosition {
    lat: f64,
    lng: f64,
}

/// Native "use current location" for the write page's geo record editor — see
/// `geolocation.rs` for why this goes through the OS instead of the browser's Geolocation API.
/// Not wrapped in `run_blocking`/`COMMAND_TIMEOUT`: unlike the serial port commands, waiting on
/// this is normal (first use waits on the user answering Windows' location-consent prompt),
/// so it shouldn't be cut short by an 8-second timeout meant for a wedged serial port.
#[tauri::command]
async fn get_current_location(app: tauri::AppHandle) -> Result<GeoPosition, String> {
    tauri::async_runtime::spawn_blocking(move || geolocation::current_location(&app))
        .await
        .map_err(|e| e.to_string())?
        .map(|(lat, lng)| GeoPosition { lat, lng })
}

/// The Windows portable zip (see `.github/workflows/release.yml`) is the exact same
/// `pnfc-toolkit.exe` as the NSIS-installed one, just zipped up alone with nothing else next to
/// it — so there's no build-time flag to check. `tauri-plugin-updater`'s install step for NSIS
/// downloads and silently runs the installer as a separate process, which installs a *second*
/// copy under the NSIS install directory and never touches whichever exe the user actually
/// double-clicked; for someone running the portable build, that means the copy they're running
/// never changes no matter how many times they "update" it.
///
/// Detect that case by checking for the `uninstall.exe` Tauri's NSIS bundler always writes next
/// to the installed exe (`WriteUninstaller "$INSTDIR\uninstall.exe"`) — its absence means this
/// binary is running loose from wherever the zip was extracted, not from an NSIS install
/// directory, and the frontend should point the user at a manual download instead of offering
/// the in-app installer.
#[tauri::command]
fn is_portable_install() -> bool {
    #[cfg(target_os = "windows")]
    {
        std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(|dir| !dir.join("uninstall.exe").exists()))
            .unwrap_or(false)
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(
            tauri_plugin_log::Builder::new()
                // The Webview target forwards log records to the frontend via events, for the
                // Dev panel to subscribe to and display.
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview),
                ])
                .level(log::LevelFilter::Debug)
                .format(|out, message, record| {
                    out.finish(format_args!("[{}] {}", record.target(), message))
                })
                .build(),
        )
        .manage(SessionSlot::default())
        .invoke_handler(tauri::generate_handler![
            list_serial_ports,
            probe_pn532_port,
            scan_pn532,
            connect_pn532,
            disconnect_pn532,
            pn532_status,
            pn532_device_info,
            read_card_uid,
            dump_card_memory,
            write_ndef,
            copy_ntag_card,
            format_ntag,
            erase_ntag,
            set_ntag_password,
            clear_ntag_password,
            read_ntag_password_status,
            send_raw_data_exchange,
            read_classic_sector,
            copy_classic_card,
            write_text_file,
            write_binary_file,
            get_current_location,
            is_portable_install
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
