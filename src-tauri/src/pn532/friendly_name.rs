//! Serial port "friendly names" (the kind Windows Device Manager shows, e.g.
//! "USB-SERIAL CH340 (COM3)"). serialport-rs often gets `None` back for
//! manufacturer/product when reading USB descriptors on Windows — a lot of
//! USB-to-serial chip drivers just don't fill in those two fields along that
//! path, but the friendly name Device Manager shows actually comes from a
//! different spot in the registry, so it has to be looked up separately.
//!
//! On Linux/macOS, serialport-rs itself usually gets manufacturer/product
//! fine from udev/IOKit (it's nowhere near as prone to going missing as on
//! Windows), so those two implementations here are more of a nice-to-have
//! fallback: coming up empty just returns an empty map and doesn't affect
//! the main flow — the caller ([`crate::pn532::probe::list_serial_ports`])
//! naturally falls back to the `product`/`manufacturer` fields when
//! `friendly_name` is missing.
//!
//! The three platform implementations are independent and haven't been
//! cross-checked against each other (Linux/macOS especially — no matching
//! hardware on hand to test against). All of them are built to fail closed:
//! come up empty rather than panic or return bad data if the host system's
//! specifics don't match what was assumed here.

use std::collections::HashMap;

#[cfg(windows)]
pub fn com_port_friendly_names() -> HashMap<String, String> {
    windows_impl::com_port_friendly_names()
}

#[cfg(target_os = "linux")]
pub fn com_port_friendly_names() -> HashMap<String, String> {
    linux_impl::com_port_friendly_names()
}

#[cfg(target_os = "macos")]
pub fn com_port_friendly_names() -> HashMap<String, String> {
    macos_impl::com_port_friendly_names()
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
pub fn com_port_friendly_names() -> HashMap<String, String> {
    HashMap::new()
}

#[cfg(windows)]
mod windows_impl {
    use std::collections::HashMap;
    use winreg::enums::HKEY_LOCAL_MACHINE;
    use winreg::RegKey;

    // Only walk the common serial-device enumerators, instead of the whole Enum tree
    // (ACPI/PCI/ROOT/SWD etc).
    const ENUM_ROOTS: [&str; 3] = ["USB", "FTDIBUS", "BTHENUM"];

    pub fn com_port_friendly_names() -> HashMap<String, String> {
        let mut result = HashMap::new();

        let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
        let Ok(enum_key) = hklm.open_subkey("SYSTEM\\CurrentControlSet\\Enum") else {
            return result;
        };

        for root_name in ENUM_ROOTS {
            let Ok(root_key) = enum_key.open_subkey(root_name) else {
                continue;
            };
            for hardware_id in root_key.enum_keys().flatten() {
                let Ok(hardware_key) = root_key.open_subkey(&hardware_id) else {
                    continue;
                };
                for instance_id in hardware_key.enum_keys().flatten() {
                    let Ok(instance_key) = hardware_key.open_subkey(&instance_id) else {
                        continue;
                    };
                    let Ok(friendly_name) =
                        instance_key.get_value::<String, _>("FriendlyName")
                    else {
                        continue;
                    };
                    if let Some(port_name) = extract_com_port(&friendly_name) {
                        result.insert(port_name, friendly_name);
                    }
                }
            }
        }

        result
    }

    /// "USB-SERIAL CH340 (COM3)" -> "COM3"
    fn extract_com_port(friendly_name: &str) -> Option<String> {
        let start = friendly_name.rfind("(COM")?;
        let rest = &friendly_name[start + 1..];
        let end = rest.find(')')?;
        Some(rest[..end].to_string())
    }

    #[cfg(test)]
    mod tests {
        use super::extract_com_port;

        #[test]
        fn extracts_port_from_typical_friendly_name() {
            assert_eq!(
                extract_com_port("USB-SERIAL CH340 (COM3)"),
                Some("COM3".to_string())
            );
        }

        #[test]
        fn returns_none_without_com_suffix() {
            assert_eq!(extract_com_port("Standard Port Types"), None);
        }
    }
}

/// The sysfs layout for a USB-to-serial device is roughly: `/sys/class/tty/ttyUSB0/device`
/// is a symlink pointing at the USB interface directory (something like
/// `.../1-1/1-1:1.0`); the `product`/`manufacturer`/`serial` files actually live one level
/// up from the interface, on the USB device itself (`1-1`). Starting from `device` and
/// walking up until we find a directory with a `product` or `manufacturer` file follows
/// the standard layout the kernel's usbcore driver maintains, which has been stable for a
/// long time.
#[cfg(target_os = "linux")]
mod linux_impl {
    use std::collections::HashMap;
    use std::fs;
    use std::path::{Path, PathBuf};

    pub fn com_port_friendly_names() -> HashMap<String, String> {
        let mut result = HashMap::new();
        let Ok(entries) = fs::read_dir("/sys/class/tty") else {
            return result;
        };

        for entry in entries.flatten() {
            let tty_name = entry.file_name().to_string_lossy().into_owned();
            let Ok(device_path) = fs::canonicalize(entry.path().join("device")) else {
                continue;
            };
            let Some(usb_dir) = find_usb_device_dir(&device_path) else {
                continue;
            };
            let product = read_trimmed(&usb_dir.join("product"));
            let manufacturer = read_trimmed(&usb_dir.join("manufacturer"));
            if let Some(friendly) = combine(manufacturer, product) {
                result.insert(format!("/dev/{tty_name}"), friendly);
            }
        }

        result
    }

    /// Starting from the directory the tty's `device` symlink points at, walk up at most 6
    /// levels — the USB interface is normally just one level below the USB device itself,
    /// the extra headroom is to cope with deeper topologies like hub cascades. Give up once
    /// there's no parent left (hit the root); not every tty sits under USB (onboard UARTs,
    /// virtual serial ports, etc.), so not finding one is expected.
    fn find_usb_device_dir(start: &Path) -> Option<PathBuf> {
        let mut dir = start.to_path_buf();
        for _ in 0..6 {
            if dir.join("product").is_file() || dir.join("manufacturer").is_file() {
                return Some(dir);
            }
            dir = dir.parent()?.to_path_buf();
        }
        None
    }

    fn read_trimmed(path: &Path) -> Option<String> {
        fs::read_to_string(path)
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    }

    /// The product string often already includes the manufacturer name (e.g. "FTDI FT232R
    /// USB UART"), in which case appending it again would be redundant — only combine into
    /// "product (manufacturer)" when the product string doesn't already contain it, matching
    /// the same parenthesized style as Windows's "USB-SERIAL CH340 (COM3)".
    fn combine(manufacturer: Option<String>, product: Option<String>) -> Option<String> {
        match (manufacturer, product) {
            (Some(m), Some(p)) => {
                if p.to_lowercase().contains(&m.to_lowercase()) {
                    Some(p)
                } else {
                    Some(format!("{p} ({m})"))
                }
            }
            (None, Some(p)) => Some(p),
            (Some(m), None) => Some(m),
            (None, None) => None,
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn combines_distinct_manufacturer_and_product() {
            assert_eq!(
                combine(Some("wch.cn".into()), Some("USB2.0-Serial".into())),
                Some("USB2.0-Serial (wch.cn)".into())
            );
        }

        #[test]
        fn skips_redundant_manufacturer_already_in_product() {
            assert_eq!(
                combine(Some("FTDI".into()), Some("FTDI FT232R USB UART".into())),
                Some("FTDI FT232R USB UART".into())
            );
        }

        #[test]
        fn falls_back_to_whichever_field_is_present() {
            assert_eq!(combine(None, Some("USB Serial".into())), Some("USB Serial".into()));
            assert_eq!(combine(Some("wch.cn".into()), None), Some("wch.cn".into()));
            assert_eq!(combine(None, None), None);
        }

        #[test]
        fn find_usb_device_dir_walks_up_to_product_file() {
            let base = std::env::temp_dir().join(format!("pn532_sysfs_test_{}", std::process::id()));
            let usb_dev = base.join("devices/1-1");
            let iface = usb_dev.join("1-1.0");
            fs::create_dir_all(&iface).unwrap();
            fs::write(usb_dev.join("product"), "USB2.0-Serial\n").unwrap();
            fs::write(usb_dev.join("manufacturer"), "wch.cn\n").unwrap();

            let found = find_usb_device_dir(&iface).unwrap();
            assert_eq!(found, usb_dev);
            assert_eq!(read_trimmed(&found.join("product")), Some("USB2.0-Serial".to_string()));

            fs::remove_dir_all(&base).unwrap();
        }

        #[test]
        fn find_usb_device_dir_gives_up_past_depth_limit() {
            // The starting point itself has no product/manufacturer, and walking up never
            // finds one (all the way to the filesystem root) — the 6-level cap should make
            // this cleanly return `None` instead of walking all the way to "/" and panicking.
            let deep = Path::new("/a/b/c/d/e/f/g/h/i");
            assert_eq!(find_usb_device_dir(deep), None);
        }
    }
}

/// macOS has no sysfs. A serial device's (`IOSerialBSDClient`) USB product/vendor name lives
/// on one of its ancestor nodes (`IOUSBHostDevice`), not on the entry itself, and there's no
/// single query that directly answers "which USB product name does this /dev/cu.xxx belong
/// to". This dumps the whole USB registry tree with `ioreg -p IOUSB -l` (indentation shows
/// nesting) and, while scanning, tracks "which USB device node am I currently under" with a
/// stack keyed by indentation depth. When an `IOCalloutDevice`/`IODialinDevice` property
/// turns up, it walks the stack from the top down to find the nearest ancestor that has a
/// "USB Product Name".
///
/// Pure text parsing — no IOKit C API calls, no new dependency. `ioreg`'s output format can
/// vary slightly across macOS versions; a parse failure just returns an empty map, it never
/// panics, and it doesn't affect the other fields (manufacturer/product/serial_number are
/// already read straight from IOKit by serialport-rs itself, independent of this).
#[cfg(target_os = "macos")]
mod macos_impl {
    use std::collections::HashMap;
    use std::process::Command;

    pub fn com_port_friendly_names() -> HashMap<String, String> {
        let Ok(output) = Command::new("ioreg").args(["-p", "IOUSB", "-w0", "-l"]).output() else {
            return HashMap::new();
        };
        if !output.status.success() {
            return HashMap::new();
        }
        let Ok(text) = String::from_utf8(output.stdout) else {
            return HashMap::new();
        };
        parse_ioreg_tree(&text)
    }

    struct StackEntry {
        depth: usize,
        product: Option<String>,
        vendor: Option<String>,
    }

    fn parse_ioreg_tree(text: &str) -> HashMap<String, String> {
        let mut result = HashMap::new();
        let mut stack: Vec<StackEntry> = Vec::new();

        for line in text.lines() {
            if let Some(depth) = node_start_depth(line) {
                while stack.last().is_some_and(|top| top.depth >= depth) {
                    stack.pop();
                }
                stack.push(StackEntry { depth, product: None, vendor: None });
                continue;
            }

            let Some(top) = stack.last_mut() else { continue };
            if let Some(value) = property_value(line, "USB Product Name") {
                top.product = Some(value);
            } else if let Some(value) = property_value(line, "USB Vendor Name") {
                top.vendor = Some(value);
            } else if let Some(devnode) = property_value(line, "IOCalloutDevice")
                .or_else(|| property_value(line, "IODialinDevice"))
            {
                if let Some(friendly) = nearest_friendly_name(&stack) {
                    result.insert(devnode, friendly);
                }
            }
        }

        result
    }

    /// Walk the stack from the top (nearest) down and take the first entry that recorded a
    /// product name, combining it into "product (vendor)" — unless there's no vendor, or the
    /// vendor name is already part of the product string, in which case just use the product,
    /// mirroring the style of `combine()` on the Linux side.
    fn nearest_friendly_name(stack: &[StackEntry]) -> Option<String> {
        let entry = stack.iter().rev().find(|e| e.product.is_some())?;
        let product = entry.product.clone()?;
        match &entry.vendor {
            Some(v) if !product.to_lowercase().contains(&v.to_lowercase()) => {
                Some(format!("{product} ({v})"))
            }
            _ => Some(product),
        }
    }

    /// A node in `ioreg -p IOUSB -l` output starts with a line shaped like
    /// `  +-o USB2.0-Serial@14100000  <class IOUSBHostDevice, id 0x..., ...>` — the amount of
    /// leading whitespace before "+-o" is that node's depth in the tree, used to figure out
    /// which node the following property lines (and later sibling nodes) belong to. Returns
    /// `None` if the line isn't a node-start line.
    fn node_start_depth(line: &str) -> Option<usize> {
        let marker = line.find("+-o")?;
        // Everything before the marker must be whitespace, otherwise "+-o" just happens to
        // show up inside some other content.
        if line[..marker].chars().all(char::is_whitespace) {
            Some(marker)
        } else {
            None
        }
    }

    /// A property line looks like `        "USB Product Name" = "USB2.0-Serial"` — this only
    /// handles the case where both key and value are quoted strings, which is all that's
    /// needed here (numeric properties like vid/pid aren't used).
    fn property_value(line: &str, key: &str) -> Option<String> {
        let trimmed = line.trim_start();
        let rest = trimmed.strip_prefix('"')?.strip_prefix(key)?.strip_prefix('"')?;
        let rest = rest.trim_start().strip_prefix('=')?.trim_start();
        let rest = rest.strip_prefix('"')?;
        let end = rest.find('"')?;
        Some(rest[..end].to_string())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        const SAMPLE: &str = r#"
+-o Root  <class IORegistryEntry, id 0x100000100, retain 17>
  +-o USB2.0-Serial@14100000  <class IOUSBHostDevice, id 0x100000abc, registered, matched, active, busy 0 (0 ms), retain 8>
    {
      "USB Vendor Name" = "wch.cn"
      "USB Product Name" = "USB2.0-Serial"
      "USB Serial Number" = "0001"
    }
    +-o USB2.0-Serial@0  <class IOUSBHostInterface, id 0x100000abd, registered, matched, active, busy 0 (0 ms), retain 6>
      {
        "bInterfaceNumber" = 0
      }
      +-o IOSerialBSDClient  <class IOSerialBSDClient, id 0x100000abe, registered, matched, active, busy 0 (0 ms), retain 6>
        {
          "IOCalloutDevice" = "/dev/cu.usbserial-1420"
          "IODialinDevice" = "/dev/tty.usbserial-1420"
        }
  +-o Unrelated Hub@14200000  <class IOUSBHostDevice, id 0x100000fff, registered, matched, active, busy 0 (0 ms), retain 4>
    {
      "USB Vendor Name" = "Apple Inc."
      "USB Product Name" = "USB3.0 Hub"
    }
"#;

        #[test]
        fn associates_callout_device_with_nearest_ancestor_product_name() {
            let names = parse_ioreg_tree(SAMPLE);
            assert_eq!(
                names.get("/dev/cu.usbserial-1420"),
                Some(&"USB2.0-Serial (wch.cn)".to_string())
            );
            assert_eq!(
                names.get("/dev/tty.usbserial-1420"),
                Some(&"USB2.0-Serial (wch.cn)".to_string())
            );
        }

        #[test]
        fn does_not_leak_names_across_sibling_subtrees() {
            let names = parse_ioreg_tree(SAMPLE);
            // The sibling "Unrelated Hub" node has no IOSerialBSDClient underneath it, so it
            // shouldn't produce any entries — what really matters here is confirming that,
            // once the earlier device parsed correctly, the rest of the tree doesn't leak
            // into the result: there should be exactly those two devnode entries total.
            assert_eq!(names.len(), 2);
        }

        #[test]
        fn property_value_parses_quoted_string_property() {
            assert_eq!(
                property_value(r#"      "USB Product Name" = "USB2.0-Serial""#, "USB Product Name"),
                Some("USB2.0-Serial".to_string())
            );
            assert_eq!(property_value(r#"      "bInterfaceNumber" = 0"#, "USB Product Name"), None);
        }

        #[test]
        fn handles_two_sibling_serial_devices_independently() {
            let sample = r#"
+-o Root  <class IORegistryEntry, id 0x1, retain 1>
  +-o DeviceA@1  <class IOUSBHostDevice, id 0x2, retain 1>
    {
      "USB Vendor Name" = "FTDI"
      "USB Product Name" = "FT232R USB UART"
    }
    +-o IOSerialBSDClient  <class IOSerialBSDClient, id 0x3, retain 1>
      {
        "IOCalloutDevice" = "/dev/cu.usbserial-A"
      }
  +-o DeviceB@2  <class IOUSBHostDevice, id 0x4, retain 1>
    {
      "USB Vendor Name" = "Silicon Labs"
      "USB Product Name" = "CP2102 USB to UART"
    }
    +-o IOSerialBSDClient  <class IOSerialBSDClient, id 0x5, retain 1>
      {
        "IOCalloutDevice" = "/dev/cu.usbserial-B"
      }
"#;
            let names = parse_ioreg_tree(sample);
            assert_eq!(names.get("/dev/cu.usbserial-A"), Some(&"FT232R USB UART (FTDI)".to_string()));
            assert_eq!(
                names.get("/dev/cu.usbserial-B"),
                Some(&"CP2102 USB to UART (Silicon Labs)".to_string())
            );
        }

        #[test]
        fn empty_or_garbage_input_returns_empty_map() {
            assert!(parse_ioreg_tree("").is_empty());
            assert!(parse_ioreg_tree("not ioreg output at all\nrandom text").is_empty());
        }
    }
}
