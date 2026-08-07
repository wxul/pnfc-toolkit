export type LogSource = "frontend" | "rust" | "system";
export type LogLevelName = "trace" | "debug" | "info" | "warn" | "error";

export interface LogEntry {
  id: number;
  time: number;
  source: LogSource;
  level: LogLevelName;
  target?: string;
  message: string;
}

const MAX_ENTRIES = 1000;
const RUST_LEVEL_NAMES: LogLevelName[] = ["trace", "trace", "debug", "info", "warn", "error"];
// tauri-plugin-log's format() on the Rust side prefixes the message with the target: "[target] message"
const RUST_TARGET_PREFIX = /^\[([^\]]+)]\s([\s\S]*)$/;

type Listener = (entries: LogEntry[]) => void;

let entries: LogEntry[] = [];
let nextId = 1;
const listeners = new Set<Listener>();

function push(entry: Omit<LogEntry, "id" | "time">) {
  entries = [...entries, { ...entry, id: nextId++, time: Date.now() }].slice(-MAX_ENTRIES);
  for (const listener of listeners) listener(entries);
}

export function logFrontend(level: LogLevelName, message: string) {
  push({ source: "frontend", level, message });
}

export function logSystem(level: LogLevelName, message: string) {
  push({ source: "system", level, message });
}

export function subscribeLogs(listener: Listener): () => void {
  listeners.add(listener);
  listener(entries);
  return () => listeners.delete(listener);
}

export function clearLogs() {
  entries = [];
  for (const listener of listeners) listener(entries);
}

let bridgeInitialized = false;

/** Subscribe to log events from the Rust side (tauri-plugin-log), and hook up system-level
 * uncaught-exception listeners. Only needs to be called once. */
export async function initDevLogBridge() {
  if (bridgeInitialized) return;
  bridgeInitialized = true;

  window.addEventListener("error", (e) => {
    logSystem("error", e.message);
  });
  window.addEventListener("unhandledrejection", (e) => {
    logSystem("error", `Unhandled promise rejection: ${String(e.reason)}`);
  });

  const { attachLogger } = await import("@tauri-apps/plugin-log");
  await attachLogger(({ level, message }) => {
    const match = RUST_TARGET_PREFIX.exec(message);
    const target = match?.[1];
    const text = match ? match[2] : message;
    push({
      source: "rust",
      level: RUST_LEVEL_NAMES[level] ?? "info",
      target,
      message: text,
    });
  });
}
