//! MIFARE Classic protocol logic: Crypto1 key-dictionary authentication, per-sector read, and
//! card-to-card copy/UID clone. Everything here only depends on `pn532::session`'s generic
//! "select a target, exchange bytes with it" primitives — none of it is specific to the PN532
//! beyond that (see the module doc on `pn532::tags`).

use crate::pn532::error::Pn532Error;
use crate::pn532::protocol::CMD_IN_DATA_EXCHANGE;
use crate::pn532::session::{self, SharedSession};
use serde::{Deserialize, Serialize};
use serialport::SerialPort;

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
    let resp = crate::pn532::protocol::send_command(port, CMD_IN_DATA_EXCHANGE, &params)?;
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

    let Some(target) = crate::pn532::session::select_target(&mut *conn.port)? else {
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
        let result = session::send_with_retry(
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
    let Some(target) = crate::pn532::session::select_target(&mut *conn.port)? else {
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
        if let Some(t) = crate::pn532::session::select_target(&mut *conn.port)? {
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
                    if let Ok(read_resp) = crate::pn532::protocol::send_command(
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
                            if let Ok(resp) = crate::pn532::protocol::send_command(
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
        let Some(t) = crate::pn532::session::select_target(&mut *conn.port)? else {
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
            match session::send_with_retry(&mut *conn.port, CMD_IN_DATA_EXCHANGE, &params, 2) {
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
