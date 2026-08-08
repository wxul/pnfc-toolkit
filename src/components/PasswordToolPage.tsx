import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { logFrontend } from "@/lib/devLog";
import { useI18n } from "@/lib/i18n";
import { cardFamily, isValidPasswordHex, type CardInfo } from "@/lib/pn532Types";

type Action = "set" | "clear";
type Phase = "config" | "waiting" | "processing" | "done";
type PwMode = "text" | "hex";

const inputClass =
  "rounded-md border bg-background px-3 py-1.5 text-sm font-mono disabled:opacity-50";

/** UTF-8 encodes the text, then truncates to the first 4 bytes (or zero-pads up to 4 if
 * shorter) — NTAG's write password is always exactly 4 bytes, there's no other way to fit an
 * arbitrary text password into it. */
function textToHexPassword(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const padded = new Uint8Array(4);
  padded.set(bytes.subarray(0, 4));
  return Array.from(padded)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

/**
 * A quick, standalone way to set or remove NTAG/Ultralight write-password protection without
 * first doing a full card read — this is the only password management UI in the app (the read
 * page used to have its own embedded version, but that duplicated this and needed a full dump
 * first just to get started, so it was removed in favor of this one). Picks the password up
 * front, then arms a single-shot wait for a card: as soon as one shows up,
 * `set_ntag_password`/`clear_ntag_password` are called directly. Both of those already check the
 * card is Ultralight/NTAG family and that its exact model can be identified via GET_VERSION
 * before touching anything (see `select_ntag_for_password_op` in session.rs) — no need to
 * duplicate that check here, an unsupported card just surfaces as a normal error.
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
  const [phase, setPhase] = useState<Phase>("config");
  const [pwMode, setPwMode] = useState<PwMode>("text");
  const [pwInput, setPwInput] = useState("");
  const [result, setResult] = useState<{ ok: boolean; message: string; uid: string } | null>(null);
  // The detectionSeq baseline as of the last time waiting started — see the comment in
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

  // A disconnect mid-wait has nothing left to operate on; go back to the config screen instead
  // of leaving the UI stuck waiting for a card that can never show up.
  useEffect(() => {
    if (!connectedPort) reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectedPort]);

  async function process(target: CardInfo) {
    busyRef.current = true;
    setPhase("processing");
    const family = cardFamily(target.sel_res);
    if (family !== "ntag") {
      const message = family === "classic" ? t("pwdTool.classicNotSupported") : t("pwdTool.unsupportedModel");
      setResult({ ok: false, message, uid: target.uid });
      setPhase("done");
      busyRef.current = false;
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
        setResult({ ok: true, message: t("pwdTool.setSuccess"), uid: target.uid });
      } else {
        await invoke("clear_ntag_password", {
          expectedUid: target.uid,
          currentPassword: hexPassword,
        });
        logFrontend("info", `${target.uid} password removed via the quick password tool`);
        setResult({ ok: true, message: t("pwdTool.clearSuccess"), uid: target.uid });
      }
    } catch (e) {
      setResult({ ok: false, message: String(e), uid: target.uid });
      logFrontend("error", `Quick password tool failed: ${String(e)}`);
    } finally {
      setPollingPaused(false);
      setPhase("done");
      busyRef.current = false;
    }
  }

  function startWaiting(a: Action) {
    if (!hexValid) return;
    setAction(a);
    setResult(null);
    // Baseline = the current seq, not 0 — `card`/`detectionSeq` can be stale left over from
    // before polling was off (e.g. a previous attempt dropped back to config, and the card was
    // then removed with nobody polling to notice), so trusting them directly here risked
    // immediately acting on a card that isn't there anymore. The poller resets its own presence
    // tracking on resume (see `usePn532Connection`), guaranteeing the first tick after this is a
    // fresh, trustworthy check — including correctly noticing a card that's been sitting there
    // the whole time.
    armedSeqRef.current = detectionSeq;
    setPhase("waiting");
  }

  function reset() {
    setAction(null);
    setResult(null);
    setPwInput("");
    setPhase("config");
  }

  if (!connectedPort) {
    return (
      <div className="mx-auto flex max-w-lg flex-col gap-4 pt-8">
        <p className="text-center text-sm text-muted-foreground">{t("readCard.connectFirst")}</p>
      </div>
    );
  }

  if (phase === "waiting") {
    return (
      <div className="mx-auto flex max-w-lg flex-col items-center gap-4 pt-8">
        <p className="text-center text-sm text-muted-foreground">
          {action === "set" ? t("pwdTool.waitingToSet") : t("pwdTool.waitingToClear")}
        </p>
        <button className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted" onClick={reset}>
          {t("common.cancel")}
        </button>
      </div>
    );
  }

  if (phase === "processing") {
    return (
      <div className="mx-auto flex max-w-lg flex-col items-center gap-4 pt-8">
        <p className="text-center text-sm text-muted-foreground">{t("common.processing")}</p>
      </div>
    );
  }

  if (phase === "done") {
    return (
      <div className="mx-auto flex max-w-lg flex-col items-center gap-4 pt-8">
        <p className={`text-center text-sm ${result?.ok ? "text-green-600" : "text-destructive"}`}>
          {result?.message}
          {result && <span className="ml-1 font-mono text-xs text-muted-foreground">({result.uid})</span>}
        </p>
        <button
          className="rounded-md border bg-secondary px-4 py-2 text-sm font-medium hover:bg-muted"
          onClick={reset}
        >
          {t("pwdTool.startOver")}
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-3 pt-8">
      <p className="text-sm text-muted-foreground">{t("pwdTool.intro")}</p>

      <div className="flex gap-2">
        <button
          className={`rounded-md border px-3 py-1.5 text-sm ${pwMode === "text" ? "bg-accent font-medium" : "hover:bg-muted"}`}
          onClick={() => setPwMode("text")}
        >
          {t("pwdTool.modeText")}
        </button>
        <button
          className={`rounded-md border px-3 py-1.5 text-sm ${pwMode === "hex" ? "bg-accent font-medium" : "hover:bg-muted"}`}
          onClick={() => setPwMode("hex")}
        >
          {t("pwdTool.modeHex")}
        </button>
      </div>

      <input
        className={inputClass}
        placeholder={pwMode === "text" ? t("pwdTool.textPlaceholder") : t("pwdTool.hexPlaceholder")}
        value={pwInput}
        onChange={(e) => setPwInput(e.target.value)}
        autoFocus
      />

      <p className="text-xs text-muted-foreground">
        {t("pwdTool.previewLabel")}: <span className="font-mono">{hexValid ? hexPassword : "—"}</span>
      </p>
      {pwMode === "text" && <p className="text-xs text-muted-foreground">{t("pwdTool.truncateHint")}</p>}

      <div className="mt-2 flex gap-2">
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
    </div>
  );
}
