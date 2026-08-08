# pnfc-toolkit

A cross-platform desktop app for reading, writing, and inspecting NFC tags. Built with Tauri 2 + React + Rust.

Currently built around the **PN532** module over a serial (UART) connection — support for other NFC controller chips (e.g. PN7160) may be added in the future.

[简体中文](README.zh-CN.md)

![pnfc-toolkit screenshot](assets/screenshot.png)

## Platform support

| Platform | Status |
| --- | --- |
| Windows | Developed and tested on real hardware |
| Linux | Implemented, **not yet tested** on real hardware |
| macOS | Implemented, **not yet tested** on real hardware |

The Linux/macOS-specific code paths (serial port friendly-name lookup, etc.) were written against public documentation and verified with unit tests where practical, but the app as a whole has not been run against a physical PN532 on either platform yet. If you try it on Linux or macOS, bug reports (or confirmations that it works!) are very welcome.

## Features

- [x] **Connect** — auto-detect and connect to a PN532 over USB-serial; shows chip/firmware version, VID:PID, manufacturer, and other device info
- [x] **Read UID / ATQA / SAK / card type** — MIFARE Classic (1K/4K/Mini) and MIFARE Ultralight/NTAG21x, with exact model detection via `GET_VERSION`
- [x] **Full memory dump** (Ultralight/NTAG) — raw page dump plus NDEF message parsing (URI, Text, vCard, WiFi records)
- [x] **MIFARE Classic sector access** — per-sector authentication using a built-in default key dictionary, plus a block data viewer
- [x] **MIFARE Classic card copy/clone** — including UID cloning on writable "magic"/CUID cards
- [x] **Write NDEF records** — URL, plain text, phone, SMS, email, geolocation, vCard business card, or WiFi credentials (WPS); multiple records get packed into a single NDEF message
- [x] **NTAG/Ultralight write-password protection** — set, change, or remove
- [x] **Bilingual UI** — English/Chinese, switchable at runtime from the title bar; the choice is remembered
- [x] **Dev panel** — live log viewer, raw protocol frame inspector (with an option to hide the repetitive card-presence "heartbeat" polling frames), serial port prober, and a raw `InDataExchange` sender for manually probing card commands
- [ ] **Format a blank tag into NDEF format** — writing currently requires the tag to already have a Capability Container
- [ ] **True hardware read-only locking** (OTP lock bits) — the existing "password protection" only protects writes and is reversible
- [ ] **Dedicated "raw command" page** — sending arbitrary commands to a card is currently only available through the Dev panel, not as a first-class feature page
- [ ] **MIFARE Classic 4K/Mini verified on real hardware** — the sector layout is implemented per public documentation, but hasn't actually been tested against physical 4K/Mini cards yet

## Hardware

Any PN532 breakout board wired for **UART/USB-serial mode** (not I2C or SPI) at 115200 baud should work — including the common CH340-based USB-to-serial boards.

## Getting started

Prerequisites: [Rust](https://www.rust-lang.org/tools/install), [Node.js](https://nodejs.org/), [pnpm](https://pnpm.io/), and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS.

```bash
pnpm install

# Run in development mode
pnpm tauri dev

# Build a release bundle
pnpm tauri build
```

## Tech stack

- [Tauri 2](https://tauri.app/) + Rust for the native shell and PN532/serial communication
- React 19 + TypeScript + Tailwind CSS for the UI
- [`serialport`](https://crates.io/crates/serialport) for cross-platform serial I/O

## Project layout

```
src/                 React frontend
  components/        Pages and UI components
  hooks/              Connection state, polling
  lib/                i18n, NDEF/vCard helpers, shared types
src-tauri/src/
  pn532/
    protocol.rs       Low-level PN532 UART framing (ACK, checksums, frame parsing)
    session.rs        Connection lifecycle + card operations (read/write/auth/copy)
    ndef.rs            NDEF message building/parsing
    probe.rs            Port scanning/probing
    friendly_name.rs   OS-specific serial port friendly-name lookup (Windows/Linux/macOS)
  lib.rs              Tauri command handlers
```
