import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { logFrontend } from "@/lib/devLog";
import { useI18n } from "@/lib/i18n";
import { cardFamily, isValidPasswordHex, type CardInfo, type PasswordProtection } from "@/lib/pn532Types";

type Action = "erase" | "format";
type Phase = "config" | "waiting" | "processing" | "done";

/**
 * Standalone "erase content" / "format tag" tool for NTAG/Ultralight cards — same shape as
 * PasswordToolPage (pick an action, arm a single-shot wait, act as soon as a card shows up), but
 * both actions here only make sense for the NTAG/Ultralight family; MIFARE Classic and anything
 * GET_VERSION can't identify are reported as unsupported rather than attempted. "Erase" clears
 * the NDEF content of an already-formatted tag (keeps its Capability Container); "Format"
 * additionally (re)writes the Capability Container itself, which is what turns a never-formatted
 * blank tag into one `write_ndef` can target — see `format_ntag`/`erase_ntag` on the Rust side
 * for the exact byte-level difference.
 */
export function TagToolPage({
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
  const [password, setPassword] = useState("");
  const [result, setResult] = useState<{ ok: boolean; message: string; uid: string } | null>(null);
  // The detectionSeq baseline as of the last time waiting started — see the comment in
  // `startWaiting` for why this is the current seq at that moment, not a fixed sentinel like 0.
  const armedSeqRef = useRef(0);
  const busyRef = useRef(false);

  useEffect(() => {
    requestPolling("tag-tool", active && phase === "waiting");
    return () => requestPolling("tag-tool", false);
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
      const message = family === "classic" ? t("tagTool.classicNotSupported") : t("tagTool.unsupportedModel");
      setResult({ ok: false, message, uid: target.uid });
      setPhase("done");
      busyRef.current = false;
      return;
    }
    setPollingPaused(true);
    try {
      let protectionInfo: PasswordProtection | null;
      try {
        protectionInfo = await invoke<PasswordProtection | null>("read_ntag_password_status");
      } catch (e) {
        setResult({ ok: false, message: `${t("write.checkFailed")}: ${String(e)}`, uid: target.uid });
        return;
      }
      let pwd: string | undefined;
      if (protectionInfo?.enabled) {
        if (!isValidPasswordHex(password)) {
          setResult({ ok: false, message: t("write.passwordRequired"), uid: target.uid });
          return;
        }
        pwd = password.trim();
      }
      if (action === "erase") {
        await invoke("erase_ntag", { expectedUid: target.uid, password: pwd });
        logFrontend("info", `${target.uid} content erased via the tag tool`);
        setResult({ ok: true, message: t("tagTool.eraseSuccess"), uid: target.uid });
      } else {
        await invoke("format_ntag", { expectedUid: target.uid, password: pwd });
        logFrontend("info", `${target.uid} formatted via the tag tool`);
        setResult({ ok: true, message: t("tagTool.formatSuccess"), uid: target.uid });
      }
    } catch (e) {
      setResult({ ok: false, message: String(e), uid: target.uid });
      logFrontend("error", `Tag tool ${action} failed: ${String(e)}`);
    } finally {
      setPollingPaused(false);
      setPhase("done");
      busyRef.current = false;
    }
  }

  function startWaiting(a: Action) {
    setAction(a);
    setResult(null);
    // Baseline = the current seq, not 0 — see the identical comment in PasswordToolPage's
    // `startWaiting` for why (stale `card`/`detectionSeq` left over from before polling was off).
    armedSeqRef.current = detectionSeq;
    setPhase("waiting");
  }

  function reset() {
    setAction(null);
    setResult(null);
    setPhase("config");
  }

  if (!connectedPort) {
    return (
      <div className="mx-auto flex max-w-lg flex-col gap-4">
        <p className="text-center text-sm text-muted-foreground">{t("readCard.connectFirst")}</p>
      </div>
    );
  }

  if (phase === "waiting") {
    return (
      <div className="mx-auto flex max-w-lg flex-col items-center gap-4">
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-center text-xs text-amber-700 dark:text-amber-400">
          {t("tagTool.warning")}
        </div>
        <p className="text-center text-sm text-muted-foreground">
          {action === "erase" ? t("tagTool.waitingToErase") : t("tagTool.waitingToFormat")}
        </p>
        <button className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted" onClick={reset}>
          {t("common.cancel")}
        </button>
      </div>
    );
  }

  if (phase === "processing") {
    return (
      <div className="mx-auto flex max-w-lg flex-col items-center gap-4">
        <p className="text-center text-sm text-muted-foreground">{t("common.processing")}</p>
      </div>
    );
  }

  if (phase === "done") {
    return (
      <div className="mx-auto flex max-w-lg flex-col items-center gap-4">
        <p className={`text-center text-sm ${result?.ok ? "text-green-600" : "text-destructive"}`}>
          {result?.message}
          {result && <span className="ml-1 font-mono text-xs text-muted-foreground">({result.uid})</span>}
        </p>
        <button
          className="rounded-md border bg-secondary px-4 py-2 text-sm font-medium hover:bg-muted"
          onClick={reset}
        >
          {t("tagTool.startOver")}
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-3">
      <p className="text-sm text-muted-foreground">{t("tagTool.intro")}</p>

      <input
        className="rounded-md border bg-background px-3 py-1.5 text-sm font-mono disabled:opacity-50"
        placeholder={t("tagTool.passwordPlaceholder")}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />

      <div className="mt-2 flex gap-2">
        <button
          className="flex-1 rounded-md border px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10"
          onClick={() => startWaiting("erase")}
        >
          {t("tagTool.eraseAndWait")}
        </button>
        <button
          className="flex-1 rounded-md border bg-secondary px-3 py-1.5 text-sm font-medium hover:bg-muted"
          onClick={() => startWaiting("format")}
        >
          {t("tagTool.formatAndWait")}
        </button>
      </div>
    </div>
  );
}
