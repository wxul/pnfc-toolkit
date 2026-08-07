import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useDevLogs } from "../hooks/useDevLogs";
import { clearLogs, logFrontend, type LogEntry, type LogSource } from "../lib/devLog";
import "./DevPanel.css";

interface SerialPortSummary {
  port_name: string;
  is_usb: boolean;
  vid?: number;
  pid?: number;
  manufacturer?: string;
  product?: string;
  serial_number?: string;
  friendly_name?: string;
}

interface Pn532Info {
  port_name: string;
  ic: number;
  version: number;
  revision: number;
  support: number;
}

type Tab = "logs" | "frames" | "serial";

const SOURCE_LABEL: Record<LogSource, string> = {
  frontend: "Frontend",
  rust: "Rust",
  system: "System",
};

const SOURCE_COLOR: Record<LogSource, string> = {
  frontend: "#5b8ff9",
  rust: "#d99a5b",
  system: "#e05c5c",
};

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function formatHex(hex: string): string {
  return hex.toUpperCase().match(/.{1,2}/g)?.join(" ") ?? hex;
}

// InListPassiveTarget (0x4A) — the command byte the PN532 protocol frame carries right after
// the TFI byte. TX layout is [00 00 FF LEN LCS TFI CMD ...], so the command sits at byte index 6.
const CMD_IN_LIST_PASSIVE_TARGET = 0x4a;
const HOST_TO_PN532 = 0xd4;

function parseFrameBytes(message: string): number[] | null {
  const match = /^(?:TX|RX) ([0-9a-fA-F]+)$/.exec(message);
  if (!match) return null;
  const hex = match[1];
  const bytes: number[] = [];
  for (let i = 0; i + 1 < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  return bytes;
}

/**
 * The background 500ms polling loop (checking "is a card present") calls InListPassiveTarget
 * over and over, which floods the frame/log view with a TX + ACK + response triplet every half
 * second — drowning out the frames that actually matter while debugging something else. This
 * walks the frame log in order and marks every entry belonging to one of these exchanges (the
 * TX itself, plus the ACK and response that immediately follow it), so the UI can filter them
 * out on request.
 *
 * A TX frame is identified as InListPassiveTarget by its command byte; the ACK/response that
 * come right after are attributed to that same exchange without inspecting their content —
 * every `send_command` call on the Rust side logs exactly one TX, one ACK, one response, in
 * that order, and the session's mutex means two exchanges can never interleave, so pairing by
 * strict sequence is reliable.
 */
function findHeartbeatFrameIds(entries: LogEntry[]): Set<number> {
  const heartbeatIds = new Set<number>();
  let currentIsHeartbeat = false;
  let step: 0 | 1 | 2 = 0; // 0 = expecting a TX, 1 = expecting its ACK, 2 = expecting its response

  for (const entry of entries) {
    if (entry.source !== "rust" || entry.target !== "pn532::frame") continue;
    const bytes = parseFrameBytes(entry.message);
    if (!bytes) continue;

    if (step === 0) {
      currentIsHeartbeat = bytes[5] === HOST_TO_PN532 && bytes[6] === CMD_IN_LIST_PASSIVE_TARGET;
      step = 1;
    } else {
      step = step === 1 ? 2 : 0;
    }
    if (currentIsHeartbeat) heartbeatIds.add(entry.id);
  }
  return heartbeatIds;
}

export function DevPanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("logs");
  // Shared across the Logs and Frames tabs — it's the same underlying noise either way, no
  // reason to make the user set it twice.
  const [hideHeartbeat, setHideHeartbeat] = useState(true);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div className="dev-panel-backdrop">
      <div className="dev-panel" role="dialog" aria-label="Development">
        <div className="dev-panel-header">
          <span className="dev-panel-title">🛠 Dev Tools</span>
          <div className="dev-panel-tabs">
            <button className={tab === "logs" ? "active" : ""} onClick={() => setTab("logs")}>
              Logs
            </button>
            <button className={tab === "frames" ? "active" : ""} onClick={() => setTab("frames")}>
              Frames
            </button>
            <button className={tab === "serial" ? "active" : ""} onClick={() => setTab("serial")}>
              Serial
            </button>
          </div>
          <button className="dev-panel-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="dev-panel-body">
          {tab === "logs" && <LogsTab hideHeartbeat={hideHeartbeat} setHideHeartbeat={setHideHeartbeat} />}
          {tab === "frames" && <FramesTab hideHeartbeat={hideHeartbeat} setHideHeartbeat={setHideHeartbeat} />}
          {tab === "serial" && <SerialTab />}
        </div>
      </div>
    </div>
  );
}

function LogsTab({
  hideHeartbeat,
  setHideHeartbeat,
}: {
  hideHeartbeat: boolean;
  setHideHeartbeat: (v: boolean) => void;
}) {
  const logs = useDevLogs();
  const [sources, setSources] = useState<Record<LogSource, boolean>>({
    frontend: true,
    rust: true,
    system: true,
  });
  const heartbeatIds = useMemo(() => findHeartbeatFrameIds(logs), [logs]);

  const filtered = useMemo(
    () => logs.filter((l) => sources[l.source] && !(hideHeartbeat && heartbeatIds.has(l.id))),
    [logs, sources, hideHeartbeat, heartbeatIds],
  );

  return (
    <div className="logs-tab">
      <div className="logs-toolbar">
        {(Object.keys(SOURCE_LABEL) as LogSource[]).map((s) => (
          <label key={s} className="source-toggle">
            <input
              type="checkbox"
              checked={sources[s]}
              onChange={(e) => setSources((prev) => ({ ...prev, [s]: e.target.checked }))}
            />
            <span style={{ color: SOURCE_COLOR[s] }}>{SOURCE_LABEL[s]}</span>
          </label>
        ))}
        <label className="source-toggle" title="Hide the repeating TX/ACK/RX triplet the background 500ms card-presence poll generates">
          <input
            type="checkbox"
            checked={hideHeartbeat}
            onChange={(e) => setHideHeartbeat(e.target.checked)}
          />
          <span>Hide heartbeat frames</span>
        </label>
        <button className="clear-btn" onClick={() => clearLogs()}>
          Clear
        </button>
      </div>
      <div className="log-list">
        {filtered.length === 0 && <div className="empty-hint">No logs yet</div>}
        {filtered.map((l) => (
          <div key={l.id} className={`log-row level-${l.level}`}>
            <span className="log-time">{formatTime(l.time)}</span>
            <span className="log-source" style={{ color: SOURCE_COLOR[l.source] }}>
              [{SOURCE_LABEL[l.source]}]
            </span>
            {l.target && <span className="log-target">{l.target}</span>}
            <span className="log-message">{l.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function FramesTab({
  hideHeartbeat,
  setHideHeartbeat,
}: {
  hideHeartbeat: boolean;
  setHideHeartbeat: (v: boolean) => void;
}) {
  const logs = useDevLogs();
  const heartbeatIds = useMemo(() => findHeartbeatFrameIds(logs), [logs]);
  const frames = useMemo(
    () =>
      logs.filter(
        (l) =>
          l.source === "rust" &&
          l.target === "pn532::frame" &&
          !(hideHeartbeat && heartbeatIds.has(l.id)),
      ),
    [logs, hideHeartbeat, heartbeatIds],
  );

  return (
    <div className="frames-tab">
      <div className="frames-toolbar">
        <label className="source-toggle" title="Hide the repeating TX/ACK/RX triplet the background 500ms card-presence poll generates">
          <input
            type="checkbox"
            checked={hideHeartbeat}
            onChange={(e) => setHideHeartbeat(e.target.checked)}
          />
          <span>Hide heartbeat frames</span>
        </label>
      </div>
      {frames.length === 0 && (
        <div className="empty-hint">
          No frames recorded yet. Raw bytes sent/received while probing a PN532 on the "Serial"
          tab will show up here.
        </div>
      )}
      <div className="frame-list">
        {frames.map((f) => {
          const isTx = f.message.startsWith("TX ");
          const hex = f.message.replace(/^(TX|RX)\s/, "");
          return (
            <div key={f.id} className={`frame-row ${isTx ? "tx" : "rx"}`}>
              <span className="frame-time">{formatTime(f.time)}</span>
              <span className="frame-dir">{isTx ? "→ TX" : "← RX"}</span>
              <span className="frame-hex">{formatHex(hex)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RawFrameSender() {
  const [paramsHex, setParamsHex] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    const hex = paramsHex.trim();
    if (!hex) return;
    setSending(true);
    setResult(null);
    setError(null);
    logFrontend("info", `Sending custom InDataExchange frame: ${hex}`);
    try {
      const resp = await invoke<string>("send_raw_data_exchange", { paramsHex: hex });
      setResult(resp);
      logFrontend("info", `Custom frame response: ${resp}`);
    } catch (e) {
      setError(String(e));
      logFrontend("error", `Failed to send custom frame: ${String(e)}`);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="raw-frame-sender">
      <p className="raw-frame-hint">
        For debugging: select a card once, then send the hex bytes below verbatim as
        InDataExchange parameters (without the D4/40 fixed prefix — start from the target
        number), e.g. fill in <code>011BFFFFFFFF</code> to test PWD_AUTH, or{" "}
        <code>011A00</code> to test Ultralight C's AUTHENTICATE. The complete raw frame also gets
        logged to the "Frames" tab.
      </p>
      <div className="raw-frame-row">
        <input
          className="raw-frame-input"
          placeholder="e.g. 011BFFFFFFFF"
          value={paramsHex}
          onChange={(e) => setParamsHex(e.target.value)}
          disabled={sending}
        />
        <button onClick={send} disabled={sending || !paramsHex.trim()}>
          {sending ? "Sending..." : "Send"}
        </button>
      </div>
      {result && <p className="raw-frame-result ok">Response: {result}</p>}
      {error && <p className="raw-frame-result fail">{error}</p>}
    </div>
  );
}

function SerialTab() {
  const [ports, setPorts] = useState<SerialPortSummary[]>([]);
  const [busyPort, setBusyPort] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [results, setResults] = useState<Record<string, Pn532Info | string>>({});

  async function refreshPorts() {
    try {
      const list = await invoke<SerialPortSummary[]>("list_serial_ports");
      setPorts(list);
      logFrontend("info", `Refreshed serial port list: found ${list.length} port(s)`);
    } catch (e) {
      logFrontend("error", `Failed to refresh serial port list: ${String(e)}`);
    }
  }

  async function probe(portName: string) {
    setBusyPort(portName);
    logFrontend("info", `Probing ${portName} ...`);
    try {
      const info = await invoke<Pn532Info>("probe_pn532_port", { portName });
      setResults((prev) => ({ ...prev, [portName]: info }));
      logFrontend("info", `${portName} confirmed as PN532 (IC=0x${info.ic.toString(16).toUpperCase()})`);
    } catch (e) {
      setResults((prev) => ({ ...prev, [portName]: String(e) }));
      logFrontend("warn", `${portName} probe failed: ${String(e)}`);
    } finally {
      setBusyPort(null);
    }
  }

  async function scanAll() {
    setScanning(true);
    logFrontend("info", "Starting automatic scan of all serial ports...");
    try {
      const found = await invoke<Pn532Info[]>("scan_pn532");
      const next: Record<string, Pn532Info | string> = {};
      for (const info of found) next[info.port_name] = info;
      setResults((prev) => ({ ...prev, ...next }));
      logFrontend("info", `Scan complete, found ${found.length} PN532 device(s)`);
    } catch (e) {
      logFrontend("error", `Scan failed: ${String(e)}`);
    } finally {
      setScanning(false);
    }
  }

  useEffect(() => {
    refreshPorts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="serial-tab">
      <div className="serial-toolbar">
        <button onClick={refreshPorts}>Refresh port list</button>
        <button onClick={scanAll} disabled={scanning}>
          {scanning ? "Scanning..." : "Auto-scan for PN532"}
        </button>
      </div>
      <table className="serial-table">
        <thead>
          <tr>
            <th>Port</th>
            <th>USB</th>
            <th>VID:PID</th>
            <th>Name</th>
            <th>Probe result</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {ports.map((p) => {
            const result = results[p.port_name];
            return (
              <tr key={p.port_name}>
                <td>{p.port_name}</td>
                <td>{p.is_usb ? "Yes" : "No"}</td>
                <td>
                  {p.vid != null && p.pid != null
                    ? `${p.vid.toString(16).padStart(4, "0")}:${p.pid.toString(16).padStart(4, "0")}`
                    : "-"}
                </td>
                <td>
                  {p.friendly_name ||
                    [p.manufacturer, p.product].filter(Boolean).join(" / ") ||
                    "-"}
                </td>
                <td>
                  {result == null ? (
                    "-"
                  ) : typeof result === "string" ? (
                    <span className="result-fail" title={result}>
                      Not a PN532
                    </span>
                  ) : (
                    <span className="result-ok">
                      PN532 IC=0x{result.ic.toString(16).toUpperCase()} Ver{result.version}.
                      {result.revision}
                    </span>
                  )}
                </td>
                <td>
                  <button disabled={busyPort === p.port_name} onClick={() => probe(p.port_name)}>
                    Probe
                  </button>
                </td>
              </tr>
            );
          })}
          {ports.length === 0 && (
            <tr>
              <td colSpan={6} className="empty-hint">
                No serial ports detected
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <RawFrameSender />
    </div>
  );
}
