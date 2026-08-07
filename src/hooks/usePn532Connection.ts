import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { logFrontend } from "@/lib/devLog";
import type { CardInfo, Pn532Info, SerialPortSummary } from "@/lib/pn532Types";

type ScanState = "scanning" | "found" | "empty";

const POLL_INTERVAL_MS = 500;

/**
 * Connection state and polling are managed centrally here, instantiated once in App — the
 * device page and read page both read this shared state instead of each maintaining their own
 * connect/poll logic (otherwise multiple timers would end up polling the same serial port at
 * once).
 */
export function usePn532Connection() {
  const [scanState, setScanState] = useState<ScanState>("scanning");
  const [devices, setDevices] = useState<Pn532Info[]>([]);
  const [selectedPort, setSelectedPort] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [connectedPort, setConnectedPort] = useState<string | null>(null);
  // Info about the PN532 itself (chip/firmware version) — the backend fetches a
  // GetFirmwareVersion over the already-open port at connect time and stores it; this just
  // reads that result, it doesn't reopen the port, so it's available regardless of whether this
  // connection came from the "device" page's scan list (e.g. a connection restored right after
  // an app restart) — unlike before, when it depended on the `devices` scan results and was
  // only populated on the "just scanned, then connected" path.
  const [connectedDeviceInfo, setConnectedDeviceInfo] = useState<Pn532Info | null>(null);
  // Pure OS-level serial port metadata (manufacturer/model/VID:PID/serial number) — just
  // enumerating system info, doesn't actually open the port, so it's safe to query at any time
  // whether this is a fresh connection or one restored after an app restart.
  const [connectedPortSummary, setConnectedPortSummary] = useState<SerialPortSummary | null>(
    null,
  );
  const [connectError, setConnectError] = useState<string | null>(null);
  const [card, setCard] = useState<CardInfo | null>(null);
  // Bumped every time a card goes from "absent" to "present", regardless of whether it's the
  // same card as last time (same UID). Page state like "cleared" needs to follow this, not
  // `card.uid` — otherwise lifting the same card off and setting it back down again, with the
  // UID unchanged, would never re-trigger an effect that depends on `card.uid`.
  const [detectionSeq, setDetectionSeq] = useState(0);
  const wasPresentRef = useRef(false);
  const pollRef = useRef<number | null>(null);
  // Operations like the Classic sector scan/copy need to reselect and authenticate the card
  // repeatedly in a row; the background poll is using the same antenna for `select_target` at
  // the same time, and the two racing against each other can interrupt an authentication in
  // progress. These operations set this to true while running, skipping polls during that
  // window and restoring it afterward — no need to actually stop the timer, which would mean
  // dealing with the timing of rebuilding it.
  const pollingPausedRef = useRef(false);
  function setPollingPaused(paused: boolean) {
    pollingPausedRef.current = paused;
  }
  // Disconnecting takes effect "immediately" in the UI (see the comment in disconnect()), but
  // actually closing the serial port finishes asynchronously in the background. If a
  // scan/connect fires right after that, Windows will report "access denied" because we're
  // still holding that port ourselves. This ref tracks that pending disconnect operation, and
  // scan/connect wait for it to actually finish first, avoiding this self-inflicted race over
  // the port.
  const pendingDisconnectRef = useRef<Promise<void> | null>(null);

  async function scanDevices() {
    if (pendingDisconnectRef.current) {
      await pendingDisconnectRef.current;
    }
    setScanState("scanning");
    setConnectError(null);
    logFrontend("info", "Scanning for PN532 devices...");
    try {
      const found = await invoke<Pn532Info[]>("scan_pn532");
      setDevices(found);
      setScanState(found.length > 0 ? "found" : "empty");
      setSelectedPort((prev) =>
        found.some((d) => d.port_name === prev) ? prev : found[0]?.port_name || "",
      );
      logFrontend("info", `Scan complete, found ${found.length} PN532 device(s)`);
    } catch (e) {
      setScanState("empty");
      logFrontend("error", `Scan failed: ${String(e)}`);
    }
  }

  useEffect(() => {
    invoke<string | null>("pn532_status").then((port) => {
      setConnectedPort(port);
      if (!port) scanDevices();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!connectedPort) {
      setConnectedPortSummary(null);
      setConnectedDeviceInfo(null);
      return;
    }
    let cancelled = false;
    invoke<SerialPortSummary[]>("list_serial_ports")
      .then((ports) => {
        if (cancelled) return;
        setConnectedPortSummary(ports.find((p) => p.port_name === connectedPort) ?? null);
      })
      .catch((e) => logFrontend("error", `Failed to read serial port info: ${String(e)}`));
    invoke<Pn532Info | null>("pn532_device_info")
      .then((info) => {
        if (!cancelled) setConnectedDeviceInfo(info);
      })
      .catch((e) => logFrontend("error", `Failed to read PN532 device info: ${String(e)}`));
    return () => {
      cancelled = true;
    };
  }, [connectedPort]);

  useEffect(() => {
    if (!connectedPort) {
      setCard(null);
      wasPresentRef.current = false;
      return;
    }
    pollRef.current = window.setInterval(async () => {
      if (pollingPausedRef.current) return;
      try {
        const result = await invoke<CardInfo | null>("read_card_uid");
        // Deliberately don't clear `card` when the card is removed — per the requirement,
        // scanned data should stay visible until the user explicitly clicks "clear" or a new
        // card is scanned (even the same card again), not vanish the moment it's lifted off.
        if (result) {
          setCard(result);
          if (!wasPresentRef.current) {
            setDetectionSeq((s) => s + 1);
          }
        }
        wasPresentRef.current = !!result;
      } catch (e) {
        logFrontend("error", `Failed to read card: ${String(e)}`);
      }
    }, POLL_INTERVAL_MS);
    return () => {
      if (pollRef.current != null) window.clearInterval(pollRef.current);
    };
  }, [connectedPort]);

  async function connect() {
    if (!selectedPort) return;
    if (pendingDisconnectRef.current) {
      await pendingDisconnectRef.current;
    }
    setConnecting(true);
    setConnectError(null);
    logFrontend("info", `Connecting to ${selectedPort} ...`);
    try {
      await invoke("connect_pn532", { portName: selectedPort });
      setConnectedPort(selectedPort);
      logFrontend("info", `${selectedPort} connected successfully`);
    } catch (e) {
      setConnectError(String(e));
      logFrontend("error", `Connect failed: ${String(e)}`);
    } finally {
      setConnecting(false);
    }
  }

  async function disconnect() {
    // Disconnect immediately in the UI first (which also makes the polling effect stop sending
    // new poll requests right away) — don't wait for the backend call's round trip: if the card
    // happened to be responding slowly and that call is stuck queued behind it, the user
    // shouldn't be left hanging just because they clicked a button. The actual serial port
    // close happens in the background; failures there are just logged.
    setConnectedPort(null);
    setConnectedDeviceInfo(null);
    logFrontend("info", "Disconnecting...");
    const p = (async () => {
      try {
        await invoke("disconnect_pn532");
        logFrontend("info", "Disconnected");
      } catch (e) {
        logFrontend("error", `Disconnect failed: ${String(e)}`);
      }
    })();
    pendingDisconnectRef.current = p;
    await p;
    if (pendingDisconnectRef.current === p) {
      pendingDisconnectRef.current = null;
    }
  }

  // Called by the "clear" button — just setting `card` to null isn't enough: if the card
  // never actually left the antenna (a light lift-and-set-back-down will often still read on
  // every poll), `wasPresentRef` would stay true, and the card would keep being judged as
  // "still the same detection as before", so `detectionSeq` would never change and the UI would
  // stay stuck on "waiting to scan" forever. Resetting `wasPresentRef` to false too means that,
  // regardless of whether the card really left, the very next poll that reads a card gets
  // treated as a new detection — exactly like the first read right after connecting a device.
  function clearCard() {
    setCard(null);
    wasPresentRef.current = false;
  }

  return {
    scanState,
    devices,
    selectedPort,
    setSelectedPort,
    connecting,
    connectedPort,
    connectedDeviceInfo,
    connectedPortSummary,
    connectError,
    card,
    detectionSeq,
    setPollingPaused,
    scanDevices,
    connect,
    disconnect,
    clearCard,
  };
}
