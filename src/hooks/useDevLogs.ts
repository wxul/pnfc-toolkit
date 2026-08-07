import { useEffect, useState } from "react";
import { subscribeLogs, type LogEntry } from "../lib/devLog";

export function useDevLogs(): LogEntry[] {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  useEffect(() => subscribeLogs(setLogs), []);
  return logs;
}
