import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { logFrontend } from "@/lib/devLog";
import { useI18n } from "@/lib/i18n";
import { cardFamily, isValidPasswordHex, type CardInfo, type PasswordProtection } from "@/lib/pn532Types";

interface CopyLogEntry {
  targetUid: string;
  ok: boolean;
  message: string;
}

/**
 * NTAG/Ultralight counterpart to `ClassicCopyFlow` — same shape (place the target card, it
 * writes automatically, swap in the next one to keep going), but copying an NDEF message instead
 * of MIFARE Classic sectors. `sourceMessageHex` is written byte-for-byte onto each target rather
 * than re-parsed into typed records, so the copy is exact regardless of record kind — see
 * `copy_ntag_card` on the Rust side. Deliberately doesn't require the target's exact chip model
 * (NTAG213/215/216/...) to match the source; only that it's some NTAG/Ultralight card with
 * enough capacity, which the backend checks.
 */
export function NtagCopyFlow({
  sourceUid,
  sourceMessageHex,
  currentCard,
  onClose,
  setPollingPaused,
}: {
  sourceUid: string;
  sourceMessageHex: string;
  currentCard: CardInfo | null;
  onClose: () => void;
  /** Pause background polling while writing, so it doesn't compete for the antenna with the
   * write. */
  setPollingPaused: (paused: boolean) => void;
}) {
  const { t } = useI18n();
  const [copying, setCopying] = useState(false);
  const [password, setPassword] = useState("");
  const [results, setResults] = useState<CopyLogEntry[]>([]);
  const [wrongType, setWrongType] = useState(false);
  // The target card UID already handled — prevents a repeat write being triggered by another
  // poll detecting the same card again before it's been taken away.
  const lastHandledUidRef = useRef<string | null>(null);

  const family = currentCard ? cardFamily(currentCard.sel_res) : null;
  const isNtag = family === "ntag";
  const isNewTarget =
    currentCard != null &&
    currentCard.uid !== sourceUid &&
    currentCard.uid !== lastHandledUidRef.current;

  // The card is already in place; as soon as it's detected, write immediately (or, for a
  // wrong-type card, just flag it) — no separate confirm click, same reasoning as
  // ClassicCopyFlow's identical effect (see the comment there re: React StrictMode's double
  // effect run in dev mode and why the actual call is deferred to a microtask).
  useEffect(() => {
    if (!isNewTarget || copying) return;
    if (!isNtag) {
      lastHandledUidRef.current = currentCard!.uid;
      setWrongType(true);
      return;
    }
    setWrongType(false);
    let cancelled = false;
    const target = currentCard!;
    queueMicrotask(() => {
      if (!cancelled) void handleCopy(target);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNewTarget, isNtag, currentCard?.uid]);

  // Restore the paused state too if the user navigates away mid-write (e.g. clicks "done").
  useEffect(() => {
    return () => setPollingPaused(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleCopy(target: CardInfo) {
    lastHandledUidRef.current = target.uid;
    setPollingPaused(true);
    setCopying(true);
    logFrontend("info", `Copying ${sourceUid} -> ${target.uid}`);
    try {
      let protectionInfo: PasswordProtection | null;
      try {
        protectionInfo = await invoke<PasswordProtection | null>("read_ntag_password_status");
      } catch (e) {
        setResults((prev) => [
          { targetUid: target.uid, ok: false, message: `${t("write.checkFailed")}: ${String(e)}` },
          ...prev,
        ]);
        return;
      }
      let pwd: string | undefined;
      if (protectionInfo?.enabled) {
        if (!isValidPasswordHex(password)) {
          setResults((prev) => [
            { targetUid: target.uid, ok: false, message: t("write.passwordRequired") },
            ...prev,
          ]);
          return;
        }
        pwd = password.trim();
      }
      await invoke("copy_ntag_card", {
        sourceUid,
        sourceMessageHex,
        password: pwd,
      });
      setResults((prev) => [{ targetUid: target.uid, ok: true, message: t("ntagCopy.copySucceeded") }, ...prev]);
      logFrontend("info", `Copy to ${target.uid} succeeded`);
    } catch (e) {
      setResults((prev) => [{ targetUid: target.uid, ok: false, message: String(e) }, ...prev]);
      logFrontend("error", `Copy to ${target.uid} failed: ${String(e)}`);
    } finally {
      setCopying(false);
      setPollingPaused(false);
    }
  }

  const latest = results[0];

  return (
    <div className="rounded-md border p-4">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-sm font-medium">
          {t("ntagCopy.title")}
          {results.length > 0 && t("ntagCopy.completedCount", { count: results.length })}
        </p>
        <button className="text-xs text-muted-foreground hover:underline" onClick={onClose}>
          {t("ntagCopy.done")}
        </button>
      </div>

      <input
        className="mb-2 w-full rounded-md border bg-background px-3 py-1.5 text-sm font-mono disabled:opacity-50"
        placeholder={t("ntagCopy.passwordPlaceholder")}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        disabled={copying}
      />

      <p className="text-sm text-muted-foreground">
        {copying
          ? t("ntagCopy.writing")
          : currentCard?.uid === sourceUid
            ? t("ntagCopy.stillSourceCard")
            : wrongType
              ? t("ntagCopy.wrongCardType")
              : t("ntagCopy.placeTargetCard")}
      </p>

      {latest && (
        <div className="mt-3 flex flex-col gap-1 border-t pt-3 text-sm">
          <p>
            {t("ntagCopy.lastTargetCard")}
            <span className="font-mono">{latest.targetUid}</span>
          </p>
          <p className={latest.ok ? "text-green-600" : "text-destructive"}>{latest.message}</p>
        </div>
      )}
    </div>
  );
}
