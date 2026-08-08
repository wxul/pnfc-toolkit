use crate::pn532::error::Pn532Error;
use serialport::SerialPort;

pub const HOST_TO_PN532: u8 = 0xD4;
pub const PN532_TO_HOST: u8 = 0xD5;

pub const CMD_GET_FIRMWARE_VERSION: u8 = 0x02;
pub const CMD_RF_CONFIGURATION: u8 = 0x32;
pub const CMD_SAM_CONFIGURATION: u8 = 0x14;
pub const CMD_IN_LIST_PASSIVE_TARGET: u8 = 0x4A;
pub const CMD_IN_DATA_EXCHANGE: u8 = 0x40;
/// Unlike `InDataExchange`, this relays bytes to the currently selected target completely
/// untouched — no automatic MIFARE Classic authentication shortcut for a leading 0x60/0x61 (see
/// the comment on `NTAG_CMD_GET_VERSION` in session.rs for why that matters).
pub const CMD_IN_COMMUNICATE_THRU: u8 = 0x42;

/// The standard frame's LEN field is only 1 byte, so TFI+CMD+PARAMS together can't exceed
/// this without switching to a standard frame's alternative — PN532 also defines an
/// "extended frame" format for larger payloads, which isn't implemented here since every
/// known call site's payload is far under this limit. Better to error out here up front than
/// let `len as u8` silently wrap around and send out a malformed frame whose length field
/// doesn't match its actual content.
const MAX_FRAME_DATA_LEN: usize = 255;

const ACK_FRAME: [u8; 6] = [0x00, 0x00, 0xFF, 0x00, 0xFF, 0x00];

/// The PN532 sends this fixed 1-byte body (`00 00 FF 01 FF 7F 81 00` as a full frame) when it
/// rejects the command frame it just received — this is the chip talking about its own framing,
/// not a reply relayed from a card. Seen in practice on non-genuine/clone PN532 firmware for
/// `InDataExchange` payloads starting with `0x60`/`0x61`: those bytes are also MIFARE Classic's
/// "authenticate with Key A/B" opcodes, and some clone firmware special-cases them as a
/// convenience shortcut for a full Classic authentication (expecting a block number + 6-byte key
/// + 4-byte UID to follow) — so a Type 2 Tag command that legitimately starts with the same byte
/// (like `GET_VERSION` = `0x60`) but has a completely different, shorter parameter shape gets
/// rejected as malformed instead of passed through untouched.
const PN532_ERROR_FRAME_BODY: u8 = 0x7F;

/// After power-up or coming out of LowVBat, the PN532's UART interface needs to be "woken up"
/// before it'll accept the first real command frame — otherwise the first command often just
/// gets swallowed with no response at all (a read timeout). The datasheet recommends sending
/// a preamble; this matches libnfc and other common third-party libraries: 0x55 0x55 followed
/// by three 0x00 bytes. This isn't a valid frame and the PN532 won't respond to it — it's
/// purely a "knock on the door".
const WAKE_UP_PREAMBLE: [u8; 5] = [0x55, 0x55, 0x00, 0x00, 0x00];

/// All frame-level raw byte logging goes to this target, so the Dev panel can filter out just
/// the "frame" view.
const FRAME_LOG_TARGET: &str = "pn532::frame";

/// Call once right after opening the serial port, before sending the first command.
pub fn wake_up(port: &mut dyn SerialPort) -> Result<(), Pn532Error> {
    log::debug!(target: FRAME_LOG_TARGET, "TX {} (wake up)", hex::encode(WAKE_UP_PREAMBLE));
    port.write_all(&WAKE_UP_PREAMBLE)?;
    port.flush()?;
    Ok(())
}

pub fn build_command_frame(cmd: u8, params: &[u8]) -> Result<Vec<u8>, Pn532Error> {
    let mut data = Vec::with_capacity(2 + params.len());
    data.push(HOST_TO_PN532);
    data.push(cmd);
    data.extend_from_slice(params);

    if data.len() > MAX_FRAME_DATA_LEN {
        return Err(Pn532Error::InvalidFrame(format!(
            "command data too long ({} bytes); a standard frame supports at most \
             {MAX_FRAME_DATA_LEN} bytes",
            data.len()
        )));
    }
    let len = data.len() as u8;
    let lcs = 0u8.wrapping_sub(len);
    let dcs = 0u8.wrapping_sub(data.iter().fold(0u8, |acc, b| acc.wrapping_add(*b)));

    let mut frame = Vec::with_capacity(data.len() + 7);
    frame.push(0x00);
    frame.push(0x00);
    frame.push(0xFF);
    frame.push(len);
    frame.push(lcs);
    frame.extend_from_slice(&data);
    frame.push(dcs);
    frame.push(0x00);
    Ok(frame)
}

fn read_ack(port: &mut dyn SerialPort) -> Result<(), Pn532Error> {
    let mut buf = [0u8; 6];
    port.read_exact(&mut buf)?;
    if buf == ACK_FRAME {
        Ok(())
    } else {
        Err(Pn532Error::InvalidFrame(format!(
            "expected ACK, got {}",
            hex::encode(buf)
        )))
    }
}

fn read_response(port: &mut dyn SerialPort) -> Result<Vec<u8>, Pn532Error> {
    let mut header = [0u8; 5];
    port.read_exact(&mut header)?;
    if header[0..3] != [0x00, 0x00, 0xFF] {
        return Err(Pn532Error::InvalidFrame(format!(
            "missing start code, got {}",
            hex::encode(header)
        )));
    }
    let len = header[3];
    let lcs = header[4];
    if len.wrapping_add(lcs) != 0 {
        return Err(Pn532Error::InvalidFrame("length checksum mismatch".into()));
    }

    let mut body = vec![0u8; len as usize];
    port.read_exact(&mut body)?;
    let mut tail = [0u8; 2];
    port.read_exact(&mut tail)?;
    let dcs = tail[0];

    let mut raw = Vec::with_capacity(header.len() + body.len() + tail.len());
    raw.extend_from_slice(&header);
    raw.extend_from_slice(&body);
    raw.extend_from_slice(&tail);
    log::debug!(target: FRAME_LOG_TARGET, "RX {}", hex::encode(&raw));

    let sum = body.iter().fold(0u8, |acc, b| acc.wrapping_add(*b));
    if sum.wrapping_add(dcs) != 0 {
        return Err(Pn532Error::InvalidFrame("data checksum mismatch".into()));
    }
    if body == [PN532_ERROR_FRAME_BODY] {
        return Err(Pn532Error::InvalidFrame(
            "PN532 rejected the command frame (error frame 0x7F) — often seen on clone PN532 \
             firmware when the InDataExchange payload starts with 0x60/0x61, which some clones \
             special-case as a MIFARE Classic auth shortcut instead of passing it through"
                .into(),
        ));
    }
    if body.first() != Some(&PN532_TO_HOST) {
        return Err(Pn532Error::InvalidFrame(format!(
            "unexpected TFI byte: {:02X?}",
            body.first()
        )));
    }
    Ok(body[1..].to_vec())
}

/// Send a command and wait for the ACK plus the real response, returning the response data
/// with the "echoed command code" byte stripped off.
pub fn send_command(
    port: &mut dyn SerialPort,
    cmd: u8,
    params: &[u8],
) -> Result<Vec<u8>, Pn532Error> {
    // If the previous command was still waiting on the PN532's internal card response past our
    // serial read timeout, we give up and hand control back to the caller — but the PN532 will
    // still send that late frame out eventually, and it's left sitting in the input buffer as
    // garbage that would throw off the next command's frame alignment. Clear the input buffer
    // before every new command so we always start reading from a clean state.
    port.clear(serialport::ClearBuffer::Input)?;

    let frame = build_command_frame(cmd, params)?;
    log::debug!(target: FRAME_LOG_TARGET, "TX {}", hex::encode(&frame));
    port.write_all(&frame)?;
    port.flush()?;

    read_ack(port)?;
    log::debug!(target: FRAME_LOG_TARGET, "RX {}", hex::encode(ACK_FRAME));
    let response = read_response(port)?;

    let expected_code = cmd.wrapping_add(1);
    if response.first() != Some(&expected_code) {
        return Err(Pn532Error::InvalidFrame(format!(
            "unexpected response code: expected {:02X}, got {:02X?}",
            expected_code,
            response.first()
        )));
    }
    Ok(response[1..].to_vec())
}
