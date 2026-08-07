use crate::pn532::error::Pn532Error;
use crate::pn532::protocol::{send_command, CMD_GET_FIRMWARE_VERSION};
use serde::Serialize;
use serialport::SerialPortType;
use std::time::Duration;

pub const DEFAULT_BAUD_RATE: u32 = 115_200;
const PROBE_TIMEOUT: Duration = Duration::from_millis(300);

#[derive(Debug, Clone, Serialize)]
pub struct SerialPortSummary {
    pub port_name: String,
    pub is_usb: bool,
    pub vid: Option<u16>,
    pub pid: Option<u16>,
    pub manufacturer: Option<String>,
    pub product: Option<String>,
    pub serial_number: Option<String>,
    /// The OS-displayed friendly name (e.g. "USB-SERIAL CH340 (COM3)" in Windows Device
    /// Manager). Currently only Windows fills this in — on other platforms the `product`
    /// field alone is usually good enough already.
    pub friendly_name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Pn532Info {
    pub port_name: String,
    pub ic: u8,
    pub version: u8,
    pub revision: u8,
    pub support: u8,
    /// Only [`scan_for_pn532`] fills this in (it already has the friendly names for the
    /// whole port list on hand); probing a single port via [`probe_port`] on its own leaves
    /// it empty.
    pub friendly_name: Option<String>,
}

/// List every serial port on the system, with USB VID/PID etc. attached where available.
pub fn list_serial_ports() -> Result<Vec<SerialPortSummary>, Pn532Error> {
    let ports = serialport::available_ports()?;
    let mut friendly_names = crate::pn532::friendly_name::com_port_friendly_names();

    Ok(ports
        .into_iter()
        .map(|p| {
            let friendly_name = friendly_names.remove(&p.port_name);
            match p.port_type {
                SerialPortType::UsbPort(info) => SerialPortSummary {
                    port_name: p.port_name,
                    is_usb: true,
                    vid: Some(info.vid),
                    pid: Some(info.pid),
                    manufacturer: info.manufacturer,
                    product: info.product,
                    serial_number: info.serial_number,
                    friendly_name,
                },
                _ => SerialPortSummary {
                    port_name: p.port_name,
                    is_usb: false,
                    vid: None,
                    pid: None,
                    manufacturer: None,
                    product: None,
                    serial_number: None,
                    friendly_name,
                },
            }
        })
        .collect())
}

/// Open the given serial port and send GetFirmwareVersion, confirming from the response that
/// this is actually a PN532.
pub fn probe_port(port_name: &str, baud_rate: u32) -> Result<Pn532Info, Pn532Error> {
    let mut port = serialport::new(port_name, baud_rate)
        .timeout(PROBE_TIMEOUT)
        .open()?;

    crate::pn532::protocol::wake_up(&mut *port)?;
    let data = send_command(&mut *port, CMD_GET_FIRMWARE_VERSION, &[])?;
    if data.len() < 4 {
        return Err(Pn532Error::InvalidFrame(
            "firmware version response too short".into(),
        ));
    }

    log::info!(
        "found PN532 on {}: IC={:02X} Ver={}.{} Support={:02X}",
        port_name,
        data[0],
        data[1],
        data[2],
        data[3]
    );

    Ok(Pn532Info {
        port_name: port_name.to_string(),
        ic: data[0],
        version: data[1],
        revision: data[2],
        support: data[3],
        friendly_name: None,
    })
}

/// Walk every serial port on the system, probing each one in turn, and return the ones that
/// responded like a healthy PN532 (with friendly names attached, so a user with multiple
/// PN532s plugged in can tell them apart in the UI).
/// Note: this writes bytes to every candidate port, which could in theory disturb some other
/// serial device — only meant for a local debugging-tool context.
pub fn scan_for_pn532(baud_rate: u32) -> Result<Vec<Pn532Info>, Pn532Error> {
    let ports = list_serial_ports()?;
    let found = ports
        .into_iter()
        .filter_map(|p| {
            log::debug!("probing {}", p.port_name);
            match probe_port(&p.port_name, baud_rate) {
                Ok(mut info) => {
                    info.friendly_name = p.friendly_name;
                    Some(info)
                }
                Err(e) => {
                    log::debug!("{} is not a PN532: {}", p.port_name, e);
                    None
                }
            }
        })
        .collect();
    Ok(found)
}
