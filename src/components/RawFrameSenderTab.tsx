import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { logFrontend } from "@/lib/devLog";
import type { CardInfo } from "@/lib/pn532Types";

interface HistoryEntry {
  id: number;
  time: string;
  sentHex: string;
  ok: boolean;
  message: string;
}

let nextHistoryId = 1;

type Phase = "idle" | "waiting" | "sending";

/**
 * Standalone tab for sending an arbitrary InDataExchange payload — its own top-level tab
 * (alongside Logs/Frames/Serial) rather than a widget bolted onto the Serial tab, because the old
 * inline version only worked if a card was already sitting on the reader the instant "Send" was
 * clicked (`send_raw_data_exchange` selects a card synchronously server-side and just fails with
 * "no card present" otherwise, so testing a command meant a race against your own click). This
 * version instead arms a wait on click — same shape as the write/password/tag tools elsewhere in
 * the app — and only actually calls the backend once the shared poller notices a card, so you can
 * click Send first and then place the card at your own pace. Each attempt (successful or not)
 * appends to the history list below, newest first.
 */
export function RawFrameSenderTab({
  card,
  detectionSeq,
  requestPolling,
  setPollingPaused,
}: {
  card: CardInfo | null;
  detectionSeq: number;
  requestPolling: (id: string, want: boolean) => void;
  setPollingPaused: (paused: boolean) => void;
}) {
  const [paramsHex, setParamsHex] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  // The hex locked in at the moment "Send" was clicked — the input is disabled while waiting, so
  // it can't actually change out from under this, but capturing it explicitly (instead of reading
  // `paramsHex` again inside `send`) keeps that guarantee obvious rather than assumed.
  const lockedHexRef = useRef("");
  // The detectionSeq baseline as of the last time waiting started — see the identical comment in
  // e.g. TagToolPage's `startWaiting` for why this is the current seq at that moment, not a fixed
  // sentinel like 0.
  const armedSeqRef = useRef(0);
  const busyRef = useRef(false);

  useEffect(() => {
    requestPolling("raw-frame-sender", phase === "waiting");
    return () => requestPolling("raw-frame-sender", false);
  }, [phase, requestPolling]);

  useEffect(() => {
    if (phase !== "waiting" || !card || busyRef.current) return;
    if (detectionSeq === armedSeqRef.current) return;
    armedSeqRef.current = detectionSeq;
    void send();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, card, detectionSeq]);

  // Restore the paused state too if this tab is switched away from mid-send.
  useEffect(() => {
    return () => setPollingPaused(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function send() {
    busyRef.current = true;
    setPollingPaused(true);
    setPhase("sending");
    const hex = lockedHexRef.current;
    logFrontend("info", `Sending custom InDataExchange frame: ${hex}`);
    try {
      const resp = await invoke<string>("send_raw_data_exchange", { paramsHex: hex });
      setHistory((prev) => [
        { id: nextHistoryId++, time: new Date().toLocaleTimeString(), sentHex: hex, ok: true, message: resp },
        ...prev,
      ]);
      logFrontend("info", `Custom frame response: ${resp}`);
    } catch (e) {
      setHistory((prev) => [
        { id: nextHistoryId++, time: new Date().toLocaleTimeString(), sentHex: hex, ok: false, message: String(e) },
        ...prev,
      ]);
      logFrontend("error", `Failed to send custom frame: ${String(e)}`);
    } finally {
      busyRef.current = false;
      setPollingPaused(false);
      setPhase("idle");
    }
  }

  function startWaiting() {
    const hex = paramsHex.trim();
    if (!hex) return;
    lockedHexRef.current = hex;
    armedSeqRef.current = detectionSeq;
    setPhase("waiting");
  }

  function cancelWaiting() {
    setPhase("idle");
  }

  const locked = phase !== "idle";

  return (
    <div className="raw-tab">
      <p className="raw-frame-hint">
        Send the hex bytes below verbatim as InDataExchange parameters (without the D4/40 fixed
        prefix — start from the target number), e.g. fill in <code>011BFFFFFFFF</code> to test
        PWD_AUTH, or <code>011A00</code> to test Ultralight C's AUTHENTICATE. Click Send, then
        place a card — it's sent as soon as one's detected. The complete raw frame also gets
        logged to the "Frames" tab.
      </p>
      <div className="raw-frame-row">
        <input
          className="raw-frame-input"
          placeholder="e.g. 011BFFFFFFFF"
          value={paramsHex}
          onChange={(e) => setParamsHex(e.target.value)}
          disabled={locked}
        />
        {locked ? (
          <button onClick={cancelWaiting} disabled={phase === "sending"}>
            Cancel
          </button>
        ) : (
          <button onClick={startWaiting} disabled={!paramsHex.trim()}>
            Send
          </button>
        )}
      </div>
      {phase === "waiting" && <p className="rfs-status">Waiting for a card...</p>}
      {phase === "sending" && <p className="rfs-status">Sending...</p>}

      <div className="rfs-history">
        {history.length === 0 && <div className="empty-hint">No commands sent yet</div>}
        {history.map((h) => (
          <div key={h.id} className={`rfs-history-row ${h.ok ? "ok" : "fail"}`}>
            <span className="rfs-history-time">{h.time}</span>
            <span className="rfs-history-sent">→ {h.sentHex}</span>
            <span className="rfs-history-message">{h.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
