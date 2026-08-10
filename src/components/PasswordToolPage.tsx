import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { logFrontend } from "@/lib/devLog";
import { useI18n } from "@/lib/i18n";
import { cardFamily, isValidPasswordHex, textToHexPassword, type CardInfo } from "@/lib/pn532Types";
import { Switch } from "@/components/ui/switch";

type Action = "set" | "clear";
// idle: config is being edited, nothing waiting — same shape as WritePage's phases, so a batch
// of cards can be worked through the same way (arm once, keep acting on every new card until
// stopped) instead of needing an explicit "start over" click after each one.
type Phase = "idle" | "waiting";
type PwMode = "text" | "hex";

interface PwdLogEntry {
  id: number;
  uid: string;
  ok: boolean;
  message: string;
  time: string;
}

let nextLogId = 1;

const inputClass =
  "rounded-md border bg-background px-3 py-1.5 text-sm font-mono disabled:opacity-50";

/**
 * A quick, standalone way to set or remove NTAG/Ultralight write-password protection without
 * first doing a full card read — this is the only password management UI in the app (the read
 * page used to have its own embedded version, but that duplicated this and needed a full dump
 * first just to get started, so it was removed in favor of this one). Picks the password up
 * front, then arms a wait for a card: as soon as one shows up, `set_ntag_password`/
 * `clear_ntag_password` are called directly. In continuous mode it stays armed afterward,
 * acting on every new card placed until stopped — same "swap card, keep going" shape as
 * `WritePage`'s continuous mode. Both password commands already check the card is
 * Ultralight/NTAG family and that its exact model can be identified via GET_VERSION before
 * touching anything (see `select_ntag_for_password_op` in session.rs) — no need to duplicate
 * that check here, an unsupported card just surfaces as a normal error.
 */
export function PasswordToolPage({
  connectedPort,
  card,
  detectionSeq,
  active,
  setPollingPaused,
  requestPolling,
}: {
  connectedPort: string | null;
  card: CardInfo | null;
  detectionSeq: number;
  active: boolean;
  setPollingPaused: (paused: boolean) => void;
  requestPolling: (id: string, want: boolean) => void;
}) {
  const { t } = useI18n();
  const [action, setAction] = useState<Action | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [pwMode, setPwMode] = useState<PwMode>("text");
  const [pwInput, setPwInput] = useState("");
  const [continuous, setContinuous] = useState(false);
  const [busyUid, setBusyUid] = useState<string | null>(null);
  const [log, setLog] = useState<PwdLogEntry[]>([]);
  // The detectionSeq baseline as of the last time waiting (re)started — see the comment in
  // `startWaiting` for why this is the current seq at that moment, not a fixed sentinel like 0.
  const armedSeqRef = useRef(0);
  const busyRef = useRef(false);

  const hexPassword = pwMode === "hex" ? pwInput.trim().toUpperCase() : textToHexPassword(pwInput);
  const hexValid = pwMode === "hex" ? isValidPasswordHex(hexPassword) : pwInput.length > 0;

  useEffect(() => {
    requestPolling("password-tool", active && phase === "waiting");
    return () => requestPolling("password-tool", false);
  }, [active, phase, requestPolling]);

  useEffect(() => {
    if (phase !== "waiting" || !card || busyRef.current) return;
    if (detectionSeq === armedSeqRef.current) return;
    armedSeqRef.current = detectionSeq;
    void process(card);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, card, detectionSeq]);

  // A disconnect mid-wait has nothing left to operate on; go back to editing instead of leaving
  // the UI stuck waiting for a card that can never show up.
  useEffect(() => {
    if (!connectedPort) setPhase("idle");
  }, [connectedPort]);

  function appendLog(uid: string, ok: boolean, message: string) {
    setLog((prev) =>
      [{ id: nextLogId++, uid, ok, message, time: new Date().toLocaleTimeString() }, ...prev].slice(
        0,
        100,
      ),
    );
  }

  async function process(target: CardInfo) {
    busyRef.current = true;
    setBusyUid(target.uid);
    try {
      const family = cardFamily(target.sel_res);
      if (family !== "ntag") {
        appendLog(
          target.uid,
          false,
          family === "classic" ? t("pwdTool.classicNotSupported") : t("pwdTool.unsupportedModel"),
        );
        return;
      }
      setPollingPaused(true);
      try {
        if (action === "set") {
          await invoke("set_ntag_password", {
            expectedUid: target.uid,
            currentPassword: null,
            newPassword: hexPassword,
          });
          logFrontend("info", `${target.uid} password set via the quick password tool`);
          appendLog(target.uid, true, t("pwdTool.setSuccess"));
        } else {
          await invoke("clear_ntag_password", {
            expectedUid: target.uid,
            currentPassword: hexPassword,
          });
          logFrontend("info", `${target.uid} password removed via the quick password tool`);
          appendLog(target.uid, true, t("pwdTool.clearSuccess"));
        }
      } finally {
        setPollingPaused(false);
      }
    } catch (e) {
      appendLog(target.uid, false, String(e));
      logFrontend("error", `Quick password tool failed: ${String(e)}`);
    } finally {
      busyRef.current = false;
      setBusyUid(null);
      if (!continuous) setPhase("idle");
    }
  }

  function startWaiting(a: Action) {
    if (!hexValid) return;
    setAction(a);
    // Baseline = the current seq, not 0 — `card`/`detectionSeq` can be stale left over from
    // before polling was off (e.g. a previous attempt dropped back to idle, and the card was
    // then removed with nobody polling to notice), so trusting them directly here risked
    // immediately acting on a card that isn't there anymore. The poller resets its own presence
    // tracking on resume (see `usePn532Connection`), guaranteeing the first tick after this is a
    // fresh, trustworthy check — including correctly noticing a card that's been sitting there
    // the whole time.
    armedSeqRef.current = detectionSeq;
    setPhase("waiting");
  }

  function stopWaiting() {
    setPhase("idle");
  }

  if (!connectedPort) {
    return (
      <div className="mx-auto flex max-w-lg flex-col gap-4">
        <p className="text-center text-sm text-muted-foreground">{t("readCard.connectFirst")}</p>
      </div>
    );
  }

  const locked = phase === "waiting";

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-3">
      {phase === "waiting" && (
        <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-1.5 text-sm">
          <span className="flex-1 text-muted-foreground">
            {busyUid
              ? t("pwdTool.processingUid", { uid: busyUid })
              : action === "set"
                ? t("pwdTool.waitingToSet")
                : t("pwdTool.waitingToClear")}
          </span>
          <button className="rounded-md border px-2.5 py-1 text-xs hover:bg-muted" onClick={stopWaiting}>
            {continuous ? t("pwdTool.stop") : t("common.cancel")}
          </button>
        </div>
      )}

      <p className="text-sm text-muted-foreground">{t("pwdTool.intro")}</p>

      <div className="flex gap-2">
        <button
          className={`rounded-md border px-3 py-1.5 text-sm disabled:opacity-50 ${pwMode === "text" ? "bg-accent font-medium" : "hover:bg-muted"}`}
          onClick={() => setPwMode("text")}
          disabled={locked}
        >
          {t("pwdTool.modeText")}
        </button>
        <button
          className={`rounded-md border px-3 py-1.5 text-sm disabled:opacity-50 ${pwMode === "hex" ? "bg-accent font-medium" : "hover:bg-muted"}`}
          onClick={() => setPwMode("hex")}
          disabled={locked}
        >
          {t("pwdTool.modeHex")}
        </button>
      </div>

      <input
        className={inputClass}
        placeholder={pwMode === "text" ? t("pwdTool.textPlaceholder") : t("pwdTool.hexPlaceholder")}
        value={pwInput}
        onChange={(e) => setPwInput(e.target.value)}
        disabled={locked}
        autoFocus
      />

      <p className="text-xs text-muted-foreground">
        {t("pwdTool.previewLabel")}: <span className="font-mono">{hexValid ? hexPassword : "—"}</span>
      </p>
      {pwMode === "text" && <p className="text-xs text-muted-foreground">{t("pwdTool.truncateHint")}</p>}

      {/* A settings toggle, not an action button — flipping it doesn't do anything by itself, it
          only decides whether the buttons below re-arm for the next card instead of stopping
          after one. */}
      <label className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
        <span className="flex flex-col">
          <span className="text-sm font-medium">
            {continuous ? t("pwdTool.modeContinuous") : t("pwdTool.modeSingle")}
          </span>
          <span className="text-xs text-muted-foreground">{t("pwdTool.modeLabel")}</span>
        </span>
        <Switch checked={continuous} onCheckedChange={setContinuous} disabled={locked} />
      </label>

      {phase === "idle" && (
        <div className="flex gap-2">
          <button
            className="flex-1 rounded-md border bg-secondary px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-50"
            onClick={() => startWaiting("set")}
            disabled={!hexValid}
          >
            {t("pwdTool.setAndWait")}
          </button>
          <button
            className="flex-1 rounded-md border px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10 disabled:opacity-50"
            onClick={() => startWaiting("clear")}
            disabled={!hexValid}
          >
            {t("pwdTool.clearAndWait")}
          </button>
        </div>
      )}

      {log.length > 0 && (
        <div className="flex flex-col gap-1 rounded-md border p-2 text-xs">
          <div className="flex items-center justify-between px-1 pb-1 text-muted-foreground">
            <span>
              {t("pwdTool.successCount", { count: log.filter((e) => e.ok).length })}
              {" · "}
              {t("pwdTool.errorCount", { count: log.filter((e) => !e.ok).length })}
            </span>
            <button className="hover:underline" onClick={() => setLog([])}>
              {t("pwdTool.clearLog")}
            </button>
          </div>
          <div className="flex max-h-56 flex-col gap-1 overflow-auto">
            {log.map((entry) => (
              <div
                key={entry.id}
                className={`flex items-center gap-2 rounded px-1.5 py-1 ${
                  entry.ok ? "text-green-600" : "text-destructive"
                }`}
              >
                <span className="font-mono">{entry.uid}</span>
                <span className="flex-1">{entry.message}</span>
                <span className="text-muted-foreground">{entry.time}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
